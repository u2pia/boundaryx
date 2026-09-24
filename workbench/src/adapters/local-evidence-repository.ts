import type { AgentRunEvent, EvidenceSink } from './contracts'
import { digestValue, validateEventProtocol, verifyEventChain, verifyEventProtocol } from './event-integrity.ts'

type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  key(index: number): string | null
  readonly length: number
}

export type StoredEvidencePackage = {
  schemaVersion: 'aperture.evidence-repository/v0.1'
  runId: string
  packageUri: string
  packageDigest: string
  finalizedAt: string
  events: AgentRunEvent[]
}

export class LocalEvidenceRepository implements EvidenceSink {
  private readonly prefix = 'aperture.evidence-repository.v1'
  private readonly storage: StorageLike

  constructor(storage: StorageLike) {
    this.storage = storage
  }

  async append(runId: string, event: AgentRunEvent) {
    if (event.runId !== runId) throw new Error(`Evidence event run mismatch: ${event.runId} !== ${runId}`)
    if (this.storage.getItem(this.packageKey(runId))) throw new Error(`Evidence package already finalized for ${runId}`)
    const events = [...this.readDraft(runId), event]
    if (!verifyEventChain(events)) throw new Error(`Invalid event chain for ${runId} at sequence ${event.sequence}`)
    const protocolViolations = validateEventProtocol(events)
    if (protocolViolations.length) throw new Error(`Invalid event protocol for ${runId}: ${protocolViolations.join('; ')}`)
    this.storage.setItem(this.draftKey(runId), JSON.stringify(events))
  }

  async finalize(runId: string) {
    const existing = this.readPackageByRun(runId)
    if (existing) return { packageUri: existing.packageUri, packageDigest: existing.packageDigest }
    const events = this.readDraft(runId)
    if (!events.length || events.at(-1)?.type !== 'run_completed') throw new Error(`Cannot finalize incomplete evidence for ${runId}`)
    if (!verifyEventChain(events)) throw new Error(`Cannot finalize invalid evidence for ${runId}`)
    if (!verifyEventProtocol(events)) throw new Error(`Cannot finalize invalid event protocol for ${runId}`)
    const packageUri = `local://evidence/${runId.toLowerCase()}.json`
    const record: StoredEvidencePackage = {
      schemaVersion: 'aperture.evidence-repository/v0.1',
      runId,
      packageUri,
      packageDigest: digestValue(JSON.stringify(events)),
      finalizedAt: new Date().toISOString(),
      events,
    }
    this.storage.setItem(this.packageKey(runId), JSON.stringify(record))
    this.storage.removeItem(this.draftKey(runId))
    return { packageUri, packageDigest: record.packageDigest }
  }

  readPackage(packageUri: string) {
    const runId = packageUri.match(/^local:\/\/evidence\/(.+)\.json$/)?.[1]?.toUpperCase()
    return runId ? this.readPackageByRun(runId) : null
  }

  verifyPackage(packageUri: string) {
    const record = this.readPackage(packageUri)
    return Boolean(record && record.events.at(-1)?.type === 'run_completed' && verifyEventChain(record.events) && verifyEventProtocol(record.events) && record.packageDigest === digestValue(JSON.stringify(record.events)))
  }

  restoreDraft(runId: string, events: AgentRunEvent[]) {
    if (this.storage.getItem(this.packageKey(runId))) return
    if (!events.length || !verifyEventChain(events) || !verifyEventProtocol(events) || events.at(-1)?.type === 'run_completed') throw new Error(`Cannot restore invalid evidence draft for ${runId}`)
    this.storage.setItem(this.draftKey(runId), JSON.stringify(events))
  }

  discardDraft(runId: string) {
    this.storage.removeItem(this.draftKey(runId))
  }

  clear() {
    const keys = Array.from({ length: this.storage.length }, (_, index) => this.storage.key(index)).filter((key): key is string => Boolean(key?.startsWith(this.prefix)))
    keys.forEach((key) => this.storage.removeItem(key))
  }

  private readDraft(runId: string): AgentRunEvent[] {
    const value = this.storage.getItem(this.draftKey(runId))
    return value ? JSON.parse(value) as AgentRunEvent[] : []
  }

  private readPackageByRun(runId: string): StoredEvidencePackage | null {
    const value = this.storage.getItem(this.packageKey(runId))
    return value ? JSON.parse(value) as StoredEvidencePackage : null
  }

  private draftKey(runId: string) {
    return `${this.prefix}.draft.${runId.toUpperCase()}`
  }

  private packageKey(runId: string) {
    return `${this.prefix}.package.${runId.toUpperCase()}`
  }
}
