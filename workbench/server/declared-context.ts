// The declared context a Builder is given, compiled by the Control Plane rather than read by the Builder's wrapper.
// Every file comes from the Run's base revision, not from the worktree: a revision Run starts from the previous head,
// where the last Builder may have rewritten a rules file that no reviewer has approved yet. The prompt budget is
// counted in UTF-8 bytes and a cut never splits a character, and what was cut is recorded, so the reconciliation shows
// exactly what the Builder was given.
import { execFileSync } from 'node:child_process'
import { sha256 } from './security.ts'
import { AppError } from './types.ts'
import { GIT_NO_EXEC } from './worktree-git.ts'

/** What the Builder's prompt carries of all declared context together. */
export const CONTEXT_PROMPT_BUDGET_BYTES = 200_000

export type DeclaredContextEntry = {
  path: string
  required: boolean
  /** Of the whole file at the base revision. */
  fileBytes: number
  fileDigest: string
  /** Of the part the prompt carries; equal to the file's when nothing was cut. */
  injectedBytes: number
  injectedDigest: string
  /** Byte offset the content was cut at, or null when the whole file is carried. */
  truncatedAt: number | null
  content: string
}

export type DeclaredContextOmission = { path: string; required: boolean; reason: 'missing' | 'budget' }

export type CompiledDeclaredContext = { baseSha: string; budgetBytes: number; entries: DeclaredContextEntry[]; omitted: DeclaredContextOmission[] }

/** At most `limit` bytes of `buffer`, ending on a UTF-8 character boundary. */
export function utf8Prefix(buffer: Buffer, limit: number) {
  let end = Math.min(Math.max(0, limit), buffer.length)
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end)
}

function blob(repositoryPath: string, baseSha: string, path: string) {
  try {
    if (execFileSync('git', [...GIT_NO_EXEC, '-C', repositoryPath, 'cat-file', '-t', `${baseSha}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== 'blob') return undefined
    return execFileSync('git', [...GIT_NO_EXEC, '-C', repositoryPath, 'show', `${baseSha}:${path}`], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return undefined
  }
}

/**
 * Required paths first, then the rest in declaration order. A required file that is missing at the base revision, or
 * required files that do not fit the budget together, refuse the Run: the Builder would silently work without rules
 * the project said it must follow. An optional file is cut to what is left of the budget, or left out when nothing is.
 */
export function compileDeclaredContext(repositoryPath: string, baseSha: string, paths: string[], requiredPaths: string[], budgetBytes = CONTEXT_PROMPT_BUDGET_BYTES): CompiledDeclaredContext {
  const required = new Set(requiredPaths)
  const ordered = [...paths.filter((path) => required.has(path)), ...paths.filter((path) => !required.has(path))]
  const contents = new Map(ordered.map((path) => [path, blob(repositoryPath, baseSha, path)]))
  const missingRequired = ordered.filter((path) => required.has(path) && !contents.get(path))
  if (missingRequired.length) throw new AppError(422, `Required context is missing at ${baseSha.slice(0, 12)}: ${missingRequired.join(', ')}`, 'required_context_missing')
  const requiredBytes = ordered.filter((path) => required.has(path)).reduce((total, path) => total + contents.get(path)!.length, 0)
  if (requiredBytes > budgetBytes) throw new AppError(422, `Required context is ${requiredBytes} bytes, over the ${budgetBytes} byte prompt budget; move files from context.required to context.allowed or shorten them`, 'required_context_over_budget')

  const entries: DeclaredContextEntry[] = []
  const omitted: DeclaredContextOmission[] = []
  let used = 0
  for (const path of ordered) {
    const content = contents.get(path)
    if (!content) {
      omitted.push({ path, required: false, reason: 'missing' })
      continue
    }
    const injected = utf8Prefix(content, budgetBytes - used)
    if (!injected.length && content.length) {
      omitted.push({ path, required: required.has(path), reason: 'budget' })
      continue
    }
    used += injected.length
    entries.push({ path, required: required.has(path), fileBytes: content.length, fileDigest: `sha256:${sha256(content)}`, injectedBytes: injected.length, injectedDigest: `sha256:${sha256(injected)}`, truncatedAt: injected.length < content.length ? injected.length : null, content: injected.toString('utf8') })
  }
  return { baseSha, budgetBytes, entries, omitted }
}

/** The compiled context without the file contents, as it is recorded in events. */
export function declaredContextSummary(compiled: CompiledDeclaredContext) {
  return { baseSha: compiled.baseSha, budgetBytes: compiled.budgetBytes, entries: compiled.entries.map(({ content: _content, ...entry }) => entry), omitted: compiled.omitted }
}
