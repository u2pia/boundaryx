import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { GithubCodeHost } from '../server/code-host/github.ts'
import { codeHostFor } from '../server/code-host/index.ts'
import { CodeHostSyncer } from '../server/code-host/syncer.ts'
import { ControlPlaneDatabase, SYSTEM_CODE_HOST_ACTOR_ID } from '../server/database.ts'
import { createControlPlaneRequestHandler } from '../server/http-server.ts'
import { LocalCommandAgentRunner } from '../server/local-command-agent-runner.ts'
import { LocalGitAuthority } from '../server/local-git-authority.ts'
import { AppError, type Project } from '../server/types.ts'

// A GitHub project: the platform pushes each proposal to a branch it owns, opens a pull request, publishes its gate
// as the `aperture/gate` status, imports GitHub's checks as independent evidence, and either merges and pushes under
// a lease (`control_plane`) or records the merge GitHub made (`host_protected`). The fake GitHub below is the API;
// a bare repository reached through a file:// remote is the git side. The token only ever lives in the environment.
const root = mkdtempSync(join(tmpdir(), 'aperture-github-host-'))
const dataDirectory = join(root, 'data')
mkdirSync(dataDirectory)
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')
const failsWith = (code: string) => (error: unknown) => error instanceof AppError && error.code === code
const TOKEN_ENV = 'APERTURE_SMOKE_GITHUB_TOKEN'
const TOKEN = `ghp_smoke${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// --- The host's git side: a bare "GitHub" repository, and a developer's clone of it. ---
const remote = join(root, 'remote.git')
const seed = join(root, 'seed')
execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote])
execFileSync('git', ['clone', '--quiet', remote, seed], { stdio: 'ignore' })
git(seed, 'config', 'user.name', 'Aperture Test')
git(seed, 'config', 'user.email', 'aperture@example.test')
git(seed, 'checkout', '--quiet', '-b', 'main')
writeFileSync(join(seed, 'README.md'), '# widgets\n')
git(seed, 'add', '.')
git(seed, 'commit', '--quiet', '-m', 'initial')
git(seed, 'push', '--quiet', 'origin', 'main')
const remoteSha = (ref: string) => {
  try {
    return git(remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}^{commit}`)
  } catch {
    return undefined
  }
}
/** A branch in the developer's clone, cut from the host's current main, with one commit. */
function branchOnSeed(branch: string, file: string) {
  git(seed, 'fetch', '--quiet', 'origin')
  git(seed, 'checkout', '--quiet', '-B', branch, 'origin/main')
  writeFileSync(join(seed, file), `${branch}\n`)
  git(seed, 'add', '.')
  git(seed, 'commit', '--quiet', '-m', branch)
  return git(seed, 'rev-parse', 'HEAD')
}

