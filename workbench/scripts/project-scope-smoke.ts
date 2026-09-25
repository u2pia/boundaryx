import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ControlPlaneDatabase, DEFAULT_PROJECT_ID } from '../server/database.ts'
import { createControlPlaneRequestHandler } from '../server/http-server.ts'
import { LocalCommandAgentRunner } from '../server/local-command-agent-runner.ts'
import { LocalGitAuthority } from '../server/local-git-authority.ts'
import { AppError } from '../server/types.ts'
import { createLocalProject } from './fixtures.ts'

// A project is one repository and the unit of access. A non-member cannot see a project's work or learn it exists, the
// same person can hold different roles in different projects, reviewers are picked from the project's members, and the
// repository comes from the project — never from the browser.
const root = mkdtempSync(join(tmpdir(), 'aperture-project-scope-'))
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')
const failsWith = (code: string) => (error: unknown) => error instanceof AppError && error.code === code

function repository(name: string, branches: string[] = []) {
  const path = join(root, name)
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim()
  mkdirSync(path)
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', path])
  git('config', 'user.name', 'Aperture Test')
  git('config', 'user.email', 'aperture@example.test')
  writeFileSync(join(path, 'README.md'), `# ${name}\n`)
  git('add', 'README.md')
  git('commit', '--quiet', '-m', 'initial')
  for (const branch of branches) {
    git('checkout', '--quiet', '-b', branch, 'main')
    writeFileSync(join(path, `${branch.replaceAll('/', '-')}.txt`), `${branch}\n`)
    git('add', '.')
    git('commit', '--quiet', '-m', branch)
    git('checkout', '--quiet', 'main')
  }
  return realpathSync(path)
}

const alphaRepository = repository('alpha', ['agent/alpha-1', 'agent/alpha-2'])
const betaRepository = repository('beta', ['agent/beta-1'])
const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), migrationDirectory)
const authority = new LocalGitAuthority(database)

