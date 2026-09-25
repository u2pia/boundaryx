import { existsSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { sha256 } from './security.ts'

/**
 * macOS Seatbelt (`sandbox-exec`), the one process confinement available to a local Control Plane without a container
 * engine. It is used in two places: the code under evaluation runs with the hidden dataset, the grader and the Control
 * Plane's files unreadable and no network; and, when an operator opts in, the Builder runs with the holdouts, the seal
 * key and the database unreadable. A sandboxed process cannot apply a sandbox of its own, so a Builder that sandboxes
 * its own commands (the Codex CLI does) cannot be confined this way.
 */
export const SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec'

export function seatbeltAvailable(env: NodeJS.ProcessEnv = process.env) {
  return process.platform === 'darwin' && env.CONTROL_PLANE_SANDBOX !== 'off' && existsSync(SANDBOX_EXECUTABLE)
}

/** Seatbelt matches the resolved path (`/tmp` is `/private/tmp`), so every path is resolved, through its parent when it does not exist yet. */
function canonical(path: string): string {
  const absolute = resolve(path)
  if (existsSync(absolute)) return realpathSync(absolute)
  const parent = dirname(absolute)
  return parent === absolute ? absolute : resolve(canonical(parent), absolute.slice(parent.length + 1))
}

const quote = (path: string) => JSON.stringify(canonical(path))

export type SeatbeltPolicy = {
  /** Neither readable nor writable, including everything beneath. */
  denied: string[]
  /** Re-allowed beneath a denied path: later rules win in Seatbelt. Their ancestors up to the denied path become listable. */
  allowed?: string[]
  /** When set, writes are refused everywhere except beneath these paths (and /dev). */
  writableOnly?: string[]
  denyNetwork?: boolean
}

export function seatbeltProfile(policy: SeatbeltPolicy) {
  const lines = ['(version 1)', '(allow default)']
  if (policy.denyNetwork) lines.push('(deny network*)')
  if (policy.writableOnly) lines.push(`(deny file-write* (require-not (require-any ${[...policy.writableOnly.map((path) => `(subpath ${quote(path)})`), '(subpath "/dev")'].join(' ')})))`)
  for (const path of policy.denied) lines.push(`(deny file-read* file-write* (subpath ${quote(path)}))`)
  // A process working beneath a denied directory still has to resolve its own path (realpath, getcwd), which reads each
  // ancestor directory. Those directories alone are readable, not what is in them: their entry names become visible,
  // no other file's content does.
  const denied = policy.denied.map(canonical)
  const ancestors = new Set<string>()
  for (const path of (policy.allowed ?? []).map(canonical)) {
    for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) if (denied.some((root) => parent === root || parent.startsWith(`${root}/`))) ancestors.add(parent)
  }
  if (ancestors.size) lines.push(`(allow file-read* ${[...ancestors].sort().map((path) => `(literal ${JSON.stringify(path)})`).join(' ')})`)
  for (const path of policy.allowed ?? []) lines.push(`(allow file-read* file-write* (subpath ${quote(path)}))`)
  return lines.join('\n')
}

export function seatbeltCommand(policy: SeatbeltPolicy, executable: string, args: string[]) {
  const profile = seatbeltProfile(policy)
  return { executable: SANDBOX_EXECUTABLE, args: ['-p', profile, executable, ...args], profileDigest: `sha256:${sha256(profile)}` }
}
