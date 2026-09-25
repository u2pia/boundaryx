import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import type { AgentRunQueue } from './agent-run-queue.ts'
import type { ControlPlaneDatabase } from './database.ts'
import { codeHostFor } from './code-host/index.ts'
import { CodeHostSyncer } from './code-host/syncer.ts'
import { createPkcePair, fetchGithubIdentity, githubAuthorizeUrl, type GithubOAuthConfig } from './github-oauth.ts'
import type { LocalEvidenceStore } from './local-evidence-store.ts'
import { LocalGitAuthority } from './local-git-authority.ts'
import { LocalReleaseAuthority } from './local-release-authority.ts'
import { requestContext, type RequestContext } from './request-context.ts'
import { projectProductType } from './project-product-type.ts'
import { probeAgentProvider } from './provider-probe.ts'
import { agentRunProgress } from './run-progress.ts'
import { createSessionToken } from './security.ts'
import { AppError, type AgentRunner, type AgentRunnerDescriptor, type CodeHostKind, type MergeMode, type ProjectRole, type SessionActor, type TeamRole } from './types.ts'

const SESSION_COOKIE = 'aperture_session'

function parseCookies(header?: string) {
  return Object.fromEntries((header ?? '').split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf('=')
    return separator < 0 ? [entry, ''] : [entry.slice(0, separator), decodeURIComponent(entry.slice(separator + 1))]
  }))
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1_000_000) throw new AppError(413, 'Request body is too large', 'payload_too_large')
    chunks.push(buffer)
  }
  if (!chunks.length) return {} as Record<string, unknown>
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    throw new AppError(400, 'Request body must be valid JSON', 'invalid_json')
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  response.end(JSON.stringify(value))
}

function redirect(response: ServerResponse, location: string, headers: Record<string, string> = {}) {
  response.writeHead(302, { location, 'cache-control': 'no-store', ...headers })
  response.end()
}

function sendNoContent(response: ServerResponse, headers: Record<string, string> = {}) {
  response.writeHead(204, { 'cache-control': 'no-store', ...headers })
  response.end()
}

