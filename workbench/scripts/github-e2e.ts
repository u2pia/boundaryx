import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GithubCodeHost } from '../server/code-host/github.ts'
import { codeHostFor } from '../server/code-host/index.ts'
import { CodeHostSyncer } from '../server/code-host/syncer.ts'
import { ControlPlaneDatabase, SYSTEM_CODE_HOST_ACTOR_ID } from '../server/database.ts'
import { LocalGitAuthority } from '../server/local-git-authority.ts'
import { AppError, type Project } from '../server/types.ts'

// Against a real GitHub repository, not part of `npm run check`: both merge modes, real GitHub Actions checks, and
// the gate status as GitHub shows it. The repository's default branch is merged into, so use a throwaway repository
// whose main runs its test suite in Actions on pull_request.
//
//   APERTURE_GITHUB_TOKEN=… GITHUB_E2E_REPO=owner/repo npm run test:github-e2e
//
// The token is read from the environment only; the data directory it leaves behind is scanned for it at the end.

const TOKEN_ENV = 'APERTURE_GITHUB_TOKEN'
const token = process.env[TOKEN_ENV]?.trim()
if (!token) throw new Error(`${TOKEN_ENV} is not set`)
const [owner, repo] = (process.env.GITHUB_E2E_REPO ?? '').split('/')
if (!owner || !repo) throw new Error('GITHUB_E2E_REPO must be owner/repo')
const apiBase = (process.env.GITHUB_E2E_API_BASE ?? 'https://api.github.com').replace(/\/+$/u, '')
const workbench = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDirectory = join(workbench, '.aperture-github-e2e')
rmSync(dataDirectory, { recursive: true, force: true })
mkdirSync(dataDirectory, { recursive: true })

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${apiBase}/repos/${owner}/${repo}${path}`, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(init.body ? { 'content-type': 'application/json' } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined })
  if (!response.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path} → ${response.status}: ${(await response.text()).slice(0, 300)}`)
  return (response.status === 204 ? undefined : await response.json()) as T
}
const failsWith = (code: string) => (error: unknown) => error instanceof AppError && error.code === code
const step = (message: string) => console.log(`· ${message}`)
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

const database = new ControlPlaneDatabase(join(dataDirectory, 'control-plane.db'), join(workbench, 'server', 'migrations'))
const authority = new LocalGitAuthority(database)
const syncer = new CodeHostSyncer({ database, env: process.env })
const hostOf = (project: Project) => codeHostFor(project, { dataDirectory: database.dataDirectory, env: process.env }) as GithubCodeHost

/** Syncs until `done` holds; GitHub Actions takes a minute or two per commit. */
async function syncUntil(project: Project, label: string, done: () => boolean | Promise<boolean>, timeoutMs = 360_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const report = await syncer.syncProject(project.id)
    if (report.errors.length) console.log('  sync errors:', report.errors)
    if (await done()) return report
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(8000)
  }
}

