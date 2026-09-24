import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ControlPlaneDatabase } from '../server/database.ts'
import type { GithubOAuthConfig } from '../server/github-oauth.ts'
import { createControlPlaneServer } from '../server/http-server.ts'
import { requestContext } from '../server/request-context.ts'
import { AppError } from '../server/types.ts'

// DOMAIN_MODEL.md invariant 10: identity cannot be self-asserted. The owner declares which GitHub login a member must
// prove, GitHub proves it (OAuth code + PKCE against a fake GitHub here), the numeric id is pinned, and in Team mode
// only a GitHub-proven session can decide. V0.4: every decision event freezes the identity it was made under.
const root = mkdtempSync(join(tmpdir(), 'aperture-external-identity-'))
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')
const databasePath = join(root, 'control-plane.db')
const database = new ControlPlaneDatabase(databasePath, migrationDirectory)
const clientSecret = `cp-secret-${randomBytes(8).toString('hex')}`
const issuedTokens: string[] = []

// A GitHub stand-in that enforces what the real one does: client credentials, single-use codes, the redirect URI the
// code was issued for, and the PKCE verifier matching the challenge from the authorize step.
type FakeUser = { id: number; login: string }
const codes = new Map<string, { user: FakeUser; challenge: string; redirectUri: string }>()
const tokens = new Map<string, FakeUser>()
const fakeGithub = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://github.test')
  const reply = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
  if (request.method === 'POST' && url.pathname === '/login/oauth/access_token') {
    let body = ''
    for await (const chunk of request) body += chunk
    const form = new URLSearchParams(body)
    const grant = codes.get(form.get('code') ?? '')
    codes.delete(form.get('code') ?? '')
    const verifierMatches = grant && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === grant.challenge
    if (form.get('client_id') !== 'cp-client' || form.get('client_secret') !== clientSecret || !grant || grant.redirectUri !== form.get('redirect_uri') || !verifierMatches) return reply(200, { error: 'bad_verification_code' })
    const token = `gho_${randomBytes(12).toString('hex')}`
    issuedTokens.push(token)
    tokens.set(token, grant.user)
    return reply(200, { access_token: token, token_type: 'bearer', scope: 'read:user' })
  }
  if (request.method === 'GET' && url.pathname === '/user') {
    const user = tokens.get((request.headers.authorization ?? '').replace(/^Bearer /u, ''))
    return user ? reply(200, { id: user.id, login: user.login, name: user.login }) : reply(401, { message: 'Bad credentials' })
  }
  reply(404, { message: 'Not Found' })
})