function sessionCookie(token: string, expiresAt: string) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}`
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
}

function requireString(body: Record<string, unknown>, key: string) {
  const value = body[key]
  if (typeof value !== 'string' || !value.trim()) throw new AppError(400, `${key} is required`, 'invalid_request')
  return value.trim()
}

function optionalString(body: Record<string, unknown>, key: string) {
  return typeof body[key] === 'string' && body[key].trim() ? body[key].trim() : undefined
}

function requireActor(database: ControlPlaneDatabase, request: IncomingMessage) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE]
  const actor = token ? database.getSession(token) : null
  if (!actor) throw new AppError(401, 'Authentication required', 'authentication_required')
  return { actor, token }
}

function requireRole(actor: SessionActor, allowed: TeamRole[]) {
  if (!allowed.includes(actor.role)) throw new AppError(403, 'Actor does not have permission for this operation', 'forbidden')
}

const ALL_ROLES: TeamRole[] = ['owner', 'maintainer', 'reviewer', 'developer']

/** Browsers used to name the repository a run edits; it now comes from the project, and a stray path is an error. */
function rejectRepositoryPath(body: Record<string, unknown>) {
  if ('repositoryPath' in body) throw new AppError(400, 'repositoryPath is no longer accepted; the repository comes from the work item\'s project', 'repository_path_not_accepted')
}

function projectHostBody(body: Record<string, unknown>) {
  return {
    codeHost: optionalString(body, 'codeHost') as CodeHostKind | undefined,
    repositoryPath: body.repositoryPath === null ? null : optionalString(body, 'repositoryPath'),
    codeHostConfig: body.codeHostConfig && typeof body.codeHostConfig === 'object' && !Array.isArray(body.codeHostConfig) ? body.codeHostConfig as Record<string, unknown> : undefined,
    defaultBranch: optionalString(body, 'defaultBranch'),
    mergeMode: optionalString(body, 'mergeMode') as MergeMode | undefined,
  }
}

function routeMatch(pathname: string, pattern: RegExp) {
  return pathname.match(pattern)?.groups ?? null
}

function contentType(path: string) {
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
  return types[extname(path)] ?? 'application/octet-stream'
}

function serveStatic(response: ServerResponse, staticDirectory: string, pathname: string, headOnly = false) {
  const normalizedPath = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  const requested = resolve(staticDirectory, `.${normalizedPath}`)
  const root = resolve(staticDirectory)
  const candidate = requested.startsWith(root) && existsSync(requested) && statSync(requested).isFile() ? requested : join(root, 'index.html')
  if (!existsSync(candidate)) return false
  response.writeHead(200, { 'content-type': contentType(candidate), 'cache-control': candidate.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable' })
  if (headOnly) response.end()
  else createReadStream(candidate).pipe(response)
  return true
}

export function createControlPlaneRequestHandler(input: { database: ControlPlaneDatabase; staticDirectory?: string; agentRunner?: AgentRunner; agentRunQueue?: AgentRunQueue; agentRuntimeDescriptor?: AgentRunnerDescriptor; evidenceStore?: LocalEvidenceStore; githubOAuth?: GithubOAuthConfig; codeHostSyncer?: CodeHostSyncer }) {
  const { database, staticDirectory, agentRunner, agentRunQueue } = input
  // Without a running syncer (tests, a server started without one) the sync route still works on demand.
  const codeHostSyncer = input.codeHostSyncer ?? new CodeHostSyncer({ database })
  const agentRuntimeDescriptor = input.agentRuntimeDescriptor ?? agentRunner?.descriptor
  const authority = new LocalGitAuthority(database)
  const releaseAuthority = new LocalReleaseAuthority(database)

  /**
   * Admits a run and hands execution to the queue, so the request returns in milliseconds instead of
   * holding the event loop for the length of the run. Without a queue the run executes in process; that
   * path exists only for in-process tests.
   */
  function startAgentRun(request: Parameters<AgentRunner['prepare']>[0], actorId: string) {
    if (!agentRunner) throw new AppError(503, 'Local Agent Runner is not configured', 'agent_runner_unavailable')
    if (!agentRunQueue) return { agentRun: agentRunner.run(request, actorId), status: 201, queuePosition: undefined }
    const agentRun = agentRunner.prepare(request, actorId)
    return { agentRun, status: 202, queuePosition: agentRunQueue.enqueue(agentRun.id) }
  }

  function sessionView(actor: SessionActor) {
    return { ...actor, authMethod: actor.authMethod ?? 'password', identity: database.getIdentityBinding(actor.id) ?? null }
  }

  // The context is filled in once the session is known, so every decision taken while serving this request can
  // record how its actor was proven (see request-context.ts).
  return (request: IncomingMessage, response: ServerResponse) => requestContext.run({} as RequestContext, () => handle(request, response))

  async function handle(request: IncomingMessage, response: ServerResponse) {
    try {
      const method = request.method ?? 'GET'
      const url = new URL(request.url ?? '/', 'http://localhost')
      const path = url.pathname

      if (method === 'OPTIONS') return sendNoContent(response)
      if (method === 'GET' && path === '/api/health') {
        // The runtime descriptor is built at startup, but the provider can be reconfigured at any time and
        // takes effect on the next run, so the model is read live rather than reported from the snapshot.
        const provider = database.getAgentProviderSettings()
        const agentRuntime = agentRuntimeDescriptor ? { ...agentRuntimeDescriptor, model: provider?.model, modelProvider: provider?.providerId } : null
        return sendJson(response, 200, { status: 'ok', provider: authority.id, storage: 'sqlite', agentRunner: agentRunner?.id ?? null, agentRuntime, agentRunQueue: agentRunQueue?.snapshot() ?? null, eventSeal: database.getEventSealStatus(), time: new Date().toISOString() })
      }
      if (method === 'GET' && path === '/api/setup/status') return sendJson(response, 200, { required: !database.hasActors() })

      if (method === 'GET' && path === '/api/auth/providers') return sendJson(response, 200, { identityMode: database.getIdentityMode(), github: { configured: Boolean(input.githubOAuth) } })

      if (method === 'GET' && path === '/api/auth/github/start') {
        if (!input.githubOAuth) throw new AppError(404, 'GitHub sign-in is not configured on this control plane', 'github_oauth_unconfigured')
        const state = createSessionToken()
        const pkce = createPkcePair()
        database.createOAuthState(state, pkce.verifier)
        return redirect(response, githubAuthorizeUrl(input.githubOAuth, state, pkce.challenge))
      }

      // GitHub redirects the browser here. Every failure goes back to the UI as a code, never as a JSON page, and the
      // state is burned before the code is exchanged. The SameSite=Strict session cookie is not sent on this
      // cross-site navigation, which is fine: who signs in is decided by the GitHub identity, not by any cookie.
      if (method === 'GET' && path === '/api/auth/github/callback') {
        if (!input.githubOAuth) throw new AppError(404, 'GitHub sign-in is not configured on this control plane', 'github_oauth_unconfigured')
        const back = (query: string) => `${input.githubOAuth!.uiUrl}/?${query}`
        try {
          if (url.searchParams.get('error')) throw new AppError(403, 'GitHub sign-in was cancelled', 'github_denied')
          const verifier = database.consumeOAuthState(url.searchParams.get('state') ?? '')
          const proof = await fetchGithubIdentity(input.githubOAuth, url.searchParams.get('code') ?? '', verifier)
          const actor = database.completeGithubLogin(proof)
          const session = database.createSession(actor.id, 8 * 60 * 60, 'github')
          return redirect(response, back('identity=github'), { 'set-cookie': sessionCookie(session.token, session.expiresAt) })
        } catch (error) {
          const code = error instanceof AppError ? error.code : 'github_login_failed'
          if (!(error instanceof AppError)) console.error(error)
          return redirect(response, back(`identity_error=${encodeURIComponent(code)}`))
        }
      }

      if (method === 'POST' && path === '/api/setup') {
        if (database.hasActors()) throw new AppError(409, 'Local control plane is already initialized', 'already_initialized')
        const body = await readJson(request)
        const actor = database.createActor({ username: requireString(body, 'username'), displayName: requireString(body, 'displayName'), password: requireString(body, 'password'), role: 'owner' })
        const session = database.createSession(actor.id)
        return sendJson(response, 201, { actor, expiresAt: session.expiresAt }, { 'set-cookie': sessionCookie(session.token, session.expiresAt) })
      }

      if (method === 'POST' && path === '/api/auth/login') {
        const body = await readJson(request)
        const actor = database.authenticate(requireString(body, 'username'), requireString(body, 'password'))
        const session = database.createSession(actor.id)
        return sendJson(response, 200, { actor, expiresAt: session.expiresAt }, { 'set-cookie': sessionCookie(session.token, session.expiresAt) })
      }

      if (method === 'POST' && path === '/api/auth/logout') {
        const token = parseCookies(request.headers.cookie)[SESSION_COOKIE]
        if (token) database.revokeSession(token)
        return sendNoContent(response, { 'set-cookie': clearSessionCookie() })
      }

      if (method === 'GET' && path === '/api/session') {
        const { actor } = requireActor(database, request)
        return sendJson(response, 200, { actor: sessionView(actor), identityMode: database.getIdentityMode() })
      }

      if (!path.startsWith('/api/') && (method === 'GET' || method === 'HEAD') && staticDirectory && serveStatic(response, staticDirectory, path, method === 'HEAD')) return

      const { actor } = requireActor(database, request)
      requestContext.getStore()!.authMethod = actor.authMethod ?? 'password'

      // Every list is limited to the projects this actor can see; `?projectId=` narrows it to one of them.
      const visibleProjectIds = database.visibleProjectIds(actor.id)
      const scope = () => {
        const requested = url.searchParams.get('projectId')
        if (!requested) return visibleProjectIds
        if (!visibleProjectIds.includes(requested)) throw new AppError(404, `Project ${requested} not found`, 'project_not_found')
        return [requested]
      }
      const requireIn = (projectId: string, roles: TeamRole[] = ALL_ROLES, code = 'forbidden') => database.requireProjectRole(actor.id, projectId, roles, code)

      if (method === 'GET' && path === '/api/actors') return sendJson(response, 200, { actors: database.listActors() })

      if (method === 'POST' && path === '/api/actors') {
        requireRole(actor, ['owner'])
        const body = await readJson(request)
        const role = requireString(body, 'role') as TeamRole
        if (!['owner', 'maintainer', 'reviewer', 'developer'].includes(role)) throw new AppError(400, 'Invalid role', 'invalid_role')
        const projectIds = Array.isArray(body.projectIds) ? body.projectIds.filter((value): value is string => typeof value === 'string') : undefined
        const created = database.createActor({ username: requireString(body, 'username'), displayName: requireString(body, 'displayName'), password: requireString(body, 'password'), role, projectIds }, actor.id)
        return sendJson(response, 201, { actor: created })
      }

      const actorRoute = routeMatch(path, /^\/api\/actors\/(?<actorId>[^/]+)$/u)
      if (method === 'POST' && actorRoute) {
        requireRole(actor, ['owner'])
        const body = await readJson(request)
        const role = body.role === undefined ? undefined : requireString(body, 'role') as TeamRole
        if (role !== undefined && !['maintainer', 'reviewer', 'developer'].includes(role)) throw new AppError(400, 'Invalid role', 'invalid_role')
        const status = body.status === undefined ? undefined : requireString(body, 'status') as 'active' | 'disabled'
        if (status !== undefined && !['active', 'disabled'].includes(status)) throw new AppError(400, 'Invalid status', 'invalid_status')
        const updated = database.updateActor(actorRoute.actorId, { displayName: optionalString(body, 'displayName'), role, status, password: typeof body.password === 'string' && body.password ? body.password : undefined }, actor.id)
        return sendJson(response, 200, { actor: updated })
      }

      if (method === 'GET' && path === '/api/projects') {
        const projects = database.listProjects(actor.id)
        return sendJson(response, 200, { projects, roles: Object.fromEntries(projects.map((project) => [project.id, database.projectRole(actor.id, project.id)])) })
      }

      if (method === 'POST' && path === '/api/projects') {
        const body = await readJson(request)
        const members = Array.isArray(body.members) ? body.members.map((member) => {
          const value = (member ?? {}) as Record<string, unknown>
          return { actorId: requireString(value, 'actorId'), role: requireString(value, 'role') as ProjectRole }
        }) : undefined
        const host = projectHostBody(body)
        const project = database.createProject({ slug: requireString(body, 'slug'), name: requireString(body, 'name'), description: optionalString(body, 'description'), members, ...host, codeHost: host.codeHost ?? 'local' }, actor.id)
        return sendJson(response, 201, { project })
      }

      const projectRoute = routeMatch(path, /^\/api\/projects\/(?<projectId>[^/]+)$/u)
      if (method === 'GET' && projectRoute) {
        const role = requireIn(projectRoute.projectId)
        return sendJson(response, 200, { project: database.getProject(projectRoute.projectId), role, members: database.listProjectMembers(projectRoute.projectId), lastSync: codeHostSyncer.lastReport(projectRoute.projectId) ?? null })
      }

      const projectSettingsRoute = routeMatch(path, /^\/api\/projects\/(?<projectId>[^/]+)\/settings$/u)
      if (method === 'POST' && projectSettingsRoute) {
        const body = await readJson(request)
        const host = projectHostBody(body)
        const project = database.updateProjectSettings(projectSettingsRoute.projectId, { name: optionalString(body, 'name'), description: typeof body.description === 'string' ? body.description : undefined, ...host, repositoryPath: 'repositoryPath' in body ? host.repositoryPath ?? null : undefined }, actor.id)
        return sendJson(response, 200, { project })
      }

      const projectArchiveRoute = routeMatch(path, /^\/api\/projects\/(?<projectId>[^/]+)\/archive$/u)
      if (method === 'POST' && projectArchiveRoute) return sendJson(response, 200, { project: database.archiveProject(projectArchiveRoute.projectId, actor.id) })

      // Booleans and permission names only: the connection test never returns a credential or the host's raw answer.
      const projectConnectionRoute = routeMatch(path, /^\/api\/projects\/(?<projectId>[^/]+)\/test-connection$/u)
      if (method === 'POST' && projectConnectionRoute) {
        requireIn(projectConnectionRoute.projectId, ['owner', 'maintainer'])
        const project = database.getProject(projectConnectionRoute.projectId)
        return sendJson(response, 200, { connection: await codeHostFor(project, { dataDirectory: database.dataDirectory, env: process.env }).testConnection() })
      }

      // A holdout's content goes in and never comes back out: members see digests, and the manifest names one by digest.
      const projectHoldoutRoute = routeMatch(path, /^\/api\/projects\/(?<projectId>[^/]+)\/evaluation-holdouts$/u)
      if (method === 'GET' && projectHoldoutRoute) {
        requireIn(projectHoldoutRoute.projectId)
        return sendJson(response, 200, { holdouts: database.listEvaluationHoldouts(projectHoldoutRoute.projectId) })
      }
      if (method === 'POST' && projectHoldoutRoute) {
        const body = await readJson(request)
        if (typeof body.content !== 'string') throw new AppError(400, 'content must be the holdout text (JSON lines)', 'invalid_evaluation_holdout')
        return sendJson(response, 201, { holdout: database.registerEvaluationHoldout(projectHoldoutRoute.projectId, body.content, actor.id) })
      }

      const projectSyncRoute = routeMatch(path, /^\/api\/projects\/(?<projectId>[^/]+)\/sync$/u)
      if (method === 'POST' && projectSyncRoute) {
        requireIn(projectSyncRoute.projectId, ['owner', 'maintainer'])
        return sendJson(response, 200, { report: await codeHostSyncer.syncProject(projectSyncRoute.projectId) })
      }

      const projectMembersRoute = routeMatch(path, /^\/api\/projects\/(?<projectId>[^/]+)\/members$/u)
      if (method === 'POST' && projectMembersRoute) {
        const body = await readJson(request)
        const member = database.setProjectMember({ projectId: projectMembersRoute.projectId, actorId: requireString(body, 'actorId'), role: requireString(body, 'role') as ProjectRole }, actor.id)
        return sendJson(response, 200, { member })
      }

      const projectMemberRemoveRoute = routeMatch(path, /^\/api\/projects\/(?<projectId>[^/]+)\/members\/(?<actorId>[^/]+)\/remove$/u)
      if (method === 'POST' && projectMemberRemoveRoute) {
        database.removeProjectMember({ projectId: projectMemberRemoveRoute.projectId, actorId: projectMemberRemoveRoute.actorId }, actor.id)
        return sendNoContent(response)
      }

      const identityRoute = routeMatch(path, /^\/api\/actors\/(?<actorId>[^/]+)\/identity$/u)
      if (method === 'POST' && identityRoute) {
        const body = await readJson(request)
        const identity = database.declareIdentity({ actorId: identityRoute.actorId, githubLogin: requireString(body, 'githubLogin') }, actor.id)
        return sendJson(response, 200, { identity })
      }

      if (method === 'POST' && path === '/api/settings/identity-mode') {
        const body = await readJson(request)
        return sendJson(response, 200, { identityMode: database.setIdentityMode(requireString(body, 'mode') as 'development' | 'team', actor.id) })
      }

      // The provider setting decides which LLM authors every change, so reading it is limited to the roles
      // that can also start runs, and writing it to Owner. The response never carries the API key.
      if (method === 'GET' && path === '/api/settings/agent-provider') {
        requireRole(actor, ['owner', 'maintainer', 'developer'])
        return sendJson(response, 200, { settings: database.getAgentProviderView() ?? null, apiKeyVariable: 'APERTURE_AGENT_PROVIDER_API_KEY' })
      }

      if (method === 'POST' && path === '/api/settings/agent-provider') {
        requireRole(actor, ['owner'])
        const body = await readJson(request)
        const wireApi = requireString(body, 'wireApi')
        if (!['responses', 'chat'].includes(wireApi)) throw new AppError(400, 'wireApi must be responses or chat', 'invalid_wire_api')
        const reasoningEffort = optionalString(body, 'reasoningEffort')
        if (reasoningEffort && !['minimal', 'low', 'medium', 'high'].includes(reasoningEffort)) throw new AppError(400, 'reasoningEffort must be minimal, low, medium or high', 'invalid_reasoning_effort')
        const baseUrl = requireString(body, 'baseUrl')
        if (!/^https?:\/\//u.test(baseUrl)) throw new AppError(400, 'baseUrl must be an http(s) URL', 'invalid_base_url')
        // `apiKey` absent keeps the stored secret; an empty string clears it. That distinction is what lets
        // the form be re-submitted without the operator retyping the key.
        const settings = database.saveAgentProviderSettings({
          providerId: requireString(body, 'providerId'),
          model: requireString(body, 'model'),
          baseUrl,
          wireApi: wireApi as 'responses' | 'chat',
          apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
          apiKeyEnv: optionalString(body, 'apiKeyEnv'),
          reasoningEffort: reasoningEffort as 'minimal' | 'low' | 'medium' | 'high' | undefined,
        }, actor.id)
        return sendJson(response, 200, { settings })
      }

      // Tries the settings in the form, saved or not, with one short request. The key is the one typed, else the
      // configured environment variable, else the stored one; the stored key is only sent to the base URL it was
      // saved for, so editing the URL cannot make the server hand the secret to another host.
      if (method === 'POST' && path === '/api/settings/agent-provider/test') {
        requireRole(actor, ['owner'])
        const body = await readJson(request)
        const wireApi = requireString(body, 'wireApi')
        if (!['responses', 'chat'].includes(wireApi)) throw new AppError(400, 'wireApi must be responses or chat', 'invalid_wire_api')
        const baseUrl = requireString(body, 'baseUrl')
        if (!/^https?:\/\//u.test(baseUrl)) throw new AppError(400, 'baseUrl must be an http(s) URL', 'invalid_base_url')
        const stored = database.getAgentProviderSettings()
        const apiKeyEnv = optionalString(body, 'apiKeyEnv')
        let apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : apiKeyEnv ? process.env[apiKeyEnv] : undefined
        if (!apiKey && body.apiKey === undefined && stored?.apiKey) {
          if (stored.baseUrl.trim().replace(/\/+$/u, '') !== baseUrl.replace(/\/+$/u, '')) throw new AppError(400, 'The stored API key is only sent to the base URL it was saved for; type the key to test another URL', 'provider_test_key_withheld')
          apiKey = stored.apiKey
        }
        const result = await probeAgentProvider({ providerId: requireString(body, 'providerId'), model: requireString(body, 'model'), baseUrl, wireApi: wireApi as 'responses' | 'chat', apiKey })
        return sendJson(response, 200, { result })
      }

      if (method === 'GET' && path === '/api/work-items') return sendJson(response, 200, { workItems: database.listWorkItems(scope()) })

      if (method === 'GET' && path === '/api/agent-runs') return sendJson(response, 200, { agentRuns: database.listAgentRuns(scope()).map((run) => ({ ...run, progress: agentRunProgress(database, run) })) })

      if (method === 'POST' && path === '/api/agent-runs') {
        if (!agentRunner) throw new AppError(503, 'Local Agent Runner is not configured', 'agent_runner_unavailable')
        const body = await readJson(request)
        rejectRepositoryPath(body)
        const workItem = database.getWorkItem(requireString(body, 'workItemId'))
        requireIn(workItem.projectId, ['owner', 'maintainer', 'developer'])
        const declaredContextPaths = Array.isArray(body.declaredContextPaths) ? body.declaredContextPaths.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map((value) => value.trim()) : []
        const started = startAgentRun({ workItemId: workItem.id, intentVersionId: requireString(body, 'intentVersionId'), baseRef: optionalString(body, 'baseRef') ?? database.getProject(workItem.projectId).defaultBranch, declaredContextPaths, changeProposalId: optionalString(body, 'changeProposalId') }, actor.id)
        return sendJson(response, started.status, { agentRun: started.agentRun, queuePosition: started.queuePosition })
      }

      const agentRunCancelRoute = routeMatch(path, /^\/api\/agent-runs\/(?<runId>[^/]+)\/cancel$/u)
      if (method === 'POST' && agentRunCancelRoute) {
        const target = database.getAgentRun(agentRunCancelRoute.runId)
        const role = requireIn(target.projectId, ['owner', 'maintainer', 'developer'])
        if (role === 'developer' && target.startedByActorId !== actor.id) throw new AppError(403, 'Developers can only cancel their own Agent Runs', 'cancel_forbidden')
        if (!agentRunQueue) throw new AppError(503, 'Agent Run queue is not configured; runs execute in process and cannot be cancelled', 'agent_run_queue_unavailable')
        return sendJson(response, 200, { agentRun: agentRunQueue.cancel(agentRunCancelRoute.runId, actor.id) })
      }

      const agentRunRoute = routeMatch(path, /^\/api\/agent-runs\/(?<runId>[^/]+)$/u)
      if (method === 'GET' && agentRunRoute) requireIn(database.getAgentRun(agentRunRoute.runId).projectId)
      if (method === 'GET' && agentRunRoute) return sendJson(response, 200, { agentRun: database.getAgentRun(agentRunRoute.runId), events: database.listAggregateEvents('agent_run', agentRunRoute.runId), declaredContextPaths: database.getDeclaredContextPaths(agentRunRoute.runId) })

      // What a project builds is declared once, in its manifest; a work item takes it from there. A caller that names
      // the other type is refused here, instead of at the first Run after the Intent has been approved.
      const productTypeRoute = routeMatch(path, /^\/api\/projects\/(?<projectId>[^/]+)\/product-type$/u)
      if (method === 'GET' && productTypeRoute) {
        requireIn(productTypeRoute.projectId)
        return sendJson(response, 200, { productType: projectProductType(database, productTypeRoute.projectId) ?? null })
      }

      if (method === 'POST' && path === '/api/work-items') {
        const body = await readJson(request)
        const projectId = requireString(body, 'projectId')
        const requested = optionalString(body, 'productType')
        if (requested && !['application', 'agent_system'].includes(requested)) throw new AppError(400, 'productType must be application or agent_system', 'invalid_product_type')
        requireIn(projectId, ALL_ROLES, 'work_item_forbidden')
        const declared = projectProductType(database, projectId)
        if (declared && requested && requested !== declared) throw new AppError(409, `The project's .aperture/project.json declares ${declared}; a work item in it cannot be ${requested}`, 'work_item_product_type_mismatch')
        const productType = (declared ?? requested ?? 'application') as 'application' | 'agent_system'
        const workItem = database.createWorkItem({ title: requireString(body, 'title'), description: typeof body.description === 'string' ? body.description : '', productType, ownerActorId: optionalString(body, 'ownerActorId') ?? actor.id, projectId }, actor.id)
        return sendJson(response, 201, { workItem })
      }

      const workItemRoute = routeMatch(path, /^\/api\/work-items\/(?<workItemId>[^/]+)$/u)
      if (method === 'GET' && workItemRoute) requireIn(database.getWorkItem(workItemRoute.workItemId).projectId)
      if (method === 'GET' && workItemRoute) return sendJson(response, 200, { workItem: database.getWorkItem(workItemRoute.workItemId), intentVersions: database.listIntentVersions(workItemRoute.workItemId) })

      const intentRoute = routeMatch(path, /^\/api\/work-items\/(?<workItemId>[^/]+)\/intent-versions$/u)
      if (method === 'POST' && intentRoute) {
        const body = await readJson(request)
        if (!Array.isArray(body.acceptanceCriteria)) throw new AppError(400, 'acceptanceCriteria must be an array', 'invalid_acceptance_criteria')
        const intentVersion = database.createIntentVersion({ workItemId: intentRoute.workItemId, goal: requireString(body, 'goal'), constraints: Array.isArray(body.constraints) ? body.constraints.filter((item): item is string => typeof item === 'string') : [], riskLevel: requireString(body, 'riskLevel') as 'low' | 'medium' | 'high', acceptanceCriteria: body.acceptanceCriteria.map((criterion) => {
          if (!criterion || typeof criterion !== 'object') throw new AppError(400, 'Invalid acceptance criterion', 'invalid_acceptance_criteria')
          const value = criterion as Record<string, unknown>
          return { statement: requireString(value, 'statement'), criticality: requireString(value, 'criticality') as 'normal' | 'critical', verificationType: requireString(value, 'verificationType') as 'deterministic' | 'model' | 'human', ...(value.verifiedBy === undefined ? {} : { verifiedBy: value.verifiedBy as string[] }) }
        }) }, actor.id)
        return sendJson(response, 201, { intentVersion })
      }

      const intentApprovalRoute = routeMatch(path, /^\/api\/intent-versions\/(?<intentVersionId>[^/]+)\/approve$/u)
      if (method === 'POST' && intentApprovalRoute) {
        const body = await readJson(request)
        const intentVersion = database.approveIntentVersion(decodeURIComponent(intentApprovalRoute.intentVersionId), actor.id, typeof body.comment === 'string' ? body.comment : '')
        return sendJson(response, 200, { intentVersion })
      }

      if (method === 'GET' && path === '/api/change-proposals') {
        const projectIds = scope()
        return sendJson(response, 200, { changeProposals: database.listChangeProposals(projectIds), codeHostLinks: database.listCodeHostLinks(projectIds) })
      }

      if (method === 'GET' && path === '/api/release-candidates') return sendJson(response, 200, { releaseCandidates: database.listReleaseCandidates(scope()) })

      if (method === 'GET' && path === '/api/reviews') {
        const projectIds = scope()
        // Load is per project when one is selected: those are the people who could take the review.
        const loadProject = url.searchParams.get('projectId') ?? (projectIds.length === 1 ? projectIds[0] : undefined)
        return sendJson(response, 200, { reviews: database.listReviews(projectIds), metrics: database.getReviewMetrics(projectIds), readiness: database.listReviewReadiness(projectIds), assignments: database.listReviewAssignments(undefined, projectIds), reviewerLoad: loadProject ? database.listReviewerLoad(loadProject) : database.listReviewerLoad() })
      }

      if (method === 'POST' && path === '/api/change-proposals') {
        const body = await readJson(request)
        rejectRepositoryPath(body)
        const workItem = database.getWorkItem(requireString(body, 'workItemId'))
        requireIn(workItem.projectId, ['owner', 'maintainer', 'developer'])
        const changeProposal = authority.createChangeProposal({ workItemId: workItem.id, intentVersionId: requireString(body, 'intentVersionId'), runId: optionalString(body, 'runId'), baseRef: optionalString(body, 'baseRef') ?? database.getProject(workItem.projectId).defaultBranch, headRef: requireString(body, 'headRef'), authorActorId: actor.id }, actor.id)
        codeHostSyncer.nudge(workItem.projectId)
        return sendJson(response, 201, { changeProposal })
      }

      const proposalRoute = routeMatch(path, /^\/api\/change-proposals\/(?<proposalId>[^/]+)$/u)
      // A path segment like /refresh never reaches here: the pattern stops at the id.
      const proposalProject = (proposalId: string) => database.getChangeProposal(proposalId).projectId
      if (method === 'GET' && proposalRoute) requireIn(proposalProject(proposalRoute.proposalId))
      if (method === 'GET' && proposalRoute) return sendJson(response, 200, { changeProposal: database.getChangeProposal(proposalRoute.proposalId), mergeEvidence: database.getMergeEvidenceOptional(proposalRoute.proposalId), codeHostLink: database.getCodeHostLink(proposalRoute.proposalId) ?? null, events: database.listAggregateEvents('change_proposal', proposalRoute.proposalId) })

      const refreshRoute = routeMatch(path, /^\/api\/change-proposals\/(?<proposalId>[^/]+)\/refresh$/u)
      if (method === 'POST' && refreshRoute) requireIn(proposalProject(refreshRoute.proposalId))
      if (method === 'POST' && refreshRoute) {
        const refreshed = authority.refreshChangeProposal(refreshRoute.proposalId, actor.id)
        codeHostSyncer.nudge(refreshed.proposal.projectId)
        return sendJson(response, 200, refreshed)
      }

      const assignmentRoute = routeMatch(path, /^\/api\/change-proposals\/(?<proposalId>[^/]+)\/assignments$/u)
      if (method === 'POST' && assignmentRoute) {
        const body = await readJson(request)
        const dueHours = body.dueHours === undefined ? undefined : Number(body.dueHours)
        const assignment = database.assignReviewer({ proposalId: assignmentRoute.proposalId, assigneeActorId: optionalString(body, 'assigneeActorId'), dueHours, reason: optionalString(body, 'reason') }, actor.id)
        return sendJson(response, 201, { assignment })
      }

      const mergeRoute = routeMatch(path, /^\/api\/change-proposals\/(?<proposalId>[^/]+)\/merge$/u)
      if (method === 'POST' && mergeRoute) {
        requireIn(proposalProject(mergeRoute.proposalId), ['owner', 'maintainer'])
        const result = authority.mergeChangeProposal(mergeRoute.proposalId, actor.id)
        codeHostSyncer.nudge(result.proposal.projectId)
        return sendJson(response, result.changed ? 201 : 200, result)
      }

      const reviseRoute = routeMatch(path, /^\/api\/change-proposals\/(?<proposalId>[^/]+)\/revise$/u)
      if (method === 'POST' && reviseRoute) {
        if (!agentRunner) throw new AppError(503, 'Local Agent Runner is not configured', 'agent_runner_unavailable')
        const proposal = database.getChangeProposal(reviseRoute.proposalId)
        const role = requireIn(proposal.projectId, ['owner', 'maintainer', 'developer'])
        if (role === 'developer' && proposal.authorActorId !== actor.id) throw new AppError(403, 'Developers can only revise their own change proposals', 'revision_forbidden')
        const started = startAgentRun({ workItemId: proposal.workItemId, intentVersionId: proposal.intentVersionId, baseRef: proposal.baseRef, declaredContextPaths: [], changeProposalId: proposal.id }, actor.id)
        return sendJson(response, started.status, { agentRun: started.agentRun, queuePosition: started.queuePosition })
      }

      const releaseCandidateRoute = routeMatch(path, /^\/api\/change-proposals\/(?<proposalId>[^/]+)\/release-candidates$/u)
      if (method === 'POST' && releaseCandidateRoute) {
        requireIn(proposalProject(releaseCandidateRoute.proposalId), ['owner', 'maintainer'])
        const releaseCandidate = releaseAuthority.createReleaseCandidate(releaseCandidateRoute.proposalId, actor.id)
        return sendJson(response, 201, { releaseCandidate })
      }

      const releaseApprovalRoute = routeMatch(path, /^\/api\/release-candidates\/(?<candidateId>[^/]+)\/approve$/u)
      if (method === 'POST' && releaseApprovalRoute) {
        requireIn(database.getReleaseCandidate(releaseApprovalRoute.candidateId).projectId, ['owner', 'maintainer'], 'release_approval_forbidden')
        const body = await readJson(request)
        releaseAuthority.verifyReleaseCandidate(releaseApprovalRoute.candidateId)
        const releaseCandidate = database.approveReleaseCandidate(releaseApprovalRoute.candidateId, actor.id, typeof body.comment === 'string' ? body.comment : '')
        return sendJson(response, 201, { releaseCandidate })
      }

      const checkRoute = routeMatch(path, /^\/api\/change-proposals\/(?<proposalId>[^/]+)\/checks$/u)
      if (method === 'POST' && checkRoute) {
        const proposal = database.getChangeProposal(checkRoute.proposalId)
        requireIn(proposal.projectId, ['owner', 'maintainer'])
        if (proposal.authorActorId === actor.id) throw new AppError(403, 'The author of a change proposal cannot report checks on it', 'check_self_reporting_forbidden')
        const body = await readJson(request)
        // Only the code-host syncer writes `github/…` checks; a person reporting one would be impersonating the host.
        if (requireString(body, 'name').startsWith('github/')) throw new AppError(400, 'Check names starting with github/ are reserved for checks imported from GitHub', 'check_name_reserved')
        const check = database.recordCheck({ proposalId: checkRoute.proposalId, headSha: requireString(body, 'headSha'), name: requireString(body, 'name'), status: requireString(body, 'status') as 'queued' | 'in_progress' | 'completed', conclusion: optionalString(body, 'conclusion') as 'success' | 'failure' | 'neutral' | 'cancelled' | undefined, evidenceRef: optionalString(body, 'evidenceRef'), source: 'external' }, actor.id)
        codeHostSyncer.nudge(proposal.projectId)
        return sendJson(response, 201, { check })
      }

      const evidenceRoute = routeMatch(path, /^\/api\/change-proposals\/(?<proposalId>[^/]+)\/evidence$/u)
      if (method === 'POST' && evidenceRoute) {
        const proposal = database.getChangeProposal(evidenceRoute.proposalId)
        requireIn(proposal.projectId, ['owner', 'maintainer'])
        if (proposal.authorActorId === actor.id) throw new AppError(403, 'The author of a change proposal cannot attach evidence to it', 'evidence_self_reporting_forbidden')
        const body = await readJson(request)
        const uri = requireString(body, 'uri')
        const digest = requireString(body, 'sha256')
        if (!input.evidenceStore) throw new AppError(503, 'Local evidence store is not configured', 'evidence_store_unavailable')
        const runId = requireString(body, 'runId')
        const headSha = requireString(body, 'headSha')
        const stored = input.evidenceStore.read(uri, digest)
        // The digest only proves the package is intact, not that it is about this proposal: a package from another
        // run or revision would otherwise vouch for this one.
        if (stored.git?.headSha !== headSha || stored.intent?.id !== proposal.intentVersionId || stored.run?.id !== runId) throw new AppError(409, 'The evidence package describes a different revision, intent or run than this change proposal', 'evidence_package_mismatch')
        // Readiness trusts summary.criteriaCoverage, so it comes from the verified package, never from the request body.
        // So are the event chain heads the merge gate checks against the live chains.
        const { criteriaCoverage: _claimed, eventChainHeads: _claimedHeads, ...summary } = body.summary && typeof body.summary === 'object' && !Array.isArray(body.summary) ? body.summary as Record<string, unknown> : {}
        const heads = stored.provenance && typeof stored.provenance.runEventChainHead === 'string' && typeof stored.provenance.proposalEventChainHead === 'string' ? { eventChainHeads: { runEventChainHead: stored.provenance.runEventChainHead, proposalEventChainHead: stored.provenance.proposalEventChainHead } } : {}
        const evidence = database.recordEvidence({ proposalId: evidenceRoute.proposalId, runId, headSha, uri, sha256: digest, summary: { ...summary, ...(Array.isArray(stored.criteriaCoverage) ? { criteriaCoverage: stored.criteriaCoverage } : {}), ...heads } }, actor.id)
        return sendJson(response, 201, { evidence })
      }

      const evidenceViewRoute = routeMatch(path, /^\/api\/evidence\/(?<evidenceId>[^/]+)\/view$/u)
      if (method === 'POST' && evidenceViewRoute) {
        if (!input.evidenceStore) throw new AppError(503, 'Local evidence store is not configured', 'evidence_store_unavailable')
        const evidence = database.getEvidencePackage(evidenceViewRoute.evidenceId)
        requireIn(proposalProject(evidence.changeProposalId), ['owner', 'maintainer', 'reviewer'])
        if (evidence.invalidatedAt) throw new AppError(409, 'Evidence package has been invalidated by a newer revision', 'evidence_invalidated')
        const evidencePackage = input.evidenceStore.read(evidence.uri, evidence.sha256)
        const view = database.recordEvidenceView(evidence.id, actor.id, evidencePackage.packageDigest)
        return sendJson(response, 200, { evidence, evidencePackage, view })
      }

      const reviewRoute = routeMatch(path, /^\/api\/change-proposals\/(?<proposalId>[^/]+)\/reviews$/u)
      if (method === 'POST' && reviewRoute) {
        const body = await readJson(request)
        const review = database.recordReview({ proposalId: reviewRoute.proposalId, headSha: requireString(body, 'headSha'), reviewerActorId: actor.id, decision: requireString(body, 'decision') as 'approved' | 'changes_requested' | 'commented', comment: typeof body.comment === 'string' ? body.comment : '' })
        codeHostSyncer.nudge(proposalProject(reviewRoute.proposalId))
        return sendJson(response, 201, { review })
      }

      // Role checks for Override / Reject live in the database layer, next to the decision they guard.
      const overrideRoute = routeMatch(path, /^\/api\/change-proposals\/(?<proposalId>[^/]+)\/overrides$/u)
      if (method === 'POST' && overrideRoute) {
        const body = await readJson(request)
        const decision = database.recordOverride({ proposalId: overrideRoute.proposalId, headSha: requireString(body, 'headSha'), criterionId: requireString(body, 'criterionId'), reason: typeof body.reason === 'string' ? body.reason : '' }, actor.id)
        codeHostSyncer.nudge(proposalProject(overrideRoute.proposalId))
        return sendJson(response, 201, { decision })
      }

      const rejectRoute = routeMatch(path, /^\/api\/change-proposals\/(?<proposalId>[^/]+)\/reject$/u)
      if (method === 'POST' && rejectRoute) {
        const body = await readJson(request)
        const decision = database.rejectChangeProposal({ proposalId: rejectRoute.proposalId, headSha: requireString(body, 'headSha'), reason: typeof body.reason === 'string' ? body.reason : '' }, actor.id)
        codeHostSyncer.nudge(proposalProject(rejectRoute.proposalId))
        return sendJson(response, 201, { decision })
      }

      if (method === 'GET' && path === '/api/decisions') {
        const visibleProposals = new Set(database.listChangeProposals(scope()).map((proposal) => proposal.id))
        return sendJson(response, 200, { decisions: database.listGovernanceDecisions().filter((decision) => visibleProposals.has(decision.changeProposalId)) })
      }

      if (method === 'GET' && path === '/api/events') return sendJson(response, 200, { events: database.listEvents(Number(url.searchParams.get('limit') ?? 200), scope()) })

      throw new AppError(404, 'Route not found', 'not_found')
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(500, error instanceof Error ? error.message : 'Internal server error', 'internal_error')
      if (appError.status >= 500) console.error(error)
      sendJson(response, appError.status, { error: { code: appError.code, message: appError.message } })
    }
  }
}

export function createControlPlaneServer(input: Parameters<typeof createControlPlaneRequestHandler>[0]) {
  return createServer(createControlPlaneRequestHandler(input))
}