// --- The host's API side. ---
type Pull = { number: number; head: string; base: string; state: 'open' | 'closed'; merged: boolean; mergeCommitSha?: string; mergedBy?: string; mergedAt?: string; headShaAtMerge?: string; commitsAtMerge?: number }
const pulls: Pull[] = []
const statuses = new Map<string, Array<{ state: string; context: string; description: string }>>()
const checkRuns = new Map<string, Array<{ name: string; status: string; conclusion: string | null }>>()
const commitStatuses = new Map<string, Array<{ context: string; state: string }>>()
let requests = 0
let pushAllowed = true
// What GitHub's merge API does: refuse with branch protection's reason, or allow only some merge methods.
let mergeRefusal: string | undefined
let allowedMergeMethods = ['merge', 'squash', 'rebase']
const pullJson = (pull: Pull) => {
  const headSha = pull.headShaAtMerge ?? remoteSha(pull.head) ?? ''
  // GitHub marks a pull request merged on its own when its head lands on the base branch by a push.
  if (pull.state === 'open' && headSha) {
    try {
      git(remote, 'merge-base', '--is-ancestor', headSha, `refs/heads/${pull.base}`)
      Object.assign(pull, { state: 'closed', merged: true, mergeCommitSha: remoteSha(pull.base), mergedAt: new Date().toISOString(), headShaAtMerge: headSha })
    } catch {}
  }
  const commits = pull.commitsAtMerge ?? (headSha ? Number(git(remote, 'rev-list', '--count', `refs/heads/${pull.base}..${headSha}`)) : 0)
  return { number: pull.number, html_url: `https://github.example/acme/widgets/pull/${pull.number}`, state: pull.state, merged: pull.merged, merge_commit_sha: pull.mergeCommitSha ?? null, merged_by: pull.mergedBy ? { login: pull.mergedBy } : null, merged_at: pull.mergedAt ?? null, head: { ref: pull.head, sha: headSha }, base: { ref: pull.base }, commits }
}
const fake = createServer(async (request, response) => {
  requests += 1
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any> : {}
  const send = (status: number, payload: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
  }
  if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Bad credentials' })
  const url = new URL(request.url ?? '/', 'http://fake')
  const path = url.pathname.replace(/^\/repos\/acme\/widgets/u, '')
  if (!url.pathname.startsWith('/repos/acme/widgets')) return send(404, { message: 'Not Found' })
  if (request.method === 'GET' && path === '') return send(200, { full_name: 'acme/widgets', permissions: { pull: true, push: pushAllowed } })
  const branch = /^\/branches\/(.+)$/u.exec(path)
  if (request.method === 'GET' && branch) return remoteSha(decodeURIComponent(branch[1])) ? send(200, { name: branch[1] }) : send(404, { message: 'Branch not found' })
  if (request.method === 'GET' && path === '/pulls') {
    const head = url.searchParams.get('head')?.replace(/^acme:/u, '')
    return send(200, pulls.filter((pull) => pull.state === 'open' && pull.head === head).map(pullJson))
  }
  if (request.method === 'POST' && path === '/pulls') {
    if (!remoteSha(body.head)) return send(422, { message: `head ${body.head} does not exist` })
    assert.equal(body.maintainer_can_modify, false)
    const pull: Pull = { number: pulls.length + 1, head: body.head, base: body.base, state: 'open', merged: false }
    pulls.push(pull)
    return send(201, pullJson(pull))
  }
  const pullRoute = /^\/pulls\/(\d+)$/u.exec(path)
  if (request.method === 'GET' && pullRoute) {
    const pull = pulls[Number(pullRoute[1]) - 1]
    return pull ? send(200, pullJson(pull)) : send(404, { message: 'Not Found' })
  }
  const mergeRoute = /^\/pulls\/(\d+)\/merge$/u.exec(path)
  if (request.method === 'PUT' && mergeRoute) {
    const pull = pulls[Number(mergeRoute[1]) - 1]
    if (!pull || pull.state !== 'open') return send(405, { message: 'Pull Request is not mergeable' })
    if (mergeRefusal) return send(405, { message: mergeRefusal })
    if (!allowedMergeMethods.includes(body.merge_method)) return send(405, { message: `${body.merge_method} merges are not allowed on this repository.` })
    if (body.sha !== remoteSha(pull.head)) return send(409, { message: 'Head branch was modified. Review and try the merge again.' })
    mergeOnHost(pull.number, body.merge_method === 'merge' ? 'merge' : 'squash', 'aperture-bot')
    return send(200, { sha: pull.mergeCommitSha, merged: true, message: 'Pull Request successfully merged' })
  }
  const statusRoute = /^\/statuses\/([0-9a-f]{40})$/u.exec(path)
  if (request.method === 'POST' && statusRoute) {
    statuses.set(statusRoute[1], [{ state: body.state, context: body.context, description: body.description }, ...(statuses.get(statusRoute[1]) ?? [])])
    return send(201, {})
  }
  const runsRoute = /^\/commits\/([0-9a-f]{40})\/check-runs$/u.exec(path)
  if (request.method === 'GET' && runsRoute) return send(200, { total_count: 0, check_runs: checkRuns.get(runsRoute[1]) ?? [] })
  const combinedRoute = /^\/commits\/([0-9a-f]{40})\/status$/u.exec(path)
  if (request.method === 'GET' && combinedRoute) {
    const own = (statuses.get(combinedRoute[1]) ?? []).map((status) => ({ context: status.context, state: status.state }))
    return send(200, { statuses: [...(commitStatuses.get(combinedRoute[1]) ?? []), ...own] })
  }
  return send(404, { message: `No fake for ${request.method} ${path}` })
})
fake.listen(0, '127.0.0.1')
await once(fake, 'listening')
const apiBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
const gateOf = (sha: string) => statuses.get(sha)?.find((status) => status.context === 'aperture/gate')

