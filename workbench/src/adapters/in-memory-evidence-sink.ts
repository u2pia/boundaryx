import type { AgentRunEvent, EvidenceSink } from './contracts'
import { digestValue, validateEventProtocol, verifyEventChain } from './event-integrity.ts'

export class InMemoryEvidenceSink implements EvidenceSink {
  private eventsByRun = new Map<string, AgentRunEvent[]>()

  async append(runId: string, event: AgentRunEvent) {
    if (event.runId !== runId) throw new Error(`Evidence event run mismatch: ${event.runId} !== ${runId}`)
    const events = [...(this.eventsByRun.get(runId) ?? []), event]
    if (!verifyEventChain(events)) throw new Error(`Invalid event chain for ${runId} at sequence ${event.sequence}`)
    const protocolViolations = validateEventProtocol(events)
    if (protocolViolations.length) throw new Error(`Invalid event protocol for ${runId}: ${protocolViolations.join('; ')}`)
    this.eventsByRun.set(runId, events)
  }

  async finalize(runId: string) {
    const events = this.eventsByRun.get(runId) ?? []
    if (!events.length || events.at(-1)?.type !== 'run_completed') throw new Error(`Cannot finalize incomplete evidence for ${runId}`)
    if (!verifyEventChain(events)) throw new Error(`Cannot finalize invalid evidence for ${runId}`)
    const protocolViolations = validateEventProtocol(events)
    if (protocolViolations.length) throw new Error(`Cannot finalize invalid event protocol for ${runId}: ${protocolViolations.join('; ')}`)
    return {
      packageUri: `memory://evidence/${runId.toLowerCase()}.json`,
      packageDigest: digestValue(JSON.stringify(events)),
    }
  }
}
