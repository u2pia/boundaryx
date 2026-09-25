// A Run's Git worktree exists for exactly one reason: the agent writes a change in it. Everything that
// outlives the run — the branch carrying the proposal's Head SHA, the managed clone, the Evidence Package —
// lives in the shared repository, not in the checkout. Leaving the checkout behind buys nothing and costs a
// full copy of the repository per run, which is why run directories grew without bound. This module removes a
// finished run's checkout and prunes the administrative entry that points at it, and nothing else: branch,
// evidence and clone are untouched.
import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve, sep } from 'node:path'

export type PruneOutcome = { removed: boolean; skipped: string[]; error?: string }

function git(repositoryPath: string, args: string[]) {
  return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** The directory a run owns: `<worktreeRoot>/<runId>`, i.e. the parent of the checkout. */
export function runRootFor(worktreePath: string, worktreeRoot?: string) {
  const parent = dirname(resolve(worktreePath))
  if (!worktreeRoot) return parent
  const root = resolve(worktreeRoot)
  // The checkout always sits directly below the run directory, so a parent that is not below the run root at
  // all is not this Run's metadata directory and must not anchor a recursive removal.
  return parent.startsWith(`${root}${sep}`) ? parent : root
}

type Ownership = 'registered' | 'prune_only' | false

/**
 * Git reports worktree paths with symlinks resolved (`/private/var/...` on macOS) while the run records the
 * path it was given (`/var/...`), so both sides are compared in canonical form. A checkout that is already gone
 * is canonicalised through its parent.
 */
function canonical(path: string) {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute))
    } catch {
      return absolute
    }
  }
}

/**
 * The checkout at `worktreePath` is removed only when Git still reports it as a worktree of
 * `repositoryPath` at that path, or when the path no longer exists but an administrative entry does.
 * Anything else — a path Git does not know at all, or one a human re-registered to another repository — is
 * left alone and reported instead.
 */
function worktreeOwnership(repositoryPath: string, worktreePath: string): Ownership {
  const target = canonical(worktreePath)
  try {
    for (const block of git(repositoryPath, ['worktree', 'list', '--porcelain']).split('\n\n')) {
      const lines = block.split('\n')
      const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
      if (!path || canonical(path) !== target) continue
      if (lines.includes('prunable')) return 'prune_only'
      return existsSync(target) ? 'registered' : 'prune_only'
    }
  } catch {
    return false
  }
  // Not listed at all: somebody removed the checkout by hand and only the administrative entry is left.
  return existsSync(target) ? false : 'prune_only'
}

/** Recursive removal without a shell, so no path is ever interpreted by one. */
function removeDirectory(path: string) {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // Reported by the caller through the existence check; a cleanup failure is never an error path.
  }
}

const PRESERVED_RUN_FILES = new Set(['uncommitted.patch'])

function removeRunDirectory(runRoot: string) {
  if (!existsSync(runRoot)) return
  let entries: string[] = []
  try {
    entries = readdirSync(runRoot)
  } catch {
    return
  }
  const kept = entries.filter((entry) => PRESERVED_RUN_FILES.has(entry))
  if (kept.length === 0) return removeDirectory(runRoot)
  for (const entry of entries) if (!kept.includes(entry)) removeDirectory(join(runRoot, entry))
}

/**
 * Removes the run's checkout, prunes the administrative entry and then removes the run's own directory
 * (which also held `request.json`). Returns `removed: false` when the path was not this run's worktree, so
 * the caller records a fact rather than claiming a success. Never throws: a failed cleanup must not change
 * the run's conclusion.
 */
export function removeRunWorktree(input: { repositoryPath: string; worktreePath: string; runRoot: string }): PruneOutcome {
  const ownership = worktreeOwnership(input.repositoryPath, input.worktreePath)
  if (ownership === false) return { removed: false, skipped: [input.worktreePath], error: 'worktree_not_owned_by_run' }
  try {
    // `--force` is required because the run's checkout is deliberately not clean: the postprocessor leaves the
    // committed Head in the tree and may leave build outputs behind.
    if (ownership === 'registered') git(input.repositoryPath, ['worktree', 'remove', '--force', input.worktreePath])
    // Purging immediately instead of waiting out `gc.worktreePruneExpire` is what keeps the administrative
    // entry from outliving the worktree. `prune` only drops entries whose checkout no longer exists and deletes
    // nothing on disk, so an unrelated dirty or locked worktree of the same repository is unaffected. It takes
    // no pathspec.
    git(input.repositoryPath, ['worktree', 'prune', '--expire', 'now'])
    if (existsSync(input.worktreePath)) removeDirectory(input.worktreePath)
    if (existsSync(input.worktreePath)) return { removed: false, skipped: [input.worktreePath], error: 'worktree_path_still_present' }
    // Only now, with the checkout gone, is this Run's own directory removed — except the unfinished work a
    // failed run left behind, which the failure diagnostic event points at.
    removeRunDirectory(input.runRoot)
    return { removed: true, skipped: [] }
  } catch (error) {
    const present = existsSync(input.worktreePath)
    return { removed: !present, skipped: present ? [input.worktreePath] : [], error: error instanceof Error ? error.message : String(error) }
  }
}