try {
  const ownerActor = database.createActor({ username: 'owner', displayName: 'Owner', role: 'owner', password: 'owner-password-2026' })
  const alice = database.createActor({ username: 'alice', displayName: 'Alice', role: 'developer', password: 'alice-password-2026', projectIds: [] }, ownerActor.id)
  const bob = database.createActor({ username: 'bob', displayName: 'Bob', role: 'reviewer', password: 'bob-password-2026', projectIds: [] }, ownerActor.id)
  const repository = await api<{ default_branch: string }>('')
  let project = database.createProject({ slug: 'e2e', name: `${owner}/${repo}`, codeHost: 'github', codeHostConfig: { owner, repo, tokenEnv: TOKEN_ENV, apiBase }, defaultBranch: repository.default_branch, members: [{ actorId: alice.id, role: 'developer' }, { actorId: bob.id, role: 'reviewer' }] }, ownerActor.id)
  const main = project.defaultBranch

  const connection = await hostOf(project).testConnection()
  assert.equal(connection.ok, true, `connection: ${connection.message} ${connection.missingPermissions.join(',')}`)
  step(`connection ok · ${owner}/${repo} · default branch ${main}`)
  hostOf(project).prepareForRun()
  const clone = project.repositoryPath!
  const remoteMain = async () => (await api<{ commit: { sha: string } }>(`/branches/${encodeURIComponent(main)}`)).commit.sha
  assert.equal(git(clone, 'rev-parse', `refs/heads/${main}`), await remoteMain())
  step('managed clone follows the remote default branch')

  const stamp = Date.now().toString(36)
  const criteria = [{ statement: 'test suite passes', criticality: 'critical' as const, verificationType: 'deterministic' as const }]
  /** What a run leaves behind: one commit on a branch of the managed clone, cut from the current default branch. */
  function runProposal(name: string) {
    hostOf(project).prepareForRun()
    const branch = `agent/e2e-${stamp}-${name}`
    const worktree = join(dataDirectory, 'worktrees', name)
    git(clone, 'worktree', 'add', '--quiet', '-b', branch, worktree, `refs/heads/${main}`)
    mkdirSync(join(worktree, 'docs', 'e2e'), { recursive: true })
    writeFileSync(join(worktree, 'docs', 'e2e', `${stamp}-${name}.md`), `# e2e ${name}\n\nWritten by the Aperture GitHub end-to-end test.\n`)
    git(worktree, 'add', '.')
    git(worktree, '-c', 'user.name=Aperture E2E', '-c', 'user.email=aperture-e2e@example.invalid', 'commit', '--quiet', '-m', `docs: e2e ${name}`)
    git(clone, 'worktree', 'remove', '--force', worktree)
    const workItem = database.createWorkItem({ title: `E2E ${name}`, description: name, ownerActorId: alice.id, projectId: project.id }, ownerActor.id)
    const intent = database.createIntentVersion({ workItemId: workItem.id, goal: `E2E ${name}`, constraints: [], riskLevel: 'low', acceptanceCriteria: criteria }, ownerActor.id)
    return authority.createChangeProposal({ workItemId: workItem.id, intentVersionId: intent.id, runId: `RUN-E2E-${name.toUpperCase()}`, baseRef: main, headRef: branch, authorActorId: alice.id }, alice.id)
  }
  function approve(proposalId: string) {
    const proposal = database.getChangeProposal(proposalId)
    database.recordCheck({ proposalId, headSha: proposal.headSha, name: 'unit', status: 'completed', conclusion: 'success' }, ownerActor.id)
    const evidence = database.recordEvidence({ proposalId, runId: proposal.runId!, headSha: proposal.headSha, uri: `local://evidence/${proposalId}.json`, sha256: `sha256:${proposalId}`, summary: {} }, ownerActor.id)
    database.recordEvidenceView(evidence.id, bob.id, evidence.sha256)
    database.recordReview({ proposalId, headSha: proposal.headSha, reviewerActorId: bob.id, decision: 'approved', comment: 'e2e' })
  }
  const linkOf = (proposalId: string) => database.getCodeHostLink(proposalId)!
  const pullOf = (proposalId: string) => api<{ state: string; merged: boolean; head: { ref: string; sha: string } }>(`/pulls/${linkOf(proposalId).externalId}`)
  const gateOnGithub = async (sha: string) => (await api<{ statuses: Array<{ context: string; state: string; description: string }> }>(`/commits/${sha}/status`)).statuses.find((status) => status.context === 'aperture/gate')
  const importedChecks = (proposalId: string) => database.getReviewReadiness(proposalId).checks.filter((check) => check.name.startsWith('github/'))
  const actionsFinished = (proposalId: string) => {
    const checks = importedChecks(proposalId)
    return checks.length > 0 && checks.every((check) => check.status === 'completed')
  }
  const urls: string[] = []

  // --- control_plane: publish, gate follows review and Actions, the platform merges and pushes. ---
  const a = runProposal('a')
  await syncer.syncProject(project.id)
  urls.push(linkOf(a.id).url)
  const pullA = await pullOf(a.id)
  assert.deepEqual([pullA.state, pullA.head.ref, pullA.head.sha], ['open', `aperture/${a.id.toLowerCase()}`, a.headSha])
  assert.equal((await gateOnGithub(a.headSha))?.state, 'pending')
  step(`A published · ${linkOf(a.id).url} · aperture/gate pending`)
  approve(a.id)
  await syncUntil(project, 'Actions on A', () => actionsFinished(a.id))
  assert.deepEqual(importedChecks(a.id).map((check) => [check.conclusion, check.source]), importedChecks(a.id).map(() => ['success', 'external']), `Actions checks on A: ${JSON.stringify(importedChecks(a.id))}`)
  assert.equal(database.getReviewReadiness(a.id).status, 'ready')
  assert.equal((await gateOnGithub(a.headSha))?.state, 'success')
  step(`A approved · imported ${importedChecks(a.id).map((check) => check.name).join(', ')} · aperture/gate success on GitHub`)
  const mergedA = authority.mergeChangeProposal(a.id, ownerActor.id)
  assert.equal(mergedA.evidence.strategy, 'fast_forward')
  assert.equal(await remoteMain(), a.headSha)
  await syncUntil(project, 'GitHub to mark A merged', async () => (await pullOf(a.id)).merged, 60_000)
  assert.equal(linkOf(a.id).state, 'merged')
  step('A merged by the platform and pushed · GitHub marks the pull request merged')

  // --- The remote moves under an approved proposal: lease refuses, local rolls back; then GitHub closes it. ---
  const b = runProposal('b')
  await syncer.syncProject(project.id)
  urls.push(linkOf(b.id).url)
  approve(b.id)
  await syncUntil(project, 'Actions on B', () => actionsFinished(b.id))
  await api(`/contents/docs/e2e/${stamp}-moved.md`, { method: 'PUT', body: { message: 'docs: move main under an approved proposal', content: Buffer.from('moved\n').toString('base64'), branch: main } })
  assert.throws(() => authority.mergeChangeProposal(b.id, ownerActor.id), failsWith('remote_base_moved'))
  assert.deepEqual([git(clone, 'rev-parse', `refs/heads/${main}`), database.getChangeProposal(b.id).status], [a.headSha, 'approved'], 'the local merge is rolled back')
  step('B refused with remote_base_moved · local main rolled back · proposal still approved')
  await api(`/pulls/${linkOf(b.id).externalId}`, { method: 'PATCH', body: { state: 'closed' } })
  await syncUntil(project, 'B closed', () => database.getChangeProposal(b.id).status === 'closed', 60_000)
  assert.equal(linkOf(b.id).state, 'closed')
  step('B closed on GitHub → proposal closed on the platform')

  // --- host_protected: GitHub merges behind a green gate; the platform records it. ---
  project = database.updateProjectSettings(project.id, { mergeMode: 'host_protected' }, ownerActor.id)
  const c = runProposal('c')
  await syncer.syncProject(project.id)
  urls.push(linkOf(c.id).url)
  assert.throws(() => authority.mergeChangeProposal(c.id, ownerActor.id), failsWith('merge_on_host'))
  approve(c.id)
  await syncUntil(project, 'gate success on C', async () => actionsFinished(c.id) && (await gateOnGithub(c.headSha))?.state === 'success')
  await api(`/pulls/${linkOf(c.id).externalId}/merge`, { method: 'PUT', body: { merge_method: 'squash', sha: c.headSha } })
  await syncUntil(project, 'C recorded', () => database.getChangeProposal(c.id).status === 'merged', 60_000)
  const evidenceC = database.getMergeEvidence(c.id)
  assert.deepEqual([evidenceC.strategy, evidenceC.mergedByActorId, evidenceC.hostMerge?.gateStateAtMerge, evidenceC.hostMerge?.outsideGate], ['host_merge', SYSTEM_CODE_HOST_ACTOR_ID, 'success', false])
  assert.ok(['patch_equal', 'tree_equal'].includes(evidenceC.hostMerge!.contentCheck), `squash content check: ${evidenceC.hostMerge!.contentCheck}`)
  assert.equal(evidenceC.mergedSha, await remoteMain())
  step(`C squash-merged on GitHub by ${evidenceC.hostMerge?.mergedBy} · host_merge ${evidenceC.hostMerge?.contentCheck} · inside the gate`)

  // --- A merge on GitHub the gate never allowed is recorded and flagged. ---
  const d = runProposal('d')
  await syncer.syncProject(project.id)
  urls.push(linkOf(d.id).url)
  await api(`/pulls/${linkOf(d.id).externalId}/merge`, { method: 'PUT', body: { merge_method: 'merge', sha: d.headSha } })
  await syncUntil(project, 'D recorded', () => database.getChangeProposal(d.id).status === 'merged', 60_000)
  const evidenceD = database.getMergeEvidence(d.id)
  assert.deepEqual([evidenceD.hostMerge?.contentCheck, evidenceD.hostMerge?.outsideGate], ['ancestor', true])
  assert.ok(database.listAggregateEvents('change_proposal', d.id).some((event) => event.eventType === 'change_proposal.merged_outside_gate'))
  step(`D merged on GitHub without review → merged_outside_gate · ${evidenceD.hostMerge?.outsideGateReasons.join('; ')}`)

  // --- The token never lands on disk. ---
  const files: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else files.push(path)
    }
  }
  walk(dataDirectory)
  const leaked = files.filter((path) => readFileSync(path).includes(token))
  assert.deepEqual(leaked, [], 'the token is not in the data directory')
  step(`token absent from ${files.length} files in the data directory`)

  console.log(`github e2e passed · ${owner}/${repo} · ${urls.join(' ')}`)
} finally {
  syncer.close()
  database.close()
}
