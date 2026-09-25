import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AppError, type ChangeProposal, type GithubHostConfig, type Project } from '../types.ts'
import type { CodeHost, CodeHostConnection, CodeHostFactoryContext } from './types.ts'

/** The commit status the platform publishes; branch protection makes it required in `host_protected` mode. */
export const GATE_STATUS_CONTEXT = 'aperture/gate'
const OWNER_OR_REPO = /^[A-Za-z0-9_.-]{1,100}$/u
// Account and organisation names never contain '.', so `u2pia.cc` is a typo caught here instead of a 404 later.
const OWNER = /^[A-Za-z0-9_-]{1,100}$/u
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/u

export type HostCheck = { name: string; status: 'queued' | 'in_progress' | 'completed'; conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' }
export type HostPullRequest = { externalId: string; url: string; state: 'open' | 'closed'; merged: boolean; mergedSha?: string; mergedBy?: string; mergedAt?: string; headSha: string; commits: number }

/** Plain http is only for a host on this machine (a test double, a local proxy); everything else must be https. */
function hostUrl(value: unknown, fallback: string, field: string) {
  const text = typeof value === 'string' && value.trim() ? value.trim().replace(/\/+$/u, '') : fallback
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new AppError(400, `${field} must be a URL`, 'invalid_code_host_config')
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new AppError(400, `${field} must use https`, 'invalid_code_host_config')
  if (url.username || url.password) throw new AppError(400, `${field} must not carry credentials`, 'invalid_code_host_config')
  return text
}

/** The web base is the site itself; the repository path is built from owner and repo, so a pasted repository URL is refused. */
function siteRoot(text: string) {
  if (new URL(text).pathname.replace(/\/+$/u, '') !== '') throw new AppError(400, 'webBase must be the site root (e.g. https://github.com), not a repository URL; put the repository in owner and repo', 'invalid_code_host_config')
  return text
}

export function managedClonePath(dataDirectory: string, projectId: string) {
  return join(dataDirectory, 'repositories', `${projectId}.git`)
}

/**
 * The only way a GitHub configuration enters a project. The token is referenced by environment variable name and
 * nothing that looks like a credential is accepted in any field. The working repository is always the control
 * plane's managed clone; a caller-supplied path is ignored.
 */
export function normalizeGithubHost(input: { codeHostConfig?: Record<string, unknown>; defaultBranch?: string; mergeMode?: Project['mergeMode'] }, context: { dataDirectory: string; projectId: string }) {
  const config = input.codeHostConfig ?? {}
  const owner = String(config.owner ?? '').trim()
  const repo = String(config.repo ?? '').trim().replace(/\.git$/u, '')
  if (!OWNER.test(owner)) throw new AppError(400, 'GitHub owner is required and may only contain letters, digits, "-" and "_" (an account or organisation name, not a domain)', 'invalid_code_host_config')
  if (!OWNER_OR_REPO.test(repo)) throw new AppError(400, 'GitHub repo is required and may only contain letters, digits, ".", "-" and "_"', 'invalid_code_host_config')
  const tokenEnv = String(config.tokenEnv ?? '').trim()
  if (!ENV_NAME.test(tokenEnv)) throw new AppError(400, 'tokenEnv must be the NAME of an environment variable (e.g. APERTURE_GITHUB_TOKEN), not a token', 'invalid_token_env')
  const transport = config.transport === 'ssh' ? 'ssh' : 'https'
  const normalized: GithubHostConfig = { apiBase: hostUrl(config.apiBase, 'https://api.github.com', 'apiBase'), webBase: siteRoot(hostUrl(config.webBase, 'https://github.com', 'webBase')), owner, repo, tokenEnv, transport }
  const remoteUrl = typeof config.remoteUrl === 'string' ? config.remoteUrl.trim() : ''
  if (remoteUrl) {
    // An embedded credential would land in the clone's config; ssh and file remotes carry none by construction.
    if (/^https?:\/\/[^/]*@/u.test(remoteUrl)) throw new AppError(400, 'remoteUrl must not carry credentials', 'invalid_code_host_config')
    if (!/^(https?:\/\/|ssh:\/\/|git@[^:]+:|file:\/\/)/u.test(remoteUrl)) throw new AppError(400, 'remoteUrl must be an https, ssh or file URL', 'invalid_code_host_config')
    normalized.remoteUrl = remoteUrl
  }
  const defaultBranch = input.defaultBranch?.trim() || 'main'
  return { codeHost: 'github' as const, codeHostConfig: normalized, repositoryPath: managedClonePath(context.dataDirectory, context.projectId), defaultBranch, mergeMode: input.mergeMode ?? 'control_plane' }
}

/**
 * A repository on GitHub or GitHub Enterprise. Runs and merges operate on a bare clone the control plane manages;
 * the token is read from the configured environment variable at each use and reaches git only through
 * GIT_CONFIG_* environment variables — never argv, the clone's config, the database or a log line.
 */
export class GithubCodeHost implements CodeHost {
  readonly descriptor
  private readonly project: Project
  private readonly config: GithubHostConfig
  private readonly context: CodeHostFactoryContext

  constructor(project: Project, context: CodeHostFactoryContext) {
    this.project = project
    this.context = context
    this.config = project.codeHostConfig as GithubHostConfig
    this.descriptor = { provider: 'github' as const, repository: `${this.config.owner}/${this.config.repo}`, mergeMode: project.mergeMode, webUrl: `${this.config.webBase}/${this.config.owner}/${this.config.repo}` }
  }

  workingRepository() {
    return this.project.repositoryPath ?? managedClonePath(this.context.dataDirectory, this.project.id)
  }

  private token() {
    const value = this.context.env[this.config.tokenEnv]?.trim()
    if (!value) throw new AppError(409, `Environment variable ${this.config.tokenEnv} is not set for the control plane process`, 'code_host_credential_missing')
    return value
  }

  private remoteUrl() {
    if (this.config.remoteUrl) return this.config.remoteUrl
    if (this.config.transport === 'ssh') return `git@${new URL(this.config.webBase).host}:${this.config.owner}/${this.config.repo}.git`
    return `${this.config.webBase}/${this.config.owner}/${this.config.repo}.git`
  }

  private gitEnv() {
    const env: NodeJS.ProcessEnv = { ...this.context.env, GIT_TERMINAL_PROMPT: '0' }
    const remote = this.remoteUrl()
    if (/^https?:\/\//u.test(remote)) {
      // Scoped to the remote's origin, so the header is never sent anywhere else a redirect or submodule points.
      // Appended after any GIT_CONFIG_* the operator already set (a proxy, say), rather than replacing them.
      const index = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0
      env.GIT_CONFIG_COUNT = String(index + 1)
      env[`GIT_CONFIG_KEY_${index}`] = `http.${new URL(remote).origin}/.extraheader`
      env[`GIT_CONFIG_VALUE_${index}`] = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.token()}`).toString('base64')}`
    }
    return env
  }

  private git(args: string[], cwd = this.workingRepository()) {
    try {
      return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: this.gitEnv(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 }).trim()
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim()
      // `push --porcelain` reports a rejected ref and its reason on stdout, so both streams are kept for callers.
      const output = `${String((error as { stdout?: unknown }).stdout ?? '').trim()}\n${stderr}`.trim()
      throw Object.assign(new AppError(502, `git ${args[0]} against ${this.descriptor.repository} failed: ${stderr.split('\n').slice(-3).join(' ') || (error instanceof Error ? error.message : String(error))}`, 'code_host_git_failed'), { stderr, output })
    }
  }

  private gitOk(args: string[]) {
    try {
      execFileSync('git', ['-C', this.workingRepository(), ...args], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  /**
   * Creates the managed bare clone on first use. Only the branches the platform needs are ever fetched. The
   * remote follows the project's current configuration: a clone made before owner, repo or transport was
   * corrected would otherwise keep fetching from the old address.
   */
  private ensureClone() {
    const path = this.workingRepository()
    if (existsSync(join(path, 'HEAD'))) {
      let current = ''
      try {
        current = execFileSync('git', ['-C', path, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      } catch {}
      if (current !== this.remoteUrl()) this.git(current ? ['remote', 'set-url', 'origin', this.remoteUrl()] : ['remote', 'add', 'origin', this.remoteUrl()])
      return path
    }
    mkdirSync(dirname(path), { recursive: true })
    execFileSync('git', ['init', '--bare', '--quiet', path], { stdio: 'ignore' })
    this.git(['remote', 'add', 'origin', this.remoteUrl()])
    this.git(['symbolic-ref', 'HEAD', `refs/heads/${this.project.defaultBranch}`])
    return path
  }

  /** The remote is the truth for the default branch; the platform only moves it by pushing. */
  prepareForRun() {
    this.token()
    this.ensureClone()
    try {
      this.git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${this.project.defaultBranch}:refs/heads/${this.project.defaultBranch}`])
    } catch (error) {
      // An empty repository, or a default branch named differently on the host, both surface as a missing ref.
      if (/couldn't find remote ref/iu.test(String((error as { stderr?: string }).stderr ?? ''))) throw new AppError(409, `${this.descriptor.repository} has no branch ${this.project.defaultBranch}: push a first commit to it, or set the project's default branch to the one the repository uses`, 'code_host_default_branch_missing')
      throw error
    }
  }

  ensureRef(ref: string, refresh = false) {
    const branch = ref.replace(/^refs\/heads\//u, '')
    if (!refresh && this.gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])) return
    this.git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/heads/${branch}`])
  }

  /**
   * `control_plane` mode. The lease names the base the approval was made against, so a push that would overwrite
   * commits someone else landed on GitHub in the meantime is refused, as is one branch protection rejects.
   */
  publishMerge(input: { baseRef: string; baseShaBefore: string; mergedSha: string }) {
    const branch = input.baseRef.replace(/^refs\/heads\//u, '')
    try {
      this.git(['push', '--quiet', '--porcelain', `--force-with-lease=refs/heads/${branch}:${input.baseShaBefore}`, 'origin', `${input.mergedSha}:refs/heads/${branch}`])
    } catch (error) {
      const stderr = String((error as { output?: string }).output ?? (error instanceof Error ? error.message : ''))
      if (/stale info|fetch first|non-fast-forward|\(stale\)/iu.test(stderr)) throw new AppError(409, `${branch} moved on ${this.descriptor.repository} since the proposal was reviewed; refresh and review again`, 'remote_base_moved')
      if (/protected branch|GH006|declined|pre-receive hook|denied/iu.test(stderr)) throw new AppError(409, `${this.descriptor.repository} refused the push to ${branch}; switch the project to host_protected or allow the push`, 'host_rejected_push')
      throw error
    }
  }

  /**
   * Pushes the proposal's head to a branch the platform owns — stable across revisions, so the pull request
   * survives them — and opens the pull request if there is none. The push is forced: only the platform writes it.
   */
  async publishProposal(input: { proposal: ChangeProposal; title: string; body: string; externalId?: string }) {
    const publishedRef = `aperture/${input.proposal.id.toLowerCase()}`
    this.ensureClone()
    this.git(['push', '--quiet', '--force', 'origin', `${input.proposal.headSha}:refs/heads/${publishedRef}`])
    if (input.externalId) {
      const existing = await this.getPullRequest(input.externalId)
      return { externalId: existing.externalId, url: existing.url, publishedRef, headShaPublished: input.proposal.headSha }
    }
    const open = await this.api<Array<{ number: number; html_url: string }>>('GET', `/pulls?state=open&head=${encodeURIComponent(`${this.config.owner}:${publishedRef}`)}`)
    const pull = open[0] ?? await this.api<{ number: number; html_url: string }>('POST', '/pulls', { title: input.title, head: publishedRef, base: input.proposal.baseRef.replace(/^refs\/heads\//u, ''), body: input.body, maintainer_can_modify: false })
    return { externalId: String(pull.number), url: pull.html_url, publishedRef, headShaPublished: input.proposal.headSha }
  }

  async getPullRequest(externalId: string): Promise<HostPullRequest> {
    const pull = await this.api<{ number: number; html_url: string; state: 'open' | 'closed'; merged?: boolean; merge_commit_sha?: string | null; merged_by?: { login?: string } | null; merged_at?: string | null; head: { sha: string }; commits?: number }>('GET', `/pulls/${encodeURIComponent(externalId)}`)
    return { externalId: String(pull.number), url: pull.html_url, state: pull.state, merged: Boolean(pull.merged || pull.merged_at), mergedSha: pull.merge_commit_sha ?? undefined, mergedBy: pull.merged_by?.login, mergedAt: pull.merged_at ?? undefined, headSha: pull.head.sha, commits: pull.commits ?? 1 }
  }

  /**
   * Asks GitHub to merge the pull request at exactly `headSha`, so a commit pushed after approval is never merged.
   * GitHub still applies branch protection: a missing required check or review refuses the merge with its reason.
   * The repository's allowed merge methods are tried in turn, merge commit first.
   */
  async mergePullRequest(externalId: string, headSha: string, title: string) {
    for (const method of ['merge', 'squash', 'rebase'] as const) {
      try {
        const merged = await this.api<{ sha: string; merged: boolean; message?: string }>('PUT', `/pulls/${encodeURIComponent(externalId)}/merge`, { sha: headSha, merge_method: method, ...(method === 'rebase' ? {} : { commit_title: title }) })
        if (!merged.merged || !merged.sha) throw new AppError(409, `GitHub did not merge pull request #${externalId}: ${merged.message ?? 'no reason given'}`, 'host_merge_refused')
        return { mergedSha: merged.sha, method }
      } catch (error) {
        // 405 is also what a disallowed merge method returns; only that case moves on to the next method.
        if (error instanceof AppError && error.code === 'host_merge_refused' && /merge method|not allowed|not enabled/iu.test(error.message) && method !== 'rebase') continue
        if (error instanceof AppError && error.code === 'code_host_conflict') throw new AppError(409, `The pull request's head is no longer the approved ${headSha.slice(0, 12)}; sync and review again`, 'merge_head_drift')
        throw error
      }
    }
    throw new AppError(409, `No merge method is allowed on ${this.descriptor.repository}`, 'host_merge_refused')
  }

  /** Check runs and commit statuses on a revision, minus the platform's own gate status. */
  async listChecks(sha: string): Promise<HostCheck[]> {
    const runs = await this.api<{ check_runs: Array<{ name: string; status: string; conclusion: string | null }> }>('GET', `/commits/${sha}/check-runs?per_page=100`)
    const combined = await this.api<{ statuses: Array<{ context: string; state: string }> }>('GET', `/commits/${sha}/status?per_page=100`)
    const byName = new Map<string, HostCheck>()
    // Newest first in both responses, so the first entry for a name is the one that counts.
    for (const run of runs.check_runs) {
      if (byName.has(run.name)) continue
      const conclusion = ({ success: 'success', neutral: 'neutral', skipped: 'neutral', stale: 'neutral', cancelled: 'cancelled', failure: 'failure', timed_out: 'failure', action_required: 'failure', startup_failure: 'failure' } as const)[run.conclusion ?? ''] as HostCheck['conclusion']
      byName.set(run.name, run.status === 'completed' ? { name: run.name, status: 'completed', conclusion: conclusion ?? 'neutral' } : { name: run.name, status: run.status === 'queued' ? 'queued' : 'in_progress' })
    }
    for (const status of combined.statuses) {
      if (status.context === GATE_STATUS_CONTEXT || byName.has(status.context)) continue
      byName.set(status.context, status.state === 'pending' ? { name: status.context, status: 'in_progress' } : { name: status.context, status: 'completed', conclusion: status.state === 'success' ? 'success' : 'failure' })
    }
    return [...byName.values()]
  }

  async setGateStatus(sha: string, state: 'pending' | 'success' | 'failure', description: string, targetUrl?: string) {
    await this.api('POST', `/statuses/${sha}`, { state, context: GATE_STATUS_CONTEXT, description: description.slice(0, 140), ...(targetUrl ? { target_url: targetUrl } : {}) })
  }

  /** How a revision the host merged relates to the approved head: contains it, same tree, same patch, or none. */
  compareMergedContent(input: { approvedHeadSha: string; baseSha: string; mergedSha: string; commits: number }): 'ancestor' | 'tree_equal' | 'patch_equal' | 'mismatch' {
    if (!this.gitOk(['cat-file', '-e', `${input.mergedSha}^{commit}`])) this.git(['fetch', '--quiet', '--no-tags', 'origin', input.mergedSha])
    if (this.gitOk(['merge-base', '--is-ancestor', input.approvedHeadSha, input.mergedSha])) return 'ancestor'
    if (this.git(['rev-parse', `${input.mergedSha}^{tree}`]) === this.git(['rev-parse', `${input.approvedHeadSha}^{tree}`])) return 'tree_equal'
    // Squash and rebase merges rewrite the commits; the approved change is still there if the patch is identical.
    const approved = this.patchId(input.baseSha, input.approvedHeadSha)
    const candidates = [...new Set([1, Math.max(1, input.commits)])].map((count) => this.gitOk(['rev-parse', '--verify', '--quiet', `${input.mergedSha}~${count}`]) ? this.patchId(`${input.mergedSha}~${count}`, input.mergedSha) : undefined)
    return approved && candidates.includes(approved) ? 'patch_equal' : 'mismatch'
  }

  private patchId(from: string, to: string) {
    const diff = this.git(['diff', '--full-index', '--binary', from, to])
    if (!diff) return undefined
    return execFileSync('git', ['-C', this.workingRepository(), 'patch-id', '--stable'], { input: `${diff}\n`, encoding: 'utf8' }).trim().split(/\s+/u)[0]
  }

  async testConnection(): Promise<CodeHostConnection> {
    const failed = (message: string, extra: Partial<CodeHostConnection> = {}): CodeHostConnection => ({ ok: false, repositoryReachable: false, defaultBranchFound: false, credentialPresent: true, missingPermissions: [], message, ...extra })
    if (!this.context.env[this.config.tokenEnv]?.trim()) return failed(`Environment variable ${this.config.tokenEnv} is not set for the control plane process.`, { credentialPresent: false })
    try {
      let repository: { permissions?: { push?: boolean; pull?: boolean }; size?: number; default_branch?: string }
      try {
        repository = await this.api('GET', '')
      } catch (error) {
        // GitHub answers 404 both for a repository that does not exist and for a private one the token cannot see.
        if (error instanceof AppError && error.status === 404) return failed(`Repository ${this.descriptor.repository} was not found, or the token cannot see it. Check owner and repo against the address on GitHub.`)
        throw error
      }
      const missing = repository.permissions && !repository.permissions.push ? ['contents:write'] : []
      let branchFound = true
      try {
        await this.api('GET', `/branches/${encodeURIComponent(this.project.defaultBranch)}`)
      } catch (error) {
        if (error instanceof AppError && error.status === 404) branchFound = false
        else throw error
      }
      const ok = branchFound && missing.length === 0
      return { ok, repositoryReachable: true, defaultBranchFound: branchFound, credentialPresent: true, missingPermissions: missing, message: ok ? `${this.descriptor.repository} is reachable and the token can push. Pull request and commit status permissions are verified on first publish.` : !branchFound ? (repository.size === 0 ? `${this.descriptor.repository} is empty: push a first commit to ${this.project.defaultBranch} before running anything.` : `Default branch ${this.project.defaultBranch} does not exist on ${this.descriptor.repository}${repository.default_branch ? `; its default branch is ${repository.default_branch}` : ''}.`) : `The token cannot push to ${this.descriptor.repository}.` }
    } catch (error) {
      const code = error instanceof AppError ? error.code : ''
      return failed(error instanceof Error ? error.message : String(error), { repositoryReachable: code !== 'code_host_not_found' && code !== 'code_host_unreachable' && code !== 'code_host_unauthorized' })
    }
  }

  /** Every response is data. Error messages carry the method, path and GitHub's message — never a header. */
  private async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.config.apiBase}/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}${path}`
    let response: Response
    try {
      response = await fetch(url, { method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token()}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'aperture-control-plane', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) })
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(502, `GitHub API ${method} ${path || '/'} is unreachable: ${error instanceof Error ? error.message : String(error)}`, 'code_host_unreachable')
    }
    const text = await response.text()
    if (!response.ok) {
      let message = text.slice(0, 200)
      try {
        message = String((JSON.parse(text) as { message?: unknown }).message ?? message)
      } catch {}
      // 405 and 409 are GitHub refusing a merge (branch protection, a moved head), not the API failing.
      if (response.status === 405 || response.status === 409) throw new AppError(409, `GitHub refused ${method} ${path}: ${message}`, response.status === 409 ? 'code_host_conflict' : 'host_merge_refused')
      const code = response.status === 401 ? 'code_host_unauthorized' : response.status === 404 ? 'code_host_not_found' : response.status === 403 ? 'code_host_forbidden' : 'code_host_api_failed'
      throw new AppError(response.status === 404 ? 404 : 502, `GitHub API ${method} ${path || '/'} → ${response.status}: ${message}`, code)
    }
    return (text ? JSON.parse(text) : undefined) as T
  }
}