/** A merge made on GitHub: a merge commit or a squash, by someone who is not the platform. */
function mergeOnHost(number: number, method: 'merge' | 'squash', mergedBy = 'octocat') {
  const pull = pulls[number - 1]
  const work = join(root, `host-merge-${number}`)
  execFileSync('git', ['clone', '--quiet', remote, work], { stdio: 'ignore' })
  git(work, 'config', 'user.name', 'Octocat')
  git(work, 'config', 'user.email', 'octocat@example.test')
  const headSha = remoteSha(pull.head)!
  const commits = Number(git(remote, 'rev-list', '--count', `refs/heads/${pull.base}..${headSha}`))
  if (method === 'merge') git(work, 'merge', '--quiet', '--no-ff', '-m', `Merge pull request #${number}`, `origin/${pull.head}`)
  else {
    git(work, 'merge', '--quiet', '--squash', `origin/${pull.head}`)
    git(work, 'commit', '--quiet', '-m', `Squash #${number}`)
  }
  git(work, 'push', '--quiet', 'origin', pull.base)
  Object.assign(pull, { state: 'closed', merged: true, mergeCommitSha: git(work, 'rev-parse', 'HEAD'), mergedBy, mergedAt: new Date().toISOString(), headShaAtMerge: headSha, commitsAtMerge: commits })
  rmSync(work, { recursive: true, force: true })
}

const database = new ControlPlaneDatabase(join(dataDirectory, 'control-plane.db'), migrationDirectory)
const authority = new LocalGitAuthority(database)
const env = (): NodeJS.ProcessEnv => ({ ...process.env })
const syncer = new CodeHostSyncer({ database, env: process.env, publicUrl: 'http://127.0.0.1:4173/' })
const hostOf = (project: Project) => codeHostFor(project, { dataDirectory: database.dataDirectory, env: env() }) as GithubCodeHost