async function listen(server: Server) {
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const githubBase = await listen(fakeGithub)
const githubOAuth: GithubOAuthConfig = { clientId: 'cp-client', clientSecret, oauthBaseUrl: githubBase, apiBaseUrl: githubBase, redirectUri: '', uiUrl: 'http://ui.test' }
const controlPlane = createControlPlaneServer({ database, githubOAuth })
const base = await listen(controlPlane)
githubOAuth.redirectUri = `${base}/api/auth/github/callback`

async function api<T = Record<string, any>>(path: string, input: { cookie?: string; body?: Record<string, unknown> } = {}) {
  const response = await fetch(`${base}${path}`, { method: input.body ? 'POST' : 'GET', headers: { ...(input.cookie ? { cookie: input.cookie } : {}), ...(input.body ? { 'content-type': 'application/json' } : {}) }, body: input.body ? JSON.stringify(input.body) : undefined })
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  return { status: response.status, cookie, body: await response.json() as T }
}

/** The browser round trip: start → (user approves on GitHub) → callback. `tamper` breaks one leg of the proof. */
async function githubSignIn(user: FakeUser, tamper: { challenge?: string; state?: string; code?: string } = {}) {
  const start = await fetch(`${base}/api/auth/github/start`, { redirect: 'manual' })
  assert.equal(start.status, 302)
  const authorize = new URL(start.headers.get('location')!)
  assert.deepEqual([authorize.origin + authorize.pathname, authorize.searchParams.get('scope'), authorize.searchParams.get('code_challenge_method')], [`${githubBase}/login/oauth/authorize`, 'read:user', 'S256'])
  const state = authorize.searchParams.get('state')!
  const code = randomBytes(8).toString('hex')
  codes.set(code, { user, challenge: tamper.challenge ?? authorize.searchParams.get('code_challenge')!, redirectUri: authorize.searchParams.get('redirect_uri')! })
  return callback(tamper.state ?? state, tamper.code ?? code)
}

async function callback(state: string, code: string) {
  const response = await fetch(`${base}/api/auth/github/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, { redirect: 'manual' })
  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('location')!)
  assert.equal(location.origin, 'http://ui.test', 'the callback always lands back on the UI')
  return { state, code, error: location.searchParams.get('identity_error'), cookie: response.headers.get('set-cookie')?.split(';')[0] }
}

const lastEvent = (aggregateType: string, aggregateId: string, eventType: string) => database.listAggregateEvents(aggregateType, aggregateId).findLast((event) => event.eventType === eventType)
const criteria = [{ statement: 'imports over 5 MiB return file_too_large', criticality: 'critical', verificationType: 'deterministic' }]

try {
  // Development mode: password sessions decide, and the event says the identity was self-asserted.
  const setup = await api('/api/setup', { body: { username: 'owner', displayName: 'Owner', password: 'owner-password-2026' } })
  const ownerPassword = setup.cookie!
  const ownerId = setup.body.actor.id as string
  assert.deepEqual((await api('/api/auth/providers')).body, { identityMode: 'development', github: { configured: true } })
  const reviewerId = (await api('/api/actors', { cookie: ownerPassword, body: { username: 'reviewer', displayName: 'Reviewer', password: 'reviewer-password-2026', role: 'reviewer' } })).body.actor.id as string
  const maintainerId = (await api('/api/actors', { cookie: ownerPassword, body: { username: 'maintainer', displayName: 'Maintainer', password: 'maintainer-password-2026', role: 'maintainer' } })).body.actor.id as string
  assert.deepEqual(lastEvent('actor', reviewerId, 'actor.created')?.payload.identity, { provider: 'local', subject: ownerId, login: 'owner', assurance: 'self_asserted', authMethod: 'password' })
  const reviewerPassword = (await api('/api/auth/login', { body: { username: 'reviewer', password: 'reviewer-password-2026' } })).cookie!
  const workItemId = (await api('/api/work-items', { cookie: ownerPassword, body: { projectId: 'PRJ-DEFAULT', title: 'size limit', description: 'size limit' } })).body.workItem.id as string
  const draft = async () => (await api(`/api/work-items/${workItemId}/intent-versions`, { cookie: ownerPassword, body: { goal: 'enforce a 5 MiB import limit', constraints: [], riskLevel: 'medium', acceptanceCriteria: criteria } })).body.intentVersion.id as string
  assert.equal((await api(`/api/intent-versions/${await draft()}/approve`, { cookie: reviewerPassword, body: { comment: 'clear' } })).status, 200)
  assert.equal(lastEvent('work_item', workItemId, 'intent.approved')?.payload.identity.assurance, 'self_asserted')

  // Only an owner declares, the login must look like a GitHub login, and one login belongs to one member.
  assert.equal((await api(`/api/actors/${reviewerId}/identity`, { cookie: reviewerPassword, body: { githubLogin: 'octo-reviewer' } })).body.error.code, 'identity_declaration_forbidden')
  assert.equal((await api(`/api/actors/${reviewerId}/identity`, { cookie: ownerPassword, body: { githubLogin: '-bad-' } })).body.error.code, 'invalid_github_login')
  assert.equal((await api(`/api/actors/${ownerId}/identity`, { cookie: ownerPassword, body: { githubLogin: '@Octo-Owner' } })).body.identity.expectedLogin, 'Octo-Owner')
  assert.equal((await api(`/api/actors/${reviewerId}/identity`, { cookie: ownerPassword, body: { githubLogin: 'octo-reviewer' } })).body.identity.status, 'declared')
  assert.equal((await api(`/api/actors/${maintainerId}/identity`, { cookie: ownerPassword, body: { githubLogin: 'OCTO-REVIEWER' } })).body.error.code, 'identity_login_taken')

  // Failures land on the UI as a code and create no session.
  const stranger = await githubSignIn({ id: 9009, login: 'stranger' })
  assert.deepEqual([stranger.error, stranger.cookie], ['identity_not_bound', undefined])
  assert.equal((await githubSignIn({ id: 1001, login: 'octo-owner' }, { state: 'forged-state' })).error, 'invalid_oauth_state')
  assert.equal((await githubSignIn({ id: 1001, login: 'octo-owner' }, { challenge: 'not-the-challenge' })).error, 'github_exchange_failed', 'a code is useless without the PKCE verifier')
  const expiring = await fetch(`${base}/api/auth/github/start`, { redirect: 'manual' })
  database.db.prepare('UPDATE oauth_states SET expires_at = ?').run('2000-01-01T00:00:00.000Z')
  assert.equal((await callback(new URL(expiring.headers.get('location')!).searchParams.get('state')!, 'any')).error, 'invalid_oauth_state', 'states expire')

  // The owner proves the declared login (case-insensitively); the numeric id is pinned.
  const ownerSignIn = await githubSignIn({ id: 1001, login: 'octo-owner' })
  assert.equal(ownerSignIn.error, null)
  const ownerGithub = ownerSignIn.cookie!
  const ownerSession = (await api('/api/session', { cookie: ownerGithub })).body
  assert.deepEqual([ownerSession.actor.id, ownerSession.actor.authMethod, ownerSession.actor.identity.status, ownerSession.actor.identity.subject], [ownerId, 'github', 'verified', '1001'])
  assert.equal(lastEvent('actor', ownerId, 'identity.verified')?.payload.login, 'octo-owner')
  assert.equal((await callback(ownerSignIn.state, ownerSignIn.code)).error, 'invalid_oauth_state', 'a callback cannot be replayed')

  // Switching the trust mode needs a GitHub-proven owner session in both directions.
  assert.equal((await api('/api/settings/identity-mode', { cookie: ownerPassword, body: { mode: 'team' } })).body.error.code, 'external_identity_required')
  assert.equal((await api('/api/settings/identity-mode', { cookie: ownerGithub, body: { mode: 'team' } })).body.identityMode, 'team')
  assert.deepEqual(lastEvent('control_plane', 'identity', 'identity.mode_changed')?.payload.identity, { provider: 'github', subject: '1001', login: 'octo-owner', assurance: 'external', authMethod: 'github' })

  // Team mode: a password session cannot decide, even for a bound member; a GitHub session can, and the approval
  // freezes github:<login> with the pinned subject.
  const teamDraft = await draft()
  assert.equal((await api(`/api/intent-versions/${teamDraft}/approve`, { cookie: reviewerPassword, body: {} })).body.error.code, 'external_identity_required')
  const reviewerGithub = (await githubSignIn({ id: 2002, login: 'octo-reviewer' })).cookie!
  assert.equal((await api(`/api/intent-versions/${teamDraft}/approve`, { cookie: reviewerGithub, body: { comment: 'criteria are assertable' } })).status, 200)
  assert.deepEqual(lastEvent('work_item', workItemId, 'intent.approved')?.payload.identity, { provider: 'github', subject: '2002', login: 'octo-reviewer', assurance: 'external', authMethod: 'github' })
  assert.equal((await api('/api/actors', { cookie: ownerPassword, body: { username: 'dev', displayName: 'Dev', password: 'dev-password-2026', role: 'developer' } })).body.error.code, 'external_identity_required', 'granting a role is a decision too')
  assert.equal((await api('/api/actors', { cookie: ownerGithub, body: { username: 'dev', displayName: 'Dev', password: 'dev-password-2026', role: 'developer' } })).status, 201)
  // Reading and non-decisions stay open to password sessions.
  assert.equal((await api('/api/work-items', { cookie: reviewerPassword })).status, 200)

  // In-process calls carry no session: in Team mode they cannot decide, and a GitHub context without a binding cannot either.
  const failsWith = (code: string) => (error: unknown) => error instanceof AppError && error.code === code
  const internalDraft = await draft()
  assert.throws(() => database.approveIntentVersion(internalDraft, reviewerId), failsWith('external_identity_required'))
  assert.throws(() => requestContext.run({ authMethod: 'github' }, () => database.approveIntentVersion(internalDraft, maintainerId)), failsWith('external_identity_required'))

  // A rename follows the pinned id; a recycled login with a different id inherits nothing.
  assert.equal((await githubSignIn({ id: 2002, login: 'octo-reviewer-renamed' })).error, null)
  assert.equal(database.getIdentityBinding(reviewerId)?.login, 'octo-reviewer-renamed')
  assert.deepEqual(lastEvent('actor', reviewerId, 'identity.login_changed')?.payload, { provider: 'github', subject: '2002', from: 'octo-reviewer', to: 'octo-reviewer-renamed' })
  assert.equal((await githubSignIn({ id: 3003, login: 'octo-reviewer' })).error, 'identity_not_bound')

  // Re-declaring drops the proof and signs out the member's GitHub sessions.
  assert.equal((await api(`/api/actors/${reviewerId}/identity`, { cookie: ownerGithub, body: { githubLogin: 'octo-reviewer-work' } })).body.identity.status, 'declared')
  assert.equal((await api('/api/session', { cookie: reviewerGithub })).status, 401)
  assert.equal((await api('/api/settings/identity-mode', { cookie: ownerGithub, body: { mode: 'development' } })).body.identityMode, 'development')
  assert.ok(database.verifyAggregateEventChain('actor', reviewerId), 'identity changes are part of the hash chain')

  // Neither the access tokens nor the client secret are written anywhere in the database.
  assert.ok(issuedTokens.length >= 4)
  const stored = [databasePath, `${databasePath}-wal`].filter((path) => existsSync(path)).map((path) => readFileSync(path).toString('latin1')).join('')
  for (const secret of [...issuedTokens, clientSecret]) assert.equal(stored.includes(secret), false)

  console.log('external identity smoke passed · owner declares, GitHub proves · PKCE + single-use state · id pinned across renames · team mode refuses password decisions · identity frozen into events · no tokens stored')
} finally {
  controlPlane.closeAllConnections()
  fakeGithub.closeAllConnections()
  await new Promise((resolveClose) => controlPlane.close(resolveClose))
  await new Promise((resolveClose) => fakeGithub.close(resolveClose))
  database.close()
  rmSync(root, { recursive: true, force: true })
}
