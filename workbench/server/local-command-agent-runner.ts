import { realpathSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { ControlPlaneDatabase } from './database.ts'
import { GitWorktreeAgentRunner, type AgentExecutionRuntime, type AgentRunPostprocessor, type AgentRuntimeContext } from './git-worktree-agent-runner.ts'
import { sha256 } from './security.ts'
import type { AgentProviderSettings, AgentRunRequest, AgentRunner, AgentRunnerDescriptor } from './types.ts'

/**
 * Translates the Control Plane's provider setting into the environment the builder wrapper reads. The
 * key itself is passed under a fixed name when the Control Plane holds it, so the wrapper only ever
 * needs to know *which* variable to point the agent CLI at, never the secret's value.
 */
const providerApiKeyVariable = 'APERTURE_AGENT_PROVIDER_API_KEY'

function providerEnvironment(provider?: AgentProviderSettings) {
  if (!provider) return {}
  const apiKeyEnv = provider.apiKey ? providerApiKeyVariable : provider.apiKeyEnv
  return {
    APERTURE_AGENT_MODEL: provider.model,
    APERTURE_AGENT_MODEL_PROVIDER: provider.providerId,
    APERTURE_AGENT_PROVIDER_BASE_URL: provider.baseUrl,
    APERTURE_AGENT_PROVIDER_WIRE_API: provider.wireApi,
    ...(provider.reasoningEffort ? { APERTURE_AGENT_REASONING_EFFORT: provider.reasoningEffort } : {}),
    ...(apiKeyEnv ? { APERTURE_AGENT_PROVIDER_API_KEY_ENV: apiKeyEnv } : {}),
    ...(provider.apiKey ? { [providerApiKeyVariable]: provider.apiKey } : {}),
  }
}

class LocalProcessRuntime implements AgentExecutionRuntime {
  readonly descriptor: AgentRunnerDescriptor
  private readonly input: { executable: string; args: string[]; environmentAllowlist: string[]; provider?: AgentProviderSettings }

  constructor(input: { executable: string; args?: string[]; environmentAllowlist?: string[]; provider?: AgentProviderSettings }) {
    this.input = { executable: input.executable, args: input.args ?? [], environmentAllowlist: input.environmentAllowlist ?? [], provider: input.provider }
    this.descriptor = { id: 'local-command-agent@0.2', isolation: 'unisolated_process', status: 'degraded', productionEligible: false, networkEgress: 'unrestricted', reason: 'Process runtime has no container, egress or syscall boundary.' }
  }

  attest() {
    const executablePath = realpathSync(this.input.executable)
    const environmentKeys = Object.keys(this.buildEnvironment()).sort()
    const secretEnvironmentKeys = environmentKeys.filter((key) => /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/u.test(key))
    // Which model produced the change is review information, so it is attested and hashed like the rest
    // of the runtime. The credential is represented by the name of the variable carrying it, never its value.
    const provider = this.input.provider
    const model = provider ? { id: provider.model, providerId: provider.providerId, baseUrl: provider.baseUrl, wireApi: provider.wireApi, reasoningEffort: provider.reasoningEffort ?? null, apiKeySource: provider.apiKey ? `control_plane_setting:${providerApiKeyVariable}` : provider.apiKeyEnv ? `server_environment:${provider.apiKeyEnv}` : 'none', configuredAt: provider.updatedAt } : null
    const canonical = { runtimeId: this.descriptor.id, isolation: 'unisolated_process' as const, executablePath, executableDigest: `sha256:${sha256(readFileSync(executablePath))}`, args: this.input.args, networkEgress: 'unrestricted' as const, readonlyRoot: false, capDropAll: false, noNewPrivileges: false, ephemeral: false, secretMounts: [], environmentKeys, secretEnvironmentKeys, productionEligible: false, model }
    return { ...canonical, attestationDigest: `sha256:${sha256(JSON.stringify(canonical))}` }
  }

  execute(context: AgentRuntimeContext) {
    const result = spawnSync(this.input.executable, this.input.args, { cwd: context.worktreePath, encoding: 'utf8', timeout: context.timeoutMs, maxBuffer: 20 * 1024 * 1024, env: { ...this.buildEnvironment(), APERTURE_RUN_REQUEST: context.requestPath, APERTURE_WORKTREE: context.worktreePath } })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
  }

  private buildEnvironment() {
    const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', ...this.input.environmentAllowlist])
    for (const key of Object.keys(process.env)) if (key.startsWith('CODEX_')) allowed.add(key)
    // An operator who keeps the key in the server environment instead of in the Control Plane still needs
    // that one variable to reach the agent, without widening the allowlist by hand.
    if (this.input.provider?.apiKeyEnv && !this.input.provider.apiKey) allowed.add(this.input.provider.apiKeyEnv)
    return { ...Object.fromEntries([...allowed].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])), ...providerEnvironment(this.input.provider) }
  }
}

export class LocalCommandAgentRunner implements AgentRunner {
  readonly id: string
  readonly descriptor: AgentRunnerDescriptor
  private readonly runner: GitWorktreeAgentRunner

  constructor(input: { database: ControlPlaneDatabase; executable: string; args?: string[]; environmentAllowlist?: string[]; provider?: AgentProviderSettings; worktreeRoot: string; timeoutMs?: number; postprocessor?: AgentRunPostprocessor }) {
    this.runner = new GitWorktreeAgentRunner({ database: input.database, runtime: new LocalProcessRuntime({ executable: input.executable, args: input.args, environmentAllowlist: input.environmentAllowlist, provider: input.provider }), worktreeRoot: input.worktreeRoot, timeoutMs: input.timeoutMs, postprocessor: input.postprocessor })
    this.id = this.runner.id
    this.descriptor = this.runner.descriptor
  }

  prepare(request: AgentRunRequest, actorId: string) {
    return this.runner.prepare(request, actorId)
  }

  execute(runId: string) {
    return this.runner.execute(runId)
  }

  run(request: AgentRunRequest, actorId: string) {
    return this.runner.run(request, actorId)
  }
}