try {
  const owner = database.createActor({ username: 'owner', displayName: 'Owner', role: 'owner', password: 'owner-password-2026' })
  const alice = database.createActor({ username: 'alice', displayName: 'Alice', role: 'developer', password: 'alice-password-2026', projectIds: [] }, owner.id)
  const bob = database.createActor({ username: 'bob', displayName: 'Bob', role: 'reviewer', password: 'bob-password-2026', projectIds: [] }, owner.id)

  // --- Configuration: a token is referenced by name only, and nothing credential-shaped is accepted. ---
  const config = { owner: 'acme', repo: 'widgets', tokenEnv: TOKEN_ENV, apiBase, webBase: 'https://github.example', remoteUrl: `file://${remote}` }
  const create = (codeHostConfig: Record<string, unknown>, slug = 'bad') => database.createProject({ slug, name: slug, codeHost: 'github', codeHostConfig }, owner.id)
  assert.throws(() => create({ ...config, tokenEnv: TOKEN }), failsWith('invalid_token_env'), 'a token pasted where its variable name belongs is refused')
  assert.throws(() => create({ ...config, owner: 'acme corp' }), failsWith('invalid_code_host_config'))
  assert.throws(() => create({ ...config, owner: 'acme.cc' }), failsWith('invalid_code_host_config'), 'an owner is an account name, never a domain')
  assert.throws(() => create({ ...config, webBase: 'https://github.example/acme/widgets' }), failsWith('invalid_code_host_config'), 'webBase is the site root, not the repository URL')
  assert.throws(() => create({ ...config, apiBase: 'http://api.github.example' }), failsWith('invalid_code_host_config'), 'plain http only to loopback')
  assert.throws(() => create({ ...config, remoteUrl: 'https://x-access-token:secret@github.com/acme/widgets.git' }), failsWith('invalid_code_host_config'))
  assert.throws(() => create({ ...config, remoteUrl: '/tmp/somewhere' }), failsWith('invalid_code_host_config'))
  let project = database.createProject({ slug: 'widgets', name: 'Widgets', codeHost: 'github', codeHostConfig: { ...config, repositoryPath: '/etc' }, repositoryPath: '/etc', members: [{ actorId: alice.id, role: 'developer' }, { actorId: bob.id, role: 'reviewer' }] }, owner.id)
  assert.equal(project.repositoryPath, join(dataDirectory, 'repositories', `${project.id}.git`), 'the working repository is always the managed clone')
  assert.deepEqual([project.codeHostConfig.tokenEnv, project.mergeMode, project.defaultBranch], [TOKEN_ENV, 'control_plane', 'main'])
  assert.equal(database.listActors().some((actor) => actor.id === SYSTEM_CODE_HOST_ACTOR_ID), false, 'the code-host actor is not a team member')
  assert.throws(() => database.setProjectMember({ projectId: project.id, actorId: SYSTEM_CODE_HOST_ACTOR_ID, role: 'reviewer' }, owner.id))

  // --- No token: connection says so, and nothing reaches the host. ---
  delete process.env[TOKEN_ENV]
  const missing = await hostOf(project).testConnection()
  assert.deepEqual([missing.ok, missing.credentialPresent], [false, false])
  assert.throws(() => hostOf(project).prepareForRun(), failsWith('code_host_credential_missing'))
  assert.equal((await syncer.syncProject(project.id)).errors[0]?.code, 'code_host_credential_missing')
  process.env[TOKEN_ENV] = 'ghp_wrong'
  const unauthorized = await hostOf(project).testConnection()
  assert.deepEqual([unauthorized.ok, unauthorized.repositoryReachable], [false, false])
  assert.match(unauthorized.message, /401/u)
  process.env[TOKEN_ENV] = TOKEN
  pushAllowed = false
  assert.deepEqual((await hostOf(project).testConnection()).missingPermissions, ['contents:write'])
  pushAllowed = true
  const connection = await hostOf(project).testConnection()
  assert.deepEqual([connection.ok, connection.repositoryReachable, connection.defaultBranchFound, connection.credentialPresent], [true, true, true, true])
  assert.equal(JSON.stringify(connection).includes(TOKEN), false)

  // --- The managed clone follows the host's main. ---
  hostOf(project).prepareForRun()
  const clone = project.repositoryPath!
  assert.equal(git(clone, 'rev-parse', 'refs/heads/main'), remoteSha('main'))
  assert.equal(git(clone, 'config', '--get', 'remote.origin.url'), `file://${remote}`)
  // A clone made while the project was misconfigured is repointed on the next run instead of fetching the old address.
  git(clone, 'remote', 'set-url', 'origin', 'https://github.example/u2pia/bankingkyc/u2pia.cc/bankingkyc.git')
  hostOf(project).prepareForRun()
  assert.equal(git(clone, 'config', '--get', 'remote.origin.url'), `file://${remote}`)

  /** What a run leaves behind: its branch in the managed clone, and a proposal that names the run. */
  const intentCriteria = [{ statement: 'unit suite passes', criticality: 'critical' as const, verificationType: 'deterministic' as const }]
  function runProposal(branch: string) {
    branchOnSeed(branch, `${branch.replaceAll('/', '-')}.txt`)
    git(seed, 'push', '--quiet', '--force', clone, `${branch}:refs/heads/${branch}`)
    const workItem = database.createWorkItem({ title: `Change ${branch}`, description: branch, ownerActorId: alice.id, projectId: project.id }, owner.id)
    const intent = database.createIntentVersion({ workItemId: workItem.id, goal: `Deliver ${branch}`, constraints: [], riskLevel: 'low', acceptanceCriteria: intentCriteria }, owner.id)
    return authority.createChangeProposal({ workItemId: workItem.id, intentVersionId: intent.id, runId: `RUN-${branch}`, baseRef: 'main', headRef: branch, authorActorId: alice.id }, alice.id)
  }
  function makeReady(proposalId: string) {
    const proposal = database.getChangeProposal(proposalId)
    database.recordCheck({ proposalId, headSha: proposal.headSha, name: 'unit', status: 'completed', conclusion: 'success' }, owner.id)
    const evidence = database.recordEvidence({ proposalId, runId: proposal.runId!, headSha: proposal.headSha, uri: `local://evidence/${proposalId}.json`, sha256: `sha256:${proposalId}`, summary: {} }, owner.id)
    database.recordEvidenceView(evidence.id, bob.id, evidence.sha256)
  }
  const approve = (proposalId: string) => database.recordReview({ proposalId, headSha: database.getChangeProposal(proposalId).headSha, reviewerActorId: bob.id, decision: 'approved', comment: 'checked' })
  const linkOf = (proposalId: string) => database.getCodeHostLink(proposalId)!
  const pullOf = (proposalId: string) => pulls[Number(linkOf(proposalId).externalId) - 1]

  // --- Publishing: the proposal's head goes to a branch the platform owns and a pull request opens against main. ---
  const first = runProposal('agent/run-a')
  const firstReport = await syncer.syncProject(project.id)
  assert.deepEqual([firstReport.published, firstReport.gateUpdates, firstReport.errors], [1, 1, []])
  const publishedRef = `aperture/${first.id.toLowerCase()}`
  assert.deepEqual([linkOf(first.id).publishedRef, linkOf(first.id).state, remoteSha(publishedRef)], [publishedRef, 'open', first.headSha])
  assert.deepEqual([pullOf(first.id).head, pullOf(first.id).base], [publishedRef, 'main'])
  assert.equal(linkOf(first.id).url, 'https://github.example/acme/widgets/pull/1')
  assert.equal(gateOf(first.headSha)?.state, 'pending', 'an unreviewed proposal holds the gate')
  assert.equal(database.listAggregateEvents('change_proposal', first.id).filter((event) => event.eventType === 'change_proposal.published_to_host').length, 1)
  const quiet = await syncer.syncProject(project.id)
  assert.deepEqual([quiet.published, quiet.gateUpdates, quiet.checksImported], [0, 0, 0], 'nothing changed, nothing is written')

  // --- GitHub's checks become independent evidence, recorded as the code-host actor. ---
  checkRuns.set(first.headSha, [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'build', status: 'completed', conclusion: 'failure' }])
  commitStatuses.set(first.headSha, [{ context: 'lint', state: 'pending' }])
  makeReady(first.id)
  approve(first.id)
  assert.equal(database.getChangeProposal(first.id).status, 'approved')
  const imported = await syncer.syncProject(project.id)
  assert.equal(imported.checksImported, 2)
  const readiness = database.getReviewReadiness(first.id)
  const byName = new Map(readiness.checks.map((check) => [check.name, check]))
  assert.deepEqual([byName.get('github/build')?.conclusion, byName.get('github/lint')?.status, byName.get('github/build')?.source], ['success', 'in_progress', 'external'], 'the newest check run for a name counts')
  assert.equal(byName.has('github/aperture/gate'), false, 'the platform does not import its own gate')
  const checkEvent = database.listAggregateEvents('change_proposal', first.id).findLast((event) => event.eventType === 'check.recorded' || event.eventType.startsWith('check'))
  assert.equal(checkEvent?.actorId, SYSTEM_CODE_HOST_ACTOR_ID)
  assert.notEqual(readiness.status, 'ready', 'a pending GitHub check holds readiness')
  assert.equal(gateOf(first.headSha)?.state, 'pending')
  assert.match(gateOf(first.headSha)!.description, /^Approved; waiting for evidence/u)
  commitStatuses.set(first.headSha, [{ context: 'lint', state: 'success' }])
  const green = await syncer.syncProject(project.id)
  assert.deepEqual([green.checksImported, green.gateUpdates], [1, 1])
  assert.equal(database.getReviewReadiness(first.id).status, 'ready')
  assert.equal(gateOf(first.headSha)?.state, 'success', 'approved with complete evidence opens the gate')
  // GitHub merges on the gate alone, so the gate carries the local merge's audit-trail check: an approval row with no
  // event behind it closes it.
  database.db.prepare("INSERT INTO review_decisions(id, change_proposal_id, head_sha, reviewer_actor_id, decision, comment, created_at) VALUES ('REV-FORGED', ?, ?, ?, 'approved', 'forged', ?)").run(first.id, first.headSha, owner.id, new Date().toISOString())
  await syncer.syncProject(project.id)
  assert.equal(gateOf(first.headSha)?.state, 'failure', 'a forged approval closes the gate')
  assert.match(gateOf(first.headSha)!.description, /Audit trail altered/u)
  database.db.exec("DROP TRIGGER review_decisions_no_delete; DELETE FROM review_decisions WHERE id = 'REV-FORGED'; CREATE TRIGGER review_decisions_no_delete BEFORE DELETE ON review_decisions BEGIN SELECT RAISE(ABORT, 'review_decisions are append-only'); END;")
  await syncer.syncProject(project.id)
  assert.equal(gateOf(first.headSha)?.state, 'success')

  // --- HTTP: people cannot report github/ checks; links and sync are served per project. ---
  const handler = createControlPlaneRequestHandler({ database, codeHostSyncer: syncer, agentRunner: new LocalCommandAgentRunner({ database, executable: process.execPath, args: ['-e', ''], worktreeRoot: join(dataDirectory, 'agent-runs'), timeoutMs: 10_000 }) })
  async function call<T = Record<string, any>>(path: string, input: { cookie?: string; body?: Record<string, unknown> } = {}) {
    const payload = input.body ? JSON.stringify(input.body) : ''
    const headers: IncomingHttpHeaders = { ...(input.cookie ? { cookie: input.cookie } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) }
    const requestStream = Readable.from(payload ? [Buffer.from(payload)] : []) as IncomingMessage
    Object.assign(requestStream, { method: input.body ? 'POST' : 'GET', url: path, headers })
    const chunks: Buffer[] = []
    let status = 200
    let responseHeaders: Record<string, string | number | string[]> = {}
    const responseStream = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } }) as ServerResponse
    responseStream.writeHead = ((statusCode: number, nextHeaders?: Record<string, string | number | string[]>) => {
      status = statusCode
      responseHeaders = nextHeaders ?? {}
      return responseStream
    }) as ServerResponse['writeHead']
    const finished = once(responseStream, 'finish')
    await handler(requestStream, responseStream)
    await finished
    const setCookie = responseHeaders['set-cookie']
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : typeof setCookie === 'string' ? setCookie : undefined)?.split(';')[0]
    const text = Buffer.concat(chunks).toString('utf8')
    return { status, cookie, body: (text ? JSON.parse(text) : undefined) as T }
  }
  const login = async (username: string) => (await call('/api/auth/login', { body: { username, password: `${username}-password-2026` } })).cookie!
  const ownerCookie = await login('owner')
  const bobCookie = await login('bob')
  const reserved = await call(`/api/change-proposals/${first.id}/checks`, { cookie: ownerCookie, body: { headSha: first.headSha, name: 'github/build', status: 'completed', conclusion: 'success' } })
  assert.deepEqual([reserved.status, reserved.body.error.code], [400, 'check_name_reserved'])
  const listed = await call<{ changeProposals: unknown[]; codeHostLinks: Array<{ changeProposalId: string; url: string }> }>(`/api/change-proposals?projectId=${project.id}`, { cookie: bobCookie })
  assert.equal(listed.body.codeHostLinks.find((link) => link.changeProposalId === first.id)?.url, linkOf(first.id).url)
  assert.equal((await call(`/api/projects/${project.id}/sync`, { cookie: bobCookie, body: {} })).status, 403, 'a reviewer cannot trigger a sync')
  const viaHttp = await call<{ report: { errors: unknown[] } }>(`/api/projects/${project.id}/sync`, { cookie: ownerCookie, body: {} })
  assert.deepEqual([viaHttp.status, viaHttp.body.report.errors], [200, []])
  assert.equal((await call<{ lastSync: { projectId: string } }>(`/api/projects/${project.id}`, { cookie: ownerCookie })).body.lastSync.projectId, project.id)
  const tested = await call<{ connection: { ok: boolean } }>(`/api/projects/${project.id}/test-connection`, { cookie: ownerCookie, body: {} })
  assert.equal(tested.body.connection?.ok ?? tested.status, true)

  // --- control_plane: the push is leased on the reviewed base; a moved remote is refused and nothing is recorded. ---
  const baseBefore = first.baseSha
  const hotfix = branchOnSeed('hotfix', 'hotfix.txt')
  git(seed, 'push', '--quiet', 'origin', `${hotfix}:refs/heads/main`)
  assert.throws(() => authority.mergeChangeProposal(first.id, owner.id), failsWith('remote_base_moved'))
  assert.deepEqual([git(clone, 'rev-parse', 'refs/heads/main'), database.getChangeProposal(first.id).status, database.getMergeEvidenceOptional(first.id)], [baseBefore, 'approved', undefined], 'the local branch is rolled back and the proposal stays approved')
  git(remote, 'update-ref', 'refs/heads/main', baseBefore)
  const merged = authority.mergeChangeProposal(first.id, owner.id)
  assert.deepEqual([merged.evidence.strategy, remoteSha('main'), merged.proposal.status], ['fast_forward', first.headSha, 'merged'], 'the approved head is pushed to the host')
  const afterPush = await syncer.syncProject(project.id)
  assert.deepEqual([afterPush.merged, linkOf(first.id).state, pullOf(first.id).merged], [0, 'merged', true], 'GitHub sees the pushed merge; the platform already recorded it')

  // Branch protection refusing the push is its own error, and is rolled back too.
  const second = runProposal('agent/run-b')
  await syncer.syncProject(project.id)
  makeReady(second.id)
  approve(second.id)
  await syncer.syncProject(project.id)
  assert.equal(gateOf(second.headSha)?.state, 'success')
  const hook = join(remote, 'hooks', 'pre-receive')
  writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do if [ "$ref" = "refs/heads/main" ]; then echo "GH006: Protected branch update failed for refs/heads/main." >&2; exit 1; fi; done\n')
  chmodSync(hook, 0o755)
  assert.throws(() => authority.mergeChangeProposal(second.id, owner.id), failsWith('host_rejected_push'))
  assert.deepEqual([git(clone, 'rev-parse', 'refs/heads/main'), remoteSha('main'), database.getChangeProposal(second.id).status], [second.baseSha, first.headSha, 'approved'])
  rmSync(hook)

  // --- host_protected: GitHub merges, the platform records what it merged and whether the gate allowed it. ---
  project = database.updateProjectSettings(project.id, { mergeMode: 'host_protected' }, owner.id)
  assert.throws(() => authority.mergeChangeProposal(second.id, owner.id), failsWith('merge_on_host'))
  // Someone lands an unrelated change first, so the squash is not the approved tree — only the approved patch.
  const unrelated = branchOnSeed('unrelated', 'unrelated.txt')
  git(seed, 'push', '--quiet', 'origin', `${unrelated}:refs/heads/main`)
  mergeOnHost(Number(linkOf(second.id).externalId), 'squash')
  const squashed = await syncer.syncProject(project.id)
  assert.deepEqual([squashed.merged, squashed.errors], [1, []])
  const hostEvidence = database.getMergeEvidence(second.id)
  assert.deepEqual([hostEvidence.strategy, hostEvidence.mergedSha, hostEvidence.mergedByActorId], ['host_merge', remoteSha('main'), SYSTEM_CODE_HOST_ACTOR_ID])
  assert.deepEqual([hostEvidence.hostMerge?.contentCheck, hostEvidence.hostMerge?.gateStateAtMerge, hostEvidence.hostMerge?.outsideGate, hostEvidence.hostMerge?.mergedBy], ['patch_equal', 'success', false, 'octocat'], 'a squash of the approved change behind a green gate is inside the gate')
  assert.equal(git(clone, 'rev-parse', 'refs/heads/main'), remoteSha('main'), 'the managed clone follows the merge')
  assert.deepEqual([database.getChangeProposal(second.id).status, linkOf(second.id).state], ['merged', 'merged'])
  assert.equal(database.listAggregateEvents('change_proposal', second.id).some((event) => event.eventType === 'change_proposal.merged_outside_gate'), false)

  // A merge the gate did not allow — unreviewed, a failing check, and an extra commit pushed to the pull request.
  const third = runProposal('agent/run-c')
  checkRuns.set(third.headSha, [{ name: 'build', status: 'completed', conclusion: 'timed_out' }])
  await syncer.syncProject(project.id)
  await syncer.syncProject(project.id)
  assert.equal(database.getReviewReadiness(third.id).checks.find((check) => check.name === 'github/build')?.conclusion, 'failure')
  assert.equal(gateOf(third.headSha)?.state, 'failure', 'a failing GitHub check fails the gate')
  git(seed, 'fetch', '--quiet', 'origin')
  git(seed, 'checkout', '--quiet', '-B', 'sneak', `origin/aperture/${third.id.toLowerCase()}`)
  writeFileSync(join(seed, 'sneak.txt'), 'not reviewed\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '--quiet', '-m', 'sneak')
  git(seed, 'push', '--quiet', 'origin', `sneak:refs/heads/aperture/${third.id.toLowerCase()}`)
  mergeOnHost(Number(linkOf(third.id).externalId), 'merge')
  await syncer.syncProject(project.id)
  const outside = database.getMergeEvidence(third.id).hostMerge!
  assert.deepEqual([outside.outsideGate, outside.contentCheck, outside.gateStateAtMerge], [true, 'ancestor', 'failure'])
  assert.ok(outside.outsideGateReasons.some((reason) => reason.includes('not approved')))
  assert.ok(outside.outsideGateReasons.some((reason) => reason.startsWith('pull request head was')), 'the extra commit is named')
  assert.ok(outside.outsideGateReasons.some((reason) => reason.startsWith('evidence readiness was')))
  const flagged = database.listAggregateEvents('change_proposal', third.id).find((event) => event.eventType === 'change_proposal.merged_outside_gate')
  assert.deepEqual([flagged?.actorId, flagged?.payload.mergedBy], [SYSTEM_CODE_HOST_ACTOR_ID, 'octocat'])

  // --- host_protected, merged from the platform: the server asks GitHub's API with its token; nobody opens GitHub. ---
  const fourth = runProposal('agent/run-d')
  await syncer.syncProject(project.id)
  const hostMergePath = `/api/change-proposals/${fourth.id}/host-merge`
  assert.deepEqual((await call(hostMergePath, { cookie: ownerCookie, body: {} })).body.error.code, 'merge_not_approved')
  makeReady(fourth.id)
  approve(fourth.id)
  assert.equal((await call(hostMergePath, { cookie: bobCookie, body: {} })).status, 403, 'a reviewer cannot merge')
  mergeRefusal = 'Required status check "ci" is expected.'
  const refused = await call(hostMergePath, { cookie: ownerCookie, body: {} })
  assert.deepEqual([refused.status, refused.body.error.code], [409, 'host_merge_refused'])
  assert.match(refused.body.error.message, /Required status check "ci" is expected/u, "GitHub's reason reaches the reviewer")
  assert.deepEqual([database.getChangeProposal(fourth.id).status, database.getMergeEvidenceOptional(fourth.id)], ['approved', undefined], 'a refused merge records nothing')
  assert.equal(gateOf(fourth.headSha)?.state, 'success', 'the gate was published before GitHub was asked')
  mergeRefusal = undefined
  allowedMergeMethods = ['squash']
  const viaApi = await call<{ evidence: { strategy: string; mergedSha: string; mergedByActorId: string; hostMerge: { requestedVia?: string; mergedBy?: string; outsideGate: boolean; contentCheck: string } } }>(hostMergePath, { cookie: ownerCookie, body: {} })
  assert.equal(viaApi.status, 201, JSON.stringify(viaApi.body))
  assert.deepEqual([viaApi.body.evidence.strategy, viaApi.body.evidence.mergedSha, viaApi.body.evidence.mergedByActorId], ['host_merge', remoteSha('main'), owner.id], 'merged on GitHub, recorded as the person who asked')
  assert.deepEqual([viaApi.body.evidence.hostMerge.requestedVia, viaApi.body.evidence.hostMerge.mergedBy, viaApi.body.evidence.hostMerge.outsideGate, viaApi.body.evidence.hostMerge.contentCheck], ['control_plane', 'aperture-bot', false, 'tree_equal'], 'a repository that only squashes is merged by squash')
  const mergedEvent = database.listAggregateEvents('change_proposal', fourth.id).findLast((event) => event.eventType === 'change_proposal.merged')
  assert.deepEqual([mergedEvent?.actorId, (mergedEvent?.payload.identity as { login?: string } | undefined)?.login], [owner.id, 'owner'])
  assert.deepEqual([database.getChangeProposal(fourth.id).status, linkOf(fourth.id).state], ['merged', 'merged'])
  assert.equal((await syncer.syncProject(project.id)).merged, 0, 'the next sync does not record it again')
  assert.equal((await call(hostMergePath, { cookie: ownerCookie, body: {} })).status, 200, 'asking again is a no-op')
  allowedMergeMethods = ['merge', 'squash', 'rebase']

  // --- A proposal opened by hand from a branch pushed to GitHub, then closed there. ---
  branchOnSeed('feature/manual', 'manual.txt')
  git(seed, 'push', '--quiet', 'origin', 'feature/manual')
  const manualWork = database.createWorkItem({ title: 'Manual', description: 'manual', ownerActorId: alice.id, projectId: project.id }, owner.id)
  const manualIntent = database.createIntentVersion({ workItemId: manualWork.id, goal: 'Manual change', constraints: [], riskLevel: 'low', acceptanceCriteria: intentCriteria }, owner.id)
  const manualInput = { workItemId: manualWork.id, intentVersionId: manualIntent.id, baseRef: 'main', headRef: 'feature/manual', authorActorId: alice.id }
  delete process.env[TOKEN_ENV]
  assert.throws(() => authority.createChangeProposal(manualInput, alice.id), failsWith('code_host_credential_missing'))
  process.env[TOKEN_ENV] = TOKEN
  const manual = authority.createChangeProposal(manualInput, alice.id)
  assert.equal(manual.headSha, remoteSha('feature/manual'), 'the branch is fetched from the host')
  await syncer.syncProject(project.id)
  pullOf(manual.id).state = 'closed'
  const closing = await syncer.syncProject(project.id)
  assert.equal(closing.closed, 1)
  assert.equal(database.getChangeProposal(manual.id).status, 'closed')
  assert.equal(linkOf(manual.id).state, 'closed')
  const rejection = database.listAggregateEvents('change_proposal', manual.id).findLast((event) => event.eventType === 'decision.rejected')
  assert.deepEqual([rejection?.actorId, rejection?.payload.source], [SYSTEM_CODE_HOST_ACTOR_ID, 'closed_on_host'])
  assert.match(String(rejection?.payload.reason), /^closed_on_host: https:\/\/github\.example\/acme\/widgets\/pull\/\d+$/u)
  assert.deepEqual(database.listSyncableProposals(project.id), [], 'nothing is left to sync')

  // --- The token is nowhere on disk: not the database, its WAL, the managed clone, or anything else we wrote. ---
  database.close?.()
  const needles = [TOKEN, Buffer.from(`x-access-token:${TOKEN}`).toString('base64')]
  const scan = (path: string): string[] => statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => scan(join(path, name))) : needles.some((needle) => readFileSync(path).includes(needle)) ? [path] : []
  assert.deepEqual(scan(dataDirectory), [], 'no file under the data directory holds the token')
  assert.ok(requests > 10, 'the fake GitHub was exercised')
  console.log(`github code host smoke passed (${pulls.length} pull requests, ${requests} API calls, host_protected merge through the API)`)
} finally {
  fake.close()
  rmSync(root, { recursive: true, force: true })
}
