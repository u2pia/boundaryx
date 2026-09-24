import { resolve } from 'node:path'
import type { ControlPlaneDatabase } from './database.ts'
import { ContainerAgentRunner, probeContainerEngine } from './container-agent-runner.ts'
import { LocalCommandAgentRunner } from './local-command-agent-runner.ts'
import { LocalEvidenceStore } from './local-evidence-store.ts'
import { LocalRunPostprocessor } from './local-run-postprocessor.ts'
import type { AgentRunner, AgentRunnerDescriptor } from './types.ts'

function parseStringArray(value: string | undefined, name: string) {
  if (!value) return []
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error(`${name} must be a JSON string array`)
  return parsed as string[]
}

export function createConfiguredAgentRunner(input: { database: ControlPlaneDatabase; dataDirectory: string; env?: NodeJS.ProcessEnv }) {
  const env = input.env ?? process.env
  const worktreeRoot = resolve(input.dataDirectory, 'agent-runs')
  const evidenceStore = new LocalEvidenceStore(resolve(input.dataDirectory, 'evidence'))
  const postprocessor = new LocalRunPostprocessor({ database: input.database, evidenceStore })
  const engineExecutable = env.CONTROL_PLANE_CONTAINER_ENGINE
  const imageRef = env.CONTROL_PLANE_AGENT_IMAGE
  const containerCommand = parseStringArray(env.CONTROL_PLANE_CONTAINER_COMMAND_JSON, 'CONTROL_PLANE_CONTAINER_COMMAND_JSON')
  const processExecutable = env.CONTROL_PLANE_AGENT_EXECUTABLE
  const processArgs = parseStringArray(env.CONTROL_PLANE_AGENT_ARGS_JSON, 'CONTROL_PLANE_AGENT_ARGS_JSON')
  const processEnvironmentAllowlist = parseStringArray(env.CONTROL_PLANE_AGENT_ENV_ALLOWLIST_JSON, 'CONTROL_PLANE_AGENT_ENV_ALLOWLIST_JSON')
  const allowProcessFallback = env.CONTROL_PLANE_ALLOW_PROCESS_FALLBACK === 'true'

  if (engineExecutable && imageRef && containerCommand.length) {
    const probe = probeContainerEngine(engineExecutable)
    if (probe.available) {
      const runner = new ContainerAgentRunner({ database: input.database, worktreeRoot, postprocessor, runtime: { engineExecutable, imageRef, command: containerCommand, cpuLimit: env.CONTROL_PLANE_CONTAINER_CPUS, memoryLimit: env.CONTROL_PLANE_CONTAINER_MEMORY, pidsLimit: env.CONTROL_PLANE_CONTAINER_PIDS ? Number(env.CONTROL_PLANE_CONTAINER_PIDS) : undefined, user: env.CONTROL_PLANE_CONTAINER_USER, tmpfsSize: env.CONTROL_PLANE_CONTAINER_TMPFS } })
      return { runner, descriptor: runner.descriptor, evidenceStore }
    }
    if (!allowProcessFallback || !processExecutable) return { runner: undefined, descriptor: { id: 'container-agent@0.1', isolation: 'container', status: 'unavailable', productionEligible: false, networkEgress: 'denied', imageRef, reason: `Container configured but unavailable: ${probe.reason}` } satisfies AgentRunnerDescriptor, evidenceStore }
  }

  if (processExecutable) {
    // The provider is read here rather than at process start so that saving it in the workbench takes
    // effect on the next run: the worker process builds its own runner through this same factory.
    const provider = input.database.getAgentProviderSettings()
    const runner = new LocalCommandAgentRunner({ database: input.database, executable: processExecutable, args: processArgs, environmentAllowlist: processEnvironmentAllowlist, provider, worktreeRoot, postprocessor })
    return { runner, descriptor: { ...runner.descriptor, reason: engineExecutable ? 'Container unavailable; explicit process fallback is active.' : runner.descriptor.reason, model: provider?.model, modelProvider: provider?.providerId }, evidenceStore }
  }

  return { runner: undefined, descriptor: { id: 'agent-runner', isolation: 'unisolated_process', status: 'unavailable', productionEligible: false, networkEgress: 'unrestricted', reason: 'No container or process Agent Runtime is configured.' } satisfies AgentRunnerDescriptor, evidenceStore }
}

export type ConfiguredAgentRunner = { runner?: AgentRunner; descriptor: AgentRunnerDescriptor; evidenceStore: LocalEvidenceStore }
