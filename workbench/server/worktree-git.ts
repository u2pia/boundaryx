// A Run's worktree is where code the Control Plane did not write runs: the Builder, and the head revision's checks.
// Anything there can plant a hook, an fsmonitor command, a filter or a credential helper for Git to execute, or point
// the worktree's `.git` file at a Git directory of its own. The Control Plane's own Git commands run with the GitHub
// token and the data directory at hand, so none of them may execute what a repository's config names, and those on a
// worktree take the Git directory from the repository the Control Plane owns, never from the worktree.
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { AppError } from './types.ts'

/** Prepended to every Control Plane Git command: no hook and no fsmonitor command runs, whatever a config says. */
export const GIT_NO_EXEC = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']

/** Where a Run's worktree keeps its Git state, as the repository records it. */
export type WorktreeGit = { worktreePath: string; gitDirectory: string; commonDirectory: string }

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
 * The administrative directory (`<common>/worktrees/<name>`) whose `gitdir` points at `worktreePath`, found through
 * `repositoryPath`. Both live under the repository's Git directory, which the Builder and the checks can read but not
 * write, so a rewritten `.git` file in the worktree changes nothing here.
 */
export function worktreeGitDirectories(repositoryPath: string, worktreePath: string): WorktreeGit {
  const commonDirectory = canonical(resolve(repositoryPath, execFileSync('git', [...GIT_NO_EXEC, '-C', repositoryPath, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()))
  const expected = canonical(join(worktreePath, '.git'))
  const administrative = join(commonDirectory, 'worktrees')
  for (const name of existsSync(administrative) ? readdirSync(administrative) : []) {
    const gitdirFile = join(administrative, name, 'gitdir')
    if (existsSync(gitdirFile) && canonical(readFileSync(gitdirFile, 'utf8').trim()) === expected) return { worktreePath: resolve(worktreePath), gitDirectory: join(administrative, name), commonDirectory }
  }
  throw new AppError(409, `${worktreePath} is not a registered worktree of ${repositoryPath}`, 'worktree_not_registered')
}

/**
 * The environment of a Control Plane Git command on a worktree: no token or other server secret, and no global or
 * system config, which a process writing to `$HOME` could have changed. `GIT_COMMON_DIR` stands in for the `commondir`
 * file in the worktree's administrative directory, which the Builder could rewrite to point at a config of its own.
 * The identity commits carry is set in the repository's config when the worktree is created.
 */
export function worktreeGitEnvironment(worktree: WorktreeGit): NodeJS.ProcessEnv {
  const kept = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']
  return { ...Object.fromEntries(kept.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])), GIT_COMMON_DIR: worktree.commonDirectory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
}

/** Arguments for `git` on a worktree that ignore its `.git` file. Run with `cwd` set to the worktree, so pathspecs resolve inside it. */
export function worktreeGitArgs(worktree: WorktreeGit, args: string[]) {
  return [...GIT_NO_EXEC, '--git-dir', worktree.gitDirectory, '--work-tree', worktree.worktreePath, ...args]
}

export function worktreeGitOptions<T extends ExecFileSyncOptions>(worktree: WorktreeGit, options: T): T {
  return { ...options, cwd: worktree.worktreePath, env: worktreeGitEnvironment(worktree) }
}

/**
 * Git updates a worktree's refs through the `commondir` file whatever `GIT_COMMON_DIR` says, so a rewritten one is
 * refused rather than followed. Only an unconfined process can rewrite it: the sandbox keeps the Git directory read-only.
 */
export function assertWorktreeGitIntact(worktree: WorktreeGit) {
  let recorded = ''
  try {
    recorded = readFileSync(join(worktree.gitDirectory, 'commondir'), 'utf8').trim()
  } catch {}
  if (!recorded || canonical(resolve(worktree.gitDirectory, recorded)) !== worktree.commonDirectory) throw new AppError(409, `The Git directory of ${worktree.worktreePath} was changed during the run`, 'worktree_git_tampered')
}

/** `git` on a worktree through its registered Git directory; see `worktreeGitArgs`. */
export function worktreeGit(worktree: WorktreeGit, args: string[], options: ExecFileSyncOptions = {}): string {
  assertWorktreeGitIntact(worktree)
  return String(execFileSync('git', worktreeGitArgs(worktree, args), worktreeGitOptions(worktree, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, ...options })))
}
