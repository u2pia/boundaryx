import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createConfiguredAgentRunner } from '../server/agent-runner-factory.ts'
import { ControlPlaneDatabase } from '../server/database.ts'
import { createControlPlaneRequestHandler } from '../server/http-server.ts'

/**
 * The Builder Agent's LLM provider is a Control Plane setting, not an operator-side CLI configuration.
 * This smoke test pins the three properties that makes that trustworthy: only an Owner can change it,
 * the stored API key never leaves the server, and the model that was configured actually reaches the
 * agent process and is attested for the run that used it.
 */
const root = mkdtempSync(join(tmpdir(), 'aperture-agent-provider-'))
const repositoryPath = join(root, 'repository')
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')
const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), migrationDirectory)
const secret = 'sk-provider-secret-2026'
const otherSecret = 'sk-provider-rotated-2026'

function git(...args: string[]) {
  return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim()
}

function makeRequester(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void) {
  return async function request<T>(path: string, input: { method?: string; cookie?: string; body?: Record<string, unknown> } = {}) {
    const body = input.body ? JSON.stringify(input.body) : ''
    const headers: IncomingHttpHeaders = { ...(input.cookie ? { cookie: input.cookie } : {}), ...(body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}) }
    const requestStream = Readable.from(body ? [Buffer.from(body)] : []) as IncomingMessage
    Object.assign(requestStream, { method: input.method ?? (input.body ? 'POST' : 'GET'), url: path, headers })
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
    const text = Buffer.concat(chunks).toString('utf8')
    const setCookie = responseHeaders['set-cookie']
    const cookieValue = Array.isArray(setCookie) ? setCookie[0] : typeof setCookie === 'string' ? setCookie : undefined
    return { status, cookie: cookieValue?.split(';')[0], text, body: text ? JSON.parse(text) as T : undefined }
  }
}

type ProviderView = { providerId: string; model: string; baseUrl: string; wireApi: string; apiKeySet: boolean; apiKeyEnv?: string; reasoningEffort?: string; updatedByActorId: string }

mkdirSync(repositoryPath)
execFileSync('git', ['init', '--initial-branch=main', repositoryPath])
git('config', 'user.name', 'Aperture Provider Test')
git('config', 'user.email', 'aperture-provider@example.test')
writeFileSync(join(repositoryPath, 'README.md'), '# Provider fixture\n')
mkdirSync(join(repositoryPath, '.aperture'))
writeFileSync(join(repositoryPath, '.aperture/project.json'), JSON.stringify({ schemaVersion: 'aperture.project.v1', productType: 'application', context: { required: ['README.md'], allowed: ['README.md'] }, checks: [{ name: 'provider-fixture', kind: 'test', command: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 10_000 }], policy: { maximumRisk: 'high', allowUnisolatedRuntime: true } }, null, 2))
git('add', 'README.md', '.aperture/project.json')
git('commit', '-m', 'initial')

// The agent is a stand-in for the builder wrapper: it records the environment it was handed so the test can
// prove the configured provider (and only the configured provider) crossed the process boundary.
const environmentDumpPath = join(root, 'agent-environment.json')
const agentScript = join(root, 'provider-agent.mjs')
writeFileSync(agentScript, `import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.CODEX_ENV_DUMP, JSON.stringify(process.env))\nwriteFileSync('generated.ts', 'export const generated = true\\n')\nconsole.log(JSON.stringify({ type: 'message', summary: 'provider fixture' }))\n`)

// The runner's environment allowlist passes `CODEX_*` through from the server process, which is how the dump
// path reaches the fixture agent without widening the allowlist for the test.
process.env.CODEX_ENV_DUMP = environmentDumpPath
const agentEnvironment = { ...process.env, CONTROL_PLANE_AGENT_EXECUTABLE: process.execPath, CONTROL_PLANE_AGENT_ARGS_JSON: JSON.stringify([agentScript]) }

