import { realpathSync, readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import type { ControlPlaneDatabase } from './database.ts'
import { GitWorktreeAgentRunner, type AgentExecutionRuntime, type AgentRunPostprocessor, type AgentRuntimeContext } from './git-worktree-agent-runner.ts'
import { progressPathFor } from './run-progress.ts'
import { seatbeltCommand, type SeatbeltPolicy } from './seatbelt.ts'
import { sha256 } from './security.ts'
import type { AgentProviderSettings, AgentRun, AgentRunRequest, AgentRunner, AgentRunnerDescriptor } from './types.ts'

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

/**
 * Paths a confined Builder may not read or write: the Control Plane's data directory (database, holdouts, evidence,
 * evaluation directories, other runs) and a seal key kept elsewhere. Its own run directory and the repository's Git
 * directory are re-allowed, since the worktree needs both.
 */
export type BuilderConfinement = { kind: 'seatbelt'; denied: string[] }

class LocalProcessRuntime implements AgentExecutionRuntime {
  readonly descriptor: AgentRunnerDescriptor
  private readonly input: { executable: string; args: string[]; environmentAllowlist: string[]; provider: () => AgentProviderSettings | undefined; confinement?: BuilderConfinement }

  constructor(input: { executable: string; args?: string[]; environmentAllowlist?: string[]; provider?: () => AgentProviderSettings | undefined; confinement?: BuilderConfinement }) {
    this.input = { executable: input.executable, args: input.args ?? [], environmentAllowlist: input.environmentAllowlist ?? [], provider: input.provider ?? (() => undefined), confinement: input.confinement }
    this.descriptor = { id: 'local-command-agent@0.2', isolation: 'unisolated_process', status: 'degraded', productionEligible: false, networkEgress: 'unrestricted', reason: input.confinement ? 'Process runtime confined by Seatbelt away from the Control Plane data directory; no container, egress or syscall boundary.' : 'Process runtime has no container, egress or syscall boundary.' }
  }

  private policy(context: AgentRuntimeContext): SeatbeltPolicy | undefined {
    if (!this.input.confinement) return undefined
    const gitCommonDirectory = resolve(context.worktreePath, execFileSync('git', ['-C', context.worktreePath, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim())
    return { denied: this.input.confinement.denied, allowed: [dirname(context.worktreePath), gitCommonDirectory] }
  }

  attest(context: AgentRuntimeContext) {
    const executablePath = realpathSync(this.input.executable)
    const environmentKeys = Object.keys(this.buildEnvironment()).sort()
    const secretEnvironmentKeys = environmentKeys.filter((key) => /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/u.test(key))
    // Which model produced the change is review information, so it is attested and hashed like the rest
    // of the runtime. The credential is represented by the name of the variable carrying it, never its value.
    const provider = this.input.provider()
    const model = provider ? { id: provider.model, providerId: provider.providerId, baseUrl: provider.baseUrl, wireApi: provider.wireApi, reasoningEffort: provider.reasoningEffort ?? null, apiKeySource: provider.apiKey ? `control_plane_setting:${providerApiKeyVariable}` : provider.apiKeyEnv ? `server_environment:${provider.apiKeyEnv}` : 'none', configuredAt: provider.updatedAt } : null
    const canonical = { runtimeId: this.descriptor.id, isolation: 'unisolated_process' as const, executablePath, executableDigest: `sha256:${sha256(readFileSync(executablePath))}`, args: this.input.args, networkEgress: 'unrestricted' as const, readonlyRoot: false, capDropAll: false, noNewPrivileges: false, ephemeral: false, secretMounts: [], environmentKeys, secretEnvironmentKeys, productionEligible: false, model, ...this.confinementAttestation(context) }
    return { ...canonical, attestationDigest: `sha256:${sha256(JSON.stringify(canonical))}` }
  }

  private confinementAttestation(context: AgentRuntimeContext) {
    const policy = this.policy(context)
    if (!policy) return { holdoutReadable: true }
    return { confinement: { kind: 'seatbelt' as const, deniedPaths: policy.denied, allowedPaths: policy.allowed ?? [], profileDigest: seatbeltCommand(policy, this.input.executable, this.input.args).profileDigest }, holdoutReadable: false }
  }

  execute(context: AgentRuntimeContext) {
    // The agent is told when it will be killed, so it can stop and hand over what it has before that happens.
    const deadline = String(Date.now() + context.timeoutMs)
    const policy = this.policy(context)
    const command = policy ? seatbeltCommand(policy, this.input.executable, this.input.args) : { executable: this.input.executable, args: this.input.args }
    const result = spawnSync(command.executable, command.args, { cwd: context.worktreePath, encoding: 'utf8', timeout: context.timeoutMs, maxBuffer: 20 * 1024 * 1024, env: { ...this.buildEnvironment(), APERTURE_RUN_REQUEST: context.requestPath, APERTURE_WORKTREE: context.worktreePath, APERTURE_RUN_DEADLINE: deadline, APERTURE_PROGRESS_FILE: progressPathFor(context.requestPath) } })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error, diagnostic: this.diagnostic(result.stderr ?? '') }
  }

  /** Last lines of stderr, so a failed run says why; the provider key and any other secret variable's value are removed first. */
  private diagnostic(stderr: string) {
    let text = stderr
    const environment = this.buildEnvironment() as Record<string, string | undefined>
    for (const [key, value] of Object.entries(environment)) if (value && value.length >= 8 && /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/u.test(key)) text = text.replaceAll(value, '[redacted]')
    const tail = text.trim().split('\n').slice(-40).join('\n')
    return tail ? tail.slice(-4000) : undefined
  }

  private buildEnvironment() {
    const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', ...this.input.environmentAllowlist])
    for (const key of Object.keys(process.env)) if (key.startsWith('CODEX_')) allowed.add(key)
    if (process.env.APERTURE_BUILDER_MAX_STEPS) allowed.add('APERTURE_BUILDER_MAX_STEPS')
    // An operator who keeps the key in the server environment instead of in the Control Plane still needs
    // that one variable to reach the agent, without widening the allowlist by hand.
    const provider = this.input.provider()
    if (provider?.apiKeyEnv && !provider.apiKey) allowed.add(provider.apiKeyEnv)
    return { ...Object.fromEntries([...allowed].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])), ...providerEnvironment(provider) }
  }
}

export class LocalCommandAgentRunner implements AgentRunner {
  readonly id: string
  readonly descriptor: AgentRunnerDescriptor
  private readonly runner: GitWorktreeAgentRunner

  constructor(input: { database: ControlPlaneDatabase; executable: string; args?: string[]; environmentAllowlist?: string[]; provider?: () => AgentProviderSettings | undefined; worktreeRoot: string; timeoutMs?: number; postprocessor?: AgentRunPostprocessor; confinement?: BuilderConfinement }) {
    this.runner = new GitWorktreeAgentRunner({ database: input.database, runtime: new LocalProcessRuntime({ executable: input.executable, args: input.args, environmentAllowlist: input.environmentAllowlist, provider: input.provider, confinement: input.confinement }), worktreeRoot: input.worktreeRoot, timeoutMs: input.timeoutMs, postprocessor: input.postprocessor })
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

  cleanUpWorktree(run: AgentRun, actorId?: string) {
    return this.runner.cleanUpWorktree(run, actorId)
  }
}
