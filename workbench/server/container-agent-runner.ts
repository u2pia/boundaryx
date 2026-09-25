import { spawnSync } from 'node:child_process'
import type { ControlPlaneDatabase } from './database.ts'
import { GitWorktreeAgentRunner, type AgentExecutionRuntime, type AgentRunPostprocessor, type AgentRuntimeContext } from './git-worktree-agent-runner.ts'
import { sha256 } from './security.ts'
import { AppError, type AgentRun, type AgentRunRequest, type AgentRunner, type AgentRunnerDescriptor } from './types.ts'

export type ContainerRuntimeConfig = {
  engineExecutable: string
  imageRef: string
  command: string[]
  cpuLimit?: string
  memoryLimit?: string
  pidsLimit?: number
  user?: string
  tmpfsSize?: string
}

function engineCommand(executable: string, args: string[], timeoutMs = 30_000) {
  return spawnSync(executable, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } })
}

export function probeContainerEngine(executable: string) {
  const result = engineCommand(executable, ['version', '--format', '{{.Server.Version}}'])
  if (result.error || result.status !== 0) return { available: false, reason: result.error?.message ?? result.stderr?.trim() ?? `engine exited ${result.status}` }
  return { available: true, version: result.stdout.trim() }
}

class ContainerExecutionRuntime implements AgentExecutionRuntime {
  readonly descriptor: AgentRunnerDescriptor
  private readonly input: Required<Omit<ContainerRuntimeConfig, 'command'>> & { command: string[] }

  constructor(input: ContainerRuntimeConfig) {
    this.input = { ...input, cpuLimit: input.cpuLimit ?? '2', memoryLimit: input.memoryLimit ?? '4g', pidsLimit: input.pidsLimit ?? 256, user: input.user ?? '65532:65532', tmpfsSize: input.tmpfsSize ?? '256m' }
    this.descriptor = { id: 'container-agent@0.1', isolation: 'container', status: 'ready', productionEligible: true, networkEgress: 'denied', imageRef: input.imageRef }
  }

  attest() {
    const version = probeContainerEngine(this.input.engineExecutable)
    if (!version.available) throw new AppError(503, `Container engine unavailable: ${version.reason}`, 'container_engine_unavailable')
    const image = engineCommand(this.input.engineExecutable, ['image', 'inspect', '--format', '{{.Id}}', this.input.imageRef])
    if (image.error || image.status !== 0 || !image.stdout.trim()) throw new AppError(503, `Container image unavailable locally: ${image.error?.message ?? image.stderr.trim()}`, 'container_image_unavailable')
    const canonical = { runtimeId: this.descriptor.id, isolation: 'container' as const, imageRef: this.input.imageRef, imageDigest: image.stdout.trim(), engineVersion: version.version, networkEgress: 'denied' as const, readonlyRoot: true, capDropAll: true, noNewPrivileges: true, ephemeral: true, cpuLimit: this.input.cpuLimit, memoryLimit: this.input.memoryLimit, pidsLimit: this.input.pidsLimit, user: this.input.user, tmpfsSize: this.input.tmpfsSize, secretMounts: [], productionEligible: true, holdoutReadable: false }
    return { ...canonical, attestationDigest: `sha256:${sha256(JSON.stringify(canonical))}` }
  }

  execute(context: AgentRuntimeContext) {
    const args = ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', String(this.input.pidsLimit), '--memory', this.input.memoryLimit, '--cpus', this.input.cpuLimit, '--user', this.input.user, '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${this.input.tmpfsSize}`, '--mount', `type=bind,src=${context.worktreePath},dst=/workspace`, '--mount', `type=bind,src=${context.requestPath},dst=/run/request.json,readonly`, '--workdir', '/workspace', '--env', 'APERTURE_RUN_REQUEST=/run/request.json', '--env', 'APERTURE_WORKTREE=/workspace', '--env', `APERTURE_RUN_DEADLINE=${Date.now() + context.timeoutMs}`, '--label', `aperture.run.id=${context.runId}`, this.input.imageRef, ...this.input.command]
    const result = engineCommand(this.input.engineExecutable, args, context.timeoutMs)
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
  }
}

export class ContainerAgentRunner implements AgentRunner {
  readonly id: string
  readonly descriptor: AgentRunnerDescriptor
  private readonly runner: GitWorktreeAgentRunner

  constructor(input: { database: ControlPlaneDatabase; runtime: ContainerRuntimeConfig; worktreeRoot: string; timeoutMs?: number; postprocessor?: AgentRunPostprocessor }) {
    this.runner = new GitWorktreeAgentRunner({ database: input.database, runtime: new ContainerExecutionRuntime(input.runtime), worktreeRoot: input.worktreeRoot, timeoutMs: input.timeoutMs, postprocessor: input.postprocessor })
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