try {
  const bootstrap = createConfiguredAgentRunner({ database, dataDirectory: root, env: agentEnvironment })
  const request = makeRequester(createControlPlaneRequestHandler({ database, agentRunner: bootstrap.runner, agentRuntimeDescriptor: bootstrap.descriptor, evidenceStore: bootstrap.evidenceStore }))

  const setup = await request<{ actor: { id: string } }>('/api/setup', { body: { username: 'owner', displayName: 'Local Owner', password: 'owner-password-2026' } })
  const ownerCookie = setup.cookie!
  const ownerId = setup.body!.actor.id
  assert.equal((await request('/api/projects/PRJ-DEFAULT/settings', { cookie: ownerCookie, body: { repositoryPath } })).status, 200)
  await request('/api/actors', { cookie: ownerCookie, body: { username: 'maintainer', displayName: 'Release Maintainer', role: 'maintainer', password: 'maintainer-password-2026' } })
  await request('/api/actors', { cookie: ownerCookie, body: { username: 'reviewer', displayName: 'Human Reviewer', role: 'reviewer', password: 'reviewer-password-2026' } })
  await request('/api/actors', { cookie: ownerCookie, body: { username: 'author', displayName: 'Agent Author', role: 'developer', password: 'author-password-2026' } })
  const maintainerCookie = (await request('/api/auth/login', { body: { username: 'maintainer', password: 'maintainer-password-2026' } })).cookie!
  const reviewerCookie = (await request('/api/auth/login', { body: { username: 'reviewer', password: 'reviewer-password-2026' } })).cookie!
  const authorCookie = (await request('/api/auth/login', { body: { username: 'author', password: 'author-password-2026' } })).cookie!

  const unset = await request<{ settings: ProviderView | null; apiKeyVariable: string }>('/api/settings/agent-provider', { cookie: ownerCookie })
  assert.equal(unset.status, 200)
  assert.equal(unset.body?.settings, null)
  assert.equal(unset.body?.apiKeyVariable, 'APERTURE_AGENT_PROVIDER_API_KEY')

  // Reading is for the roles that act on runs; a Reviewer has no business with the provider credential at all.
  assert.equal((await request('/api/settings/agent-provider', { cookie: reviewerCookie })).status, 403)
  assert.equal((await request('/api/settings/agent-provider')).status, 401)
  // Changing which model authors code is an Owner decision, not a Maintainer or Developer one.
  const maintainerWrite = await request<{ error: { code: string } }>('/api/settings/agent-provider', { cookie: maintainerCookie, body: { providerId: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', wireApi: 'chat' } })
  assert.equal(maintainerWrite.status, 403)
  assert.equal(maintainerWrite.body?.error.code, 'forbidden')

  const badWire = await request<{ error: { code: string } }>('/api/settings/agent-provider', { cookie: ownerCookie, body: { providerId: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', wireApi: 'grpc' } })
  assert.equal(badWire.status, 400)
  assert.equal(badWire.body?.error.code, 'invalid_wire_api')
  const badUrl = await request<{ error: { code: string } }>('/api/settings/agent-provider', { cookie: ownerCookie, body: { providerId: 'deepseek', model: 'deepseek-chat', baseUrl: 'api.deepseek.com', wireApi: 'chat' } })
  assert.equal(badUrl.status, 400)
  assert.equal(badUrl.body?.error.code, 'invalid_base_url')
  const badEffort = await request<{ error: { code: string } }>('/api/settings/agent-provider', { cookie: ownerCookie, body: { providerId: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', wireApi: 'chat', reasoningEffort: 'maximum' } })
  assert.equal(badEffort.status, 400)
  assert.equal(badEffort.body?.error.code, 'invalid_reasoning_effort')
  assert.equal(database.getAgentProviderSettings(), undefined)

  const saved = await request<{ settings: ProviderView }>('/api/settings/agent-provider', { cookie: ownerCookie, body: { providerId: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', wireApi: 'chat', apiKey: secret, reasoningEffort: 'medium' } })
  assert.equal(saved.status, 200)
  assert.equal(saved.body?.settings.model, 'deepseek-chat')
  assert.equal(saved.body?.settings.apiKeySet, true)
  assert.equal(saved.body?.settings.updatedByActorId, ownerId)
  // The key is write-only: it is absent from the response shape and its value appears nowhere in the payload.
  assert.equal(Object.hasOwn(saved.body!.settings as object, 'apiKey'), false)
  assert.equal(saved.text.includes(secret), false)

  const developerRead = await request<{ settings: ProviderView }>('/api/settings/agent-provider', { cookie: authorCookie })
  assert.equal(developerRead.status, 200)
  assert.equal(developerRead.body?.settings.apiKeySet, true)
  assert.equal(developerRead.text.includes(secret), false)
  assert.equal(database.getAgentProviderSettings()?.apiKey, secret)

  // Re-submitting the form without retyping the key must keep it, otherwise every model change would silently
  // disarm the provider.
  const keptKey = await request<{ settings: ProviderView }>('/api/settings/agent-provider', { cookie: ownerCookie, body: { providerId: 'deepseek', model: 'deepseek-reasoner', baseUrl: 'https://api.deepseek.com/v1', wireApi: 'chat' } })
  assert.equal(keptKey.body?.settings.model, 'deepseek-reasoner')
  assert.equal(keptKey.body?.settings.apiKeySet, true)
  assert.equal(keptKey.body?.settings.reasoningEffort, undefined)
  assert.equal(database.getAgentProviderSettings()?.apiKey, secret)

  const rotated = await request<{ settings: ProviderView }>('/api/settings/agent-provider', { cookie: ownerCookie, body: { providerId: 'deepseek', model: 'deepseek-reasoner', baseUrl: 'https://api.deepseek.com/v1', wireApi: 'chat', apiKey: otherSecret } })
  assert.equal(rotated.body?.settings.apiKeySet, true)
  assert.equal(database.getAgentProviderSettings()?.apiKey, otherSecret)

  // An empty string is the explicit "clear it" signal, which is how an Owner hands the credential back to the
  // server environment instead of the Control Plane.
  const cleared = await request<{ settings: ProviderView }>('/api/settings/agent-provider', { cookie: ownerCookie, body: { providerId: 'deepseek', model: 'deepseek-reasoner', baseUrl: 'https://api.deepseek.com/v1', wireApi: 'chat', apiKey: '', apiKeyEnv: 'DEEPSEEK_API_KEY' } })
  assert.equal(cleared.body?.settings.apiKeySet, false)
  assert.equal(cleared.body?.settings.apiKeyEnv, 'DEEPSEEK_API_KEY')
  assert.equal(database.getAgentProviderSettings()?.apiKey, undefined)

  const providerEvents = database.listAggregateEvents('agent_provider', 'current')
  assert.equal(providerEvents.length, 4)
  assert.equal(providerEvents.every((event) => event.actorId === ownerId), true)
  assert.equal(providerEvents.every((event) => event.eventType === 'agent_provider.configured'), true)
  assert.equal(providerEvents[0].payload.apiKeyHeld, true)
  assert.equal(providerEvents[3].payload.apiKeyHeld, false)
  assert.equal(providerEvents[1].payload.previousModel, 'deepseek-chat')
  // The Event Log is the review record, so it records that a key was held, never the key.
  assert.equal(JSON.stringify(providerEvents).includes(secret), false)
  assert.equal(JSON.stringify(providerEvents).includes(otherSecret), false)

  const finalSettings = await request<{ settings: ProviderView }>('/api/settings/agent-provider', { cookie: ownerCookie, body: { providerId: 'ica', model: 'gpt-5.1-codex', baseUrl: 'https://proxy.example.test/v1', wireApi: 'responses', apiKey: secret, reasoningEffort: 'high' } })
  assert.equal(finalSettings.status, 200)

  // A run admitted after the save must carry that model, without the server having been restarted: the worker
  // rebuilds its runner from the database through this same factory.
  const configured = createConfiguredAgentRunner({ database, dataDirectory: root, env: agentEnvironment })
  assert.equal(configured.descriptor.model, 'gpt-5.1-codex')
  assert.equal(configured.descriptor.modelProvider, 'ica')
  const health = await request<{ agentRuntime: { model: string; modelProvider: string } }>('/api/health')
  assert.equal(health.body?.agentRuntime.model, 'gpt-5.1-codex')
  assert.equal(health.body?.agentRuntime.modelProvider, 'ica')

  const workItemId = (await request<{ workItem: { id: string } }>('/api/work-items', { cookie: ownerCookie, body: { projectId: 'PRJ-DEFAULT', title: '验证 Provider 配置生效', description: 'Provider 设置必须进入运行环境与运行证明。', productType: 'application', ownerActorId: ownerId } })).body!.workItem.id
  const intentVersionId = (await request<{ intentVersion: { id: string } }>(`/api/work-items/${workItemId}/intent-versions`, { cookie: ownerCookie, body: { goal: '让 Builder 使用受控的 Provider', constraints: ['offline'], riskLevel: 'medium', acceptanceCriteria: [{ statement: '运行证明包含模型', criticality: 'critical', verificationType: 'deterministic' }] } })).body!.intentVersion.id
  await request(`/api/intent-versions/${encodeURIComponent(intentVersionId)}/approve`, { cookie: reviewerCookie, body: {} })
  // Runs are admitted through a handler holding the freshly rebuilt runner, which is what the worker process
  // does for every run it claims.
  const runRequest = makeRequester(createControlPlaneRequestHandler({ database, agentRunner: configured.runner, agentRuntimeDescriptor: configured.descriptor, evidenceStore: configured.evidenceStore }))
  const run = await runRequest<{ agentRun: { id: string; status: string; errorMessage?: string } }>('/api/agent-runs', { cookie: authorCookie, body: { workItemId, intentVersionId, baseRef: 'main', declaredContextPaths: ['README.md'] } })
  assert.equal(run.status, 201, run.text)
  assert.equal(run.body?.agentRun.status, 'succeeded', run.body?.agentRun.errorMessage)
  const runId = run.body!.agentRun.id

  const agentEnvironmentDump = JSON.parse(readFileSync(environmentDumpPath, 'utf8')) as Record<string, string>
  assert.equal(agentEnvironmentDump.APERTURE_AGENT_MODEL, 'gpt-5.1-codex')
  assert.equal(agentEnvironmentDump.APERTURE_AGENT_MODEL_PROVIDER, 'ica')
  assert.equal(agentEnvironmentDump.APERTURE_AGENT_PROVIDER_BASE_URL, 'https://proxy.example.test/v1')
  assert.equal(agentEnvironmentDump.APERTURE_AGENT_PROVIDER_WIRE_API, 'responses')
  assert.equal(agentEnvironmentDump.APERTURE_AGENT_REASONING_EFFORT, 'high')
  assert.equal(agentEnvironmentDump.APERTURE_AGENT_PROVIDER_API_KEY_ENV, 'APERTURE_AGENT_PROVIDER_API_KEY')
  assert.equal(agentEnvironmentDump.APERTURE_AGENT_PROVIDER_API_KEY, secret)

  const attested = database.listAggregateEvents('agent_run', runId).find((event) => event.eventType === 'agent_run.runtime_attested')!
  const model = attested.payload.model as { id: string; providerId: string; wireApi: string; apiKeySource: string }
  assert.equal(model.id, 'gpt-5.1-codex')
  assert.equal(model.providerId, 'ica')
  assert.equal(model.wireApi, 'responses')
  // The credential is attested by the name of the variable carrying it, so a reviewer can tell where it came
  // from without the digest ever covering a secret value.
  assert.equal(model.apiKeySource, 'control_plane_setting:APERTURE_AGENT_PROVIDER_API_KEY')
  assert.equal(JSON.stringify(attested.payload).includes(secret), false)
  assert.equal((attested.payload.secretEnvironmentKeys as string[]).includes('APERTURE_AGENT_PROVIDER_API_KEY'), true)
  assert.match(attested.payload.attestationDigest as string, /^sha256:[0-9a-f]{64}$/u)

  // The codex wrapper is what turns that environment into CLI configuration; without the translation the run
  // would silently use whatever provider the operator's own codex config names.
  const wrapperRoot = mkdtempSync(join(tmpdir(), 'aperture-provider-wrapper-'))
  const wrapperWorkspace = join(wrapperRoot, 'workspace')
  const wrapperRequestPath = join(wrapperRoot, 'request.json')
  const fakeCodex = join(wrapperRoot, 'fake-codex')
  mkdirSync(wrapperWorkspace)
  writeFileSync(join(wrapperWorkspace, 'README.md'), '# Fixture\n')
  writeFileSync(wrapperRequestPath, JSON.stringify({ runId: 'RUN-PROVIDER', workItem: { title: 'Provider fixture', productType: 'application' }, intent: { goal: 'Create generated.ts', constraints: [], acceptanceCriteria: [] }, declaredContextPaths: ['README.md'] }))
  writeFileSync(fakeCodex, `#!/usr/bin/env node\nimport { readFileSync, writeFileSync } from 'node:fs'\nconst args = process.argv.slice(2)\nwriteFileSync('../codex-args.json', JSON.stringify(args))\nreadFileSync(0, 'utf8')\nconst outputIndex = args.indexOf('-o')\nif (outputIndex >= 0) writeFileSync(args[outputIndex + 1], 'Fixture completed')\n`)
  chmodSync(fakeCodex, 0o755)
  try {
    const wrapper = resolve(dirname(fileURLToPath(import.meta.url)), 'agents/codex-builder.mjs')
    const wrapperResult = spawnSync(process.execPath, [wrapper, fakeCodex], { cwd: wrapperWorkspace, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', APERTURE_RUN_REQUEST: wrapperRequestPath, APERTURE_WORKTREE: wrapperWorkspace, APERTURE_AGENT_MODEL: 'gpt-5.1-codex', APERTURE_AGENT_MODEL_PROVIDER: 'ica', APERTURE_AGENT_PROVIDER_BASE_URL: 'https://proxy.example.test/v1', APERTURE_AGENT_PROVIDER_WIRE_API: 'responses', APERTURE_AGENT_PROVIDER_API_KEY_ENV: 'APERTURE_AGENT_PROVIDER_API_KEY', APERTURE_AGENT_REASONING_EFFORT: 'high', APERTURE_AGENT_PROVIDER_API_KEY: secret } })
    assert.equal(wrapperResult.status, 0, wrapperResult.stderr)
    const capturedArgs = JSON.parse(readFileSync(join(wrapperRoot, 'codex-args.json'), 'utf8')) as string[]
    assert.equal(capturedArgs.includes('-m'), true)
    assert.equal(capturedArgs[capturedArgs.indexOf('-m') + 1], 'gpt-5.1-codex')
    for (const override of ['model_provider=ica', 'model_providers.ica.base_url=https://proxy.example.test/v1', 'model_providers.ica.wire_api=responses', 'model_providers.ica.env_key=APERTURE_AGENT_PROVIDER_API_KEY', 'model_reasoning_effort=high']) {
      assert.equal(capturedArgs.includes(override), true, `missing codex override ${override}`)
    }
    // The wrapper points codex at the variable; it must never inline the secret into the command line, where
    // it would be visible to every process on the machine.
    assert.equal(capturedArgs.some((argument) => argument.includes(secret)), false)
  } finally {
    rmSync(wrapperRoot, { recursive: true, force: true })
  }

  console.log(`agent provider settings smoke passed · ${runId} · owner-only · key never returned · model attested`)
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
