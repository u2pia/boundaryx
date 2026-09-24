import type { EvaluationExperimentDescriptor, EvaluationProvider, EvaluationReliability, EvaluationTrial } from './contracts.ts'
import { digestValue } from './event-integrity.ts'

export class LocalEvaluationProvider implements EvaluationProvider {
  readonly id = 'evaluation://local-experiment-v1'

  bind(input: Omit<EvaluationExperimentDescriptor, 'providerRef' | 'experimentDigest'>): EvaluationExperimentDescriptor {
    const canonical = { providerRef: this.id, ...input }
    return { ...canonical, experimentDigest: digestValue(JSON.stringify(canonical)) }
  }

  summarize(trials: EvaluationTrial[]): EvaluationReliability {
    const passed = trials.filter((trial) => trial.result === 'passed').length
    const failed = trials.filter((trial) => trial.result === 'failed').length
    const unknown = trials.filter((trial) => trial.result === 'unknown').length
    const passAtK = passed > 0 ? 100 : 0
    const passPowerK = trials.length > 0 && passed === trials.length ? 100 : 0
    return { passed, failed, unknown, passAtK, passPowerK }
  }
}
