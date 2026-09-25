// A Run's Git worktree exists for exactly one reason: the agent writes a change in it. Everything that
// outlives the run — the branch carrying the proposal's Head SHA, the managed clone, the Evidence Package —
// lives in the shared repository, not in the checkout. Leaving the checkout behind buys nothing and costs a
// full copy of the repository per run, which is why run directories grew without bound. This module removes a
// finished run's checkout and prunes the administrative entry that points at it, and nothing else: branch,
// evidence and clone are untouched.
import { existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve, sep } from 'node:path'

export type PruneOutcome = { removed: boolean; skipped: string[]; error?: string }

/**
 * `git worktree prune` only ever visits the entries under `<repository>/.git/worktrees` — exactly the
 * worktrees of *this* repository — and deletes nothing on disk. The pathspec keeps it to the run's own
 * entry, so a repository that simultaneously hosts an unrelated dirty or locked worktree is unaffected.
 */
const PRUNE_PATHS = ['worktrees']

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
 * The checkout at `worktreePath` is removed only when Git still reports it as a worktree of
 * `repositoryPath` at that path, or when the path no longer exists but an administrative entry does.
 * Anything else — a path Git does not know at all, or one a human re-registered to another repository — is
 * left alone and reported instead.
 */
function worktreeOwnership(repositoryPath: string, worktreePath: string): Ownership {
  const target = resolve(worktreePath)
  try {
    for (const block of git(repositoryPath, ['worktree', 'list', '--porcelain']).split('\n\n')) {
      const lines = block.split('\n')
      const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
      if (!path || resolve(path) !== target) continue
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
    // entry from outliving the worktree; `--expire now` still only touches entries that are already prunable.
    git(input.repositoryPath, ['worktree', 'prune', '--expire', 'now', '--', ...PRUNE_PATHS])
    if (existsSync(input.worktreePath)) removeDirectory(input.worktreePath)
    if (existsSync(input.worktreePath)) return { removed: false, skipped: [input.worktreePath], error: 'worktree_path_still_present' }
    // Only now, with the checkout gone, is this Run's own directory removed.
    removeDirectory(input.runRoot)
    return { removed: true, skipped: [] }
  } catch (error) {
    const present = existsSync(input.worktreePath)
    return { removed: !present, skipped: present ? [input.worktreePath] : [], error: error instanceof Error ? error.message : String(error) }
  }
}