try {
  const owner = database.createActor({ username: 'owner', displayName: 'Owner', role: 'owner', password: 'owner-password-2026' })
  const alice = database.createActor({ username: 'alice', displayName: 'Alice', role: 'developer', password: 'alice-password-2026', projectIds: [] }, owner.id)
  const bob = database.createActor({ username: 'bob', displayName: 'Bob', role: 'reviewer', password: 'bob-password-2026', projectIds: [] }, owner.id)
  const carol = database.createActor({ username: 'carol', displayName: 'Carol', role: 'reviewer', password: 'carol-password-2026', projectIds: [] }, owner.id)

  // --- An owner edits an existing member; the owner role is fixed, and disabling or a reset ends the member's sessions. ---
  const dave = database.createActor({ username: 'dave', displayName: 'Dave', role: 'developer', password: 'dave-password-2026', projectIds: [] }, owner.id)
  const daveSession = database.createSession(dave.id)
  assert.deepEqual((({ displayName, role }) => [displayName, role])(database.updateActor(dave.id, { displayName: 'Dave K', role: 'reviewer' }, owner.id)), ['Dave K', 'reviewer'])
  assert.ok(database.getSession(daveSession.token), 'a rename or role change keeps the member signed in')
  assert.throws(() => database.updateActor(owner.id, { role: 'developer' }, owner.id), failsWith('owner_role_fixed'))
  assert.throws(() => database.updateActor(dave.id, { role: 'owner' }, owner.id), failsWith('owner_role_fixed'))
  assert.throws(() => database.updateActor(owner.id, { status: 'disabled' }, owner.id), failsWith('cannot_disable_self'))
  assert.throws(() => database.updateActor(dave.id, { password: 'short' }, owner.id), failsWith('invalid_password'))
  assert.throws(() => database.updateActor(dave.id, {}, owner.id), failsWith('no_change'))
  database.updateActor(dave.id, { password: 'dave-new-password-2026' }, owner.id)
  assert.equal(database.getSession(daveSession.token), null, 'a reset by the owner signs the member out')
  assert.throws(() => database.authenticate('dave', 'dave-password-2026'), failsWith('invalid_credentials'))
  const daveAgain = database.createSession(database.authenticate('dave', 'dave-new-password-2026').id)
  database.updateActor(dave.id, { status: 'disabled' }, owner.id)
  assert.equal(database.getSession(daveAgain.token), null, 'disabling ends open sessions')
  assert.throws(() => database.authenticate('dave', 'dave-new-password-2026'), failsWith('invalid_credentials'))
  database.updateActor(dave.id, { status: 'active' }, owner.id)
  const daveEvents = database.listAggregateEvents('actor', dave.id).filter((event) => event.eventType === 'actor.updated')
  assert.equal(daveEvents.length, 4)
  assert.ok(daveEvents.every((event) => event.actorId === owner.id && !JSON.stringify(event.payload).includes('dave-new-password-2026')), 'each edit is the owner\'s decision and no event carries the password')

  // --- Configuring projects is an owner decision, and the local path is validated before it is stored. ---
  assert.throws(() => createLocalProject(database, { slug: 'nope', ownerActorId: alice.id }), failsWith('project_admin_forbidden'))
  assert.throws(() => createLocalProject(database, { slug: 'Bad Slug', ownerActorId: owner.id }), failsWith('invalid_project_slug'))
  assert.throws(() => createLocalProject(database, { slug: 'relative', repositoryPath: 'alpha', ownerActorId: owner.id }), failsWith('repository_path_not_absolute'))
  assert.throws(() => createLocalProject(database, { slug: 'missing', repositoryPath: join(root, 'missing'), ownerActorId: owner.id }), failsWith('invalid_repository'))
  mkdirSync(join(root, 'plain'))
  assert.throws(() => createLocalProject(database, { slug: 'plain', repositoryPath: join(root, 'plain'), ownerActorId: owner.id }), failsWith('invalid_repository'))
  assert.throws(() => createLocalProject(database, { slug: 'branch', repositoryPath: alphaRepository, defaultBranch: 'trunk', ownerActorId: owner.id }), failsWith('default_branch_not_found'))
  assert.throws(() => createLocalProject(database, { slug: 'dotdot', repositoryPath: alphaRepository, defaultBranch: 'a..b', ownerActorId: owner.id }), failsWith('invalid_default_branch'))
  mkdirSync(join(root, 'agent-runs'))
  cpSync(alphaRepository, join(root, 'agent-runs', 'inside'), { recursive: true })
  assert.throws(() => createLocalProject(database, { slug: 'inside', repositoryPath: join(root, 'agent-runs', 'inside'), ownerActorId: owner.id }), failsWith('repository_inside_data_directory'))
  assert.throws(() => database.createProject({ slug: 'hosted', name: 'hosted', codeHost: 'local', repositoryPath: alphaRepository, mergeMode: 'host_protected' }, owner.id), failsWith('merge_mode_unsupported'))

  // Alice develops in alpha and reviews in beta; Bob reviews alpha only; Carol reviews beta only.
  const alpha = createLocalProject(database, { slug: 'alpha', repositoryPath: join(root, 'alpha', '.'), ownerActorId: owner.id, members: [{ actorId: alice.id, role: 'developer' }, { actorId: bob.id, role: 'reviewer' }] })
  assert.equal(alpha.repositoryPath, alphaRepository, 'the stored path is the canonical top level')
  const beta = createLocalProject(database, { slug: 'beta', repositoryPath: betaRepository, ownerActorId: owner.id, members: [{ actorId: alice.id, role: 'reviewer' }] })
  assert.throws(() => createLocalProject(database, { slug: 'alpha', repositoryPath: alphaRepository, ownerActorId: owner.id }), failsWith('project_slug_taken'))
  const carolMember = database.setProjectMember({ projectId: beta.id, actorId: carol.id, role: 'reviewer' }, owner.id)
  assert.equal(carolMember.role, 'reviewer')
  const memberEvent = database.listAggregateEvents('project', beta.id).findLast((event) => event.eventType === 'project.member_added')
  assert.deepEqual([memberEvent?.payload.actorId, memberEvent?.payload.identity.login, memberEvent?.projectId ?? beta.id], [carol.id, 'owner', beta.id], 'granting a role records who granted it')
  assert.throws(() => database.setProjectMember({ projectId: beta.id, actorId: owner.id, role: 'reviewer' }, owner.id), failsWith('owner_is_implicit_member'))
  assert.throws(() => database.setProjectMember({ projectId: beta.id, actorId: bob.id, role: 'reviewer' }, alice.id), failsWith('project_admin_forbidden'))

  assert.deepEqual(new Set(database.visibleProjectIds(owner.id)), new Set([DEFAULT_PROJECT_ID, alpha.id, beta.id]), 'an owner sees every project')
  // Everyone is in the default project, which holds the sample data, on top of the projects they were given.
  assert.deepEqual(new Set(database.visibleProjectIds(alice.id)), new Set([DEFAULT_PROJECT_ID, alpha.id, beta.id]))
  assert.deepEqual(new Set(database.visibleProjectIds(bob.id)), new Set([DEFAULT_PROJECT_ID, alpha.id]))
  assert.throws(() => database.removeProjectMember({ projectId: DEFAULT_PROJECT_ID, actorId: bob.id }, owner.id), failsWith('default_project_member_fixed'))
  assert.throws(() => database.archiveProject(DEFAULT_PROJECT_ID, owner.id), failsWith('default_project_fixed'))
  assert.equal(database.setProjectMember({ projectId: DEFAULT_PROJECT_ID, actorId: bob.id, role: 'reviewer' }, owner.id).role, 'reviewer', 'the role there can still change')
  assert.deepEqual([database.projectRole(alice.id, alpha.id), database.projectRole(alice.id, beta.id), database.projectRole(bob.id, beta.id)], ['developer', 'reviewer', undefined])

  // --- The repository comes from the work item's project. ---
  const proposalIn = (projectId: string, headRef: string, authorActorId: string) => {
    const workItem = database.createWorkItem({ title: headRef, description: headRef, ownerActorId: authorActorId, projectId }, owner.id)
    const intent = database.createIntentVersion({ workItemId: workItem.id, goal: headRef, constraints: [], riskLevel: 'low', acceptanceCriteria: [{ statement: 'unit suite passes', criticality: 'critical', verificationType: 'deterministic' }] }, owner.id)
    return { workItem, intent, proposal: authority.createChangeProposal({ workItemId: workItem.id, intentVersionId: intent.id, runId: `RUN-${headRef}`, baseRef: 'main', headRef, authorActorId }, authorActorId) }
  }
  const alphaWork = proposalIn(alpha.id, 'agent/alpha-1', alice.id)
  assert.deepEqual([alphaWork.proposal.projectId, alphaWork.proposal.repositoryPath, alphaWork.workItem.projectId], [alpha.id, alphaRepository, alpha.id])
  const betaWork = proposalIn(beta.id, 'agent/beta-1', owner.id)
  assert.equal(betaWork.proposal.repositoryPath, betaRepository)
  assert.throws(() => authority.createChangeProposal({ workItemId: alphaWork.workItem.id, intentVersionId: alphaWork.intent.id, repositoryPath: betaRepository, baseRef: 'main', headRef: 'agent/beta-1', authorActorId: alice.id }, alice.id), failsWith('repository_project_mismatch'), 'no caller can point a project\'s work at another repository')
  assert.throws(() => database.createWorkItem({ title: 'x', description: 'x', ownerActorId: bob.id, projectId: beta.id }, bob.id), failsWith('project_not_found'), 'a non-member cannot create work in the project')
  assert.throws(() => proposalIn(DEFAULT_PROJECT_ID, 'agent/alpha-2', owner.id), failsWith('project_repository_unconfigured'))

  // Events carry their project.
  assert.equal(database.listEvents(500, [beta.id]).filter((event) => event.aggregateType === 'change_proposal').every((event) => event.aggregateId === betaWork.proposal.id), true)
  assert.equal(database.listEvents(500, [alpha.id]).some((event) => event.aggregateId === betaWork.proposal.id), false)

  // --- Roles are per project: Alice reviews in beta but not in alpha; reviewers are picked from members only. ---
  assert.throws(() => database.assignReviewer({ proposalId: betaWork.proposal.id, assigneeActorId: bob.id }, owner.id), failsWith('assignee_not_reviewer'), 'Bob reviews alpha, not beta')
  assert.deepEqual(new Set(database.listReviewerLoad(beta.id).map((item) => item.actorId)), new Set([owner.id, alice.id, carol.id]))
  const picked = database.assignReviewer({ proposalId: betaWork.proposal.id }, owner.id)
  assert.ok([alice.id, carol.id].includes(picked.assigneeActorId), 'load balancing picks a beta reviewer')
  database.recordCheck({ proposalId: betaWork.proposal.id, headSha: betaWork.proposal.headSha, name: 'unit', status: 'completed', conclusion: 'success' }, owner.id)
  database.recordReview({ proposalId: betaWork.proposal.id, headSha: betaWork.proposal.headSha, reviewerActorId: picked.assigneeActorId, decision: 'approved', comment: 'ok' })
  assert.equal(database.getChangeProposal(betaWork.proposal.id).status, 'approved')
  assert.throws(() => database.assignReviewer({ proposalId: alphaWork.proposal.id, assigneeActorId: alice.id }, owner.id), failsWith('assignee_not_reviewer'), 'Alice reviews in beta but is a developer in alpha')
  assert.throws(() => database.assignReviewer({ proposalId: alphaWork.proposal.id, assigneeActorId: carol.id }, owner.id), failsWith('assignee_not_reviewer'))
  assert.throws(() => database.recordReview({ proposalId: alphaWork.proposal.id, headSha: alphaWork.proposal.headSha, reviewerActorId: carol.id, decision: 'commented', comment: 'hi' }), failsWith('project_not_found'))

  // Moving a project while work is open would strand that work.
  assert.throws(() => database.updateProjectSettings(alpha.id, { repositoryPath: betaRepository }, owner.id), failsWith('project_has_open_work'))
  assert.equal(database.updateProjectSettings(alpha.id, { description: 'renamed only' }, owner.id).description, 'renamed only', 'a change that does not move the repository is allowed')
  assert.throws(() => database.archiveProject(alpha.id, owner.id), failsWith('project_has_open_work'))

  // --- HTTP: lists are scoped, other projects' records are 404, and repositoryPath is refused. ---
  const handler = createControlPlaneRequestHandler({ database, agentRunner: new LocalCommandAgentRunner({ database, executable: process.execPath, args: ['-e', ''], worktreeRoot: join(root, 'agent-runs'), timeoutMs: 10_000 }) })
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
  const [ownerCookie, aliceCookie, bobCookie] = [await login('owner'), await login('alice'), await login('bob')]

  const bobProjects = await call<{ projects: Array<{ id: string }>; roles: Record<string, string> }>('/api/projects', { cookie: bobCookie })
  assert.deepEqual([bobProjects.body.projects.map((project) => project.id), bobProjects.body.roles], [[DEFAULT_PROJECT_ID, alpha.id], { [DEFAULT_PROJECT_ID]: 'reviewer', [alpha.id]: 'reviewer' }])
  const bobWorkItems = (await call<{ workItems: Array<{ id: string; projectId: string }> }>('/api/work-items', { cookie: bobCookie })).body.workItems
  assert.deepEqual(bobWorkItems.filter((item) => item.projectId !== DEFAULT_PROJECT_ID).map((item) => item.id), [alphaWork.workItem.id], 'beta stays hidden; the shared default project is visible')
  assert.equal((await call('/api/work-items?projectId=' + beta.id, { cookie: bobCookie })).body.error.code, 'project_not_found')
  for (const path of [`/api/work-items/${betaWork.workItem.id}`, `/api/change-proposals/${betaWork.proposal.id}`, `/api/projects/${beta.id}`]) {
    const response = await call(path, { cookie: bobCookie })
    assert.deepEqual([response.status, response.body.error.code], [404, 'project_not_found'], `${path} is invisible to a non-member`)
  }
  assert.equal((await call<{ changeProposals: unknown[] }>('/api/change-proposals', { cookie: bobCookie })).body.changeProposals.length, 1)
  assert.equal((await call<{ events: Array<{ aggregateId: string }> }>('/api/events', { cookie: bobCookie })).body.events.some((event) => event.aggregateId === betaWork.proposal.id), false)
  assert.deepEqual((await call<{ reviewerLoad: Array<{ actorId: string }> }>(`/api/reviews?projectId=${alpha.id}`, { cookie: bobCookie })).body.reviewerLoad.map((item) => item.actorId).sort(), [owner.id, bob.id].sort())
  assert.deepEqual((await call<{ decisions: unknown[] }>('/api/decisions', { cookie: bobCookie })).status, 200)

  const withPath = await call('/api/agent-runs', { cookie: aliceCookie, body: { workItemId: alphaWork.workItem.id, intentVersionId: alphaWork.intent.id, repositoryPath: '/etc', baseRef: 'main' } })
  assert.deepEqual([withPath.status, withPath.body.error.code], [400, 'repository_path_not_accepted'])
  const proposalWithPath = await call('/api/change-proposals', { cookie: aliceCookie, body: { workItemId: alphaWork.workItem.id, intentVersionId: alphaWork.intent.id, repositoryPath: alphaRepository, baseRef: 'main', headRef: 'agent/alpha-2' } })
  assert.equal(proposalWithPath.body.error.code, 'repository_path_not_accepted')
  const betaAsReviewer = await call('/api/change-proposals', { cookie: aliceCookie, body: { workItemId: betaWork.workItem.id, intentVersionId: betaWork.intent.id, headRef: 'agent/beta-1' } })
  assert.equal(betaAsReviewer.status, 403, 'Alice only reviews in beta, so she cannot author there')
  const missingProject = await call('/api/work-items', { cookie: aliceCookie, body: { title: 'x', description: 'x' } })
  assert.equal(missingProject.status, 400, 'a work item names its project')
  // A work item's product type is the project's, read from the manifest on its default branch.
  const unconfigured = await call('/api/work-items', { cookie: aliceCookie, body: { title: 'x', description: 'x', projectId: beta.id } })
  assert.deepEqual([unconfigured.status, unconfigured.body.error.code], [422, 'project_manifest_missing'], 'no Intent before the project says what it builds')
  mkdirSync(join(betaRepository, '.aperture'))
  writeFileSync(join(betaRepository, '.aperture/project.json'), JSON.stringify({ schemaVersion: 'aperture.project.v1', productType: 'application', context: { required: ['README.md'], allowed: ['README.md'] }, checks: [{ name: 'beta', kind: 'test', command: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 10_000 }], policy: { maximumRisk: 'high', allowUnisolatedRuntime: true } }))
  execFileSync('git', ['-C', betaRepository, 'add', '.aperture'])
  execFileSync('git', ['-C', betaRepository, 'commit', '--quiet', '-m', 'manifest'])
  assert.deepEqual((await call(`/api/projects/${beta.id}/product-type`, { cookie: aliceCookie })).body, { productType: 'application' })
  assert.equal((await call(`/api/projects/${beta.id}/product-type`, { cookie: bobCookie })).status, 404, 'a non-member cannot read it')
  const mismatched = await call('/api/work-items', { cookie: aliceCookie, body: { title: 'x', description: 'x', projectId: beta.id, productType: 'agent_system' } })
  assert.deepEqual([mismatched.status, mismatched.body.error.code], [409, 'work_item_product_type_mismatch'])
  const created = await call<{ workItem: { projectId: string; productType: string } }>('/api/work-items', { cookie: aliceCookie, body: { title: 'x', description: 'x', projectId: beta.id } })
  assert.deepEqual([created.body.workItem.projectId, created.body.workItem.productType], [beta.id, 'application'])

  const merge = await call(`/api/change-proposals/${betaWork.proposal.id}/merge`, { cookie: aliceCookie, body: { headSha: betaWork.proposal.headSha } })
  assert.equal(merge.status, 403, 'a project reviewer cannot merge')

  const madeByHttp = await call<{ project: { id: string; repositoryPath: string } }>('/api/projects', { cookie: ownerCookie, body: { slug: 'gamma', name: 'Gamma', repositoryPath: alphaRepository, members: [{ actorId: bob.id, role: 'developer' }] } })
  assert.equal(madeByHttp.status, 201)
  assert.equal((await call('/api/projects', { cookie: aliceCookie, body: { slug: 'delta', name: 'Delta' } })).status, 403)
  const connection = await call<{ connection: { ok: boolean } }>(`/api/projects/${madeByHttp.body.project.id}/test-connection`, { cookie: ownerCookie, body: {} })
  assert.equal(connection.body.connection.ok, true)
  const roleChange = await call(`/api/projects/${madeByHttp.body.project.id}/members`, { cookie: ownerCookie, body: { actorId: bob.id, role: 'maintainer' } })
  assert.equal(roleChange.body.member.role, 'maintainer')
  assert.equal(database.listAggregateEvents('project', madeByHttp.body.project.id).at(-1)?.eventType, 'project.member_role_changed')
  assert.equal((await call(`/api/projects/${madeByHttp.body.project.id}/members/${bob.id}/remove`, { cookie: ownerCookie, body: {} })).status, 204)
  assert.equal(database.projectRole(bob.id, madeByHttp.body.project.id), undefined)
  assert.equal((await call(`/api/projects/${madeByHttp.body.project.id}/archive`, { cookie: ownerCookie, body: {} })).body.project.status, 'archived')
  assert.throws(() => database.createWorkItem({ title: 'x', description: 'x', ownerActorId: owner.id, projectId: madeByHttp.body.project.id }, owner.id), failsWith('project_archived'))

  // Work items are numbered within their project, each project counting from 1.
  const alphaNext = database.createWorkItem({ title: 'second in alpha', description: 'd', ownerActorId: alice.id, projectId: alpha.id }, alice.id)
  assert.deepEqual([alphaWork.workItem.sequence, alphaNext.sequence, betaWork.workItem.sequence, database.getWorkItem(alphaNext.id).sequence], [1, 2, 1, 2])

  // --- Migration 019 on a database written before projects existed. ---
  const legacyRoot = join(root, 'legacy')
  const legacyMigrations = join(legacyRoot, 'migrations')
  mkdirSync(legacyMigrations, { recursive: true })
  for (const file of readdirSync(migrationDirectory).filter((name) => Number(name.split('_')[0]) < 19)) cpSync(join(migrationDirectory, file), join(legacyMigrations, file))
  const legacyPath = join(legacyRoot, 'control-plane.db')
  const legacy = new ControlPlaneDatabase(legacyPath, legacyMigrations)
  const now = new Date().toISOString()
  const insertActor = legacy.db.prepare('INSERT INTO actors(id, username, display_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  insertActor.run('ACT-O', 'o', 'O', 'owner', 'active', now)
  insertActor.run('ACT-R', 'r', 'R', 'reviewer', 'active', now)
  const insertWorkItem = legacy.db.prepare("INSERT INTO work_items(id, title, description, status, owner_actor_id, authority_provider, authority_ref, created_at, updated_at) VALUES (?, ?, ?, 'active', 'ACT-O', 'local', ?, ?, ?)")
  const insertIntent = legacy.db.prepare("INSERT INTO intent_versions(id, work_item_id, version, goal, constraints_json, risk_level, content_digest, created_by, created_at) VALUES (?, ?, 1, 'g', '[]', 'low', 'sha256:x', 'ACT-O', ?)")
  const insertProposal = legacy.db.prepare("INSERT INTO change_proposals(id, work_item_id, intent_version_id, repository_path, base_ref, base_sha, head_ref, head_sha, author_actor_id, status, changed_files, additions, deletions, created_at, updated_at) VALUES (?, ?, ?, ?, 'main', 'a', ?, 'b', 'ACT-O', 'review_ready', 1, 1, 0, ?, ?)")
  for (const [index, path] of [alphaRepository, betaRepository, alphaRepository].entries()) {
    insertWorkItem.run(`WI-${index}`, `w${index}`, 'd', `local:${index}`, now, now)
    insertIntent.run(`IV-${index}`, `WI-${index}`, now)
    insertProposal.run(`CP-${index}`, `WI-${index}`, `IV-${index}`, path, `agent/${index}`, now, now)
  }
  insertWorkItem.run('WI-orphan', 'orphan', 'd', 'local:orphan', now, now)
  // Past events get their project too, which is the one write the append-only guard has to let through.
  legacy.db.prepare("INSERT INTO domain_events(id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, payload_json, previous_event_digest, event_digest, occurred_at, recorded_at) VALUES ('EVT-L', 'change_proposal', 'CP-1', 1, 'change_proposal.created', 'ACT-O', '{}', 'genesis', 'sha256:x', ?, ?)").run(now, now)
  legacy.close()
  const upgraded = new ControlPlaneDatabase(legacyPath, migrationDirectory)
  const backfilled = upgraded.listProjects().filter((project) => project.id !== DEFAULT_PROJECT_ID)
  assert.deepEqual(backfilled.map((project) => [project.slug, project.repositoryPath]).sort(), [['alpha', alphaRepository], ['beta', betaRepository]].sort(), 'one project per repository')
  const projectOf = (repositoryPath: string) => backfilled.find((project) => project.repositoryPath === repositoryPath)!.id
  assert.deepEqual(['CP-0', 'CP-1', 'CP-2'].map((proposalId) => upgraded.getChangeProposal(proposalId).projectId), [projectOf(alphaRepository), projectOf(betaRepository), projectOf(alphaRepository)])
  assert.equal(upgraded.getWorkItem('WI-1').projectId, projectOf(betaRepository), 'work items follow their proposals')
  assert.equal(upgraded.getWorkItem('WI-orphan').projectId, DEFAULT_PROJECT_ID)
  assert.deepEqual(['WI-0', 'WI-2', 'WI-1', 'WI-orphan'].map((workItemId) => upgraded.getWorkItem(workItemId).sequence), [1, 2, 1, 1], 'existing work items are numbered per project in creation order')
  assert.deepEqual(backfilled.map((project) => upgraded.projectRole('ACT-R', project.id)), ['reviewer', 'reviewer'], 'existing members keep their access')
  assert.equal(upgraded.projectRole('ACT-O', projectOf(betaRepository)), 'owner')
  assert.equal((upgraded.db.prepare("SELECT role FROM project_members WHERE project_id = ? AND actor_id = 'ACT-R'").get(DEFAULT_PROJECT_ID) as { role: string } | undefined)?.role, 'reviewer', '022 puts existing members in the default project')
  assert.equal(upgraded.db.prepare("SELECT 1 FROM project_members WHERE actor_id = 'ACT-O'").get(), undefined, 'owners stay implicit members')
  assert.equal((upgraded.db.prepare("SELECT project_id FROM domain_events WHERE id = 'EVT-L'").get() as { project_id: string }).project_id, projectOf(betaRepository), 'past events are routed to their project')
  assert.throws(() => upgraded.db.prepare("UPDATE domain_events SET event_type = 'x' WHERE id = 'EVT-L'").run(), /append-only/u, 'the append-only guard is back after the backfill')
  upgraded.close()

  console.log('project scope smoke passed · non-members see nothing · roles per project · reviewers picked from members · repository from the project · local paths validated · 019 backfill splits by repository · everyone sees the default project · work items numbered per project · product type taken from the project manifest')
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
