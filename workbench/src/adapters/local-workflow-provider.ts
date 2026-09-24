import type { AgentRunEvent, AgentRunRequest, WorkflowExecutionRecord, WorkflowProvider, WorkflowRecoveryCursor } from './contracts.ts'
import { digestValue, validateEventProtocol, verifyEventChain } from './event-integrity.ts'

type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  key(index: number): string | null
  readonly length: number
}

type UnsignedWorkflowExecutionRecord = Omit<WorkflowExecutionRecord, 'recordDigest'>

export class LocalWorkflowProvider implements WorkflowProvider {
  readonly id = 'workflow://local-storage-v1'
  private readonly prefix = 'aperture.workflow-provider.v1'
  private readonly storage: StorageLike

  constructor(storage: StorageLike) {
    this.storage = storage
  }

  start(request: AgentRunRequest, label: string) {
    const existing = this.read(request.runId)
    const requestDigest = digestValue(JSON.stringify(request))
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new Error(`Workflow request mismatch for ${request.runId}`)
      if (existing.status === 'completed') throw new Error(`Workflow already completed for ${request.runId}`)
      return existing
    }
    const now = new Date().toISOString()
    return this.write({
      schemaVersion: 'aperture.workflow-execution/v0.1',
      runId: request.runId,
      label,
      request,
      requestDigest,
      status: 'running',
      recoveryCount: 0,
      startedAt: now,
      updatedAt: now,
      events: [],
      chainHead: 'genesis',
    })
  }

  append(runId: string, event: AgentRunEvent) {
    const current = this.requireRecord(runId)
    if (current.status === 'completed') {
      const existingEvent = current.events[event.sequence - 1]
      if (existingEvent?.eventDigest === event.eventDigest) return current
      throw new Error(`Workflow already completed for ${runId}`)
    }
    if (current.status === 'interrupted' && event.type !== 'run_completed') throw new Error(`Interrupted workflow must be recovered before append: ${runId}`)
    if (event.runId !== runId) throw new Error(`Workflow event run mismatch: ${event.runId} !== ${runId}`)
    const existingEvent = current.events[event.sequence - 1]
    if (existingEvent) {
      if (existingEvent.eventDigest === event.eventDigest) return current
      throw new Error(`Divergent duplicate workflow event for ${runId} at sequence ${event.sequence}`)
    }
    const events = [...current.events, event]
    if (!verifyEventChain(events)) throw new Error(`Invalid workflow event chain for ${runId} at sequence ${event.sequence}`)
    const violations = validateEventProtocol(events)
    if (violations.length) throw new Error(`Invalid workflow protocol for ${runId}: ${violations.join('; ')}`)
    const binding = events.find((candidate): candidate is Extract<AgentRunEvent, { type: 'workflow_bound' }> => candidate.type === 'workflow_bound')
    const completed = event.type === 'run_completed'
    return this.write({
      ...this.unsigned(current),
      workflowId: binding?.workflowId,
      providerRef: binding?.providerRef,
      status: completed ? 'completed' : 'running',
      interruptReason: completed ? undefined : current.interruptReason,
      updatedAt: event.occurredAt,
      events,
      chainHead: event.eventDigest,
    })
  }

  interrupt(runId: string, reason: string) {
    const current = this.requireRecord(runId)
    if (current.status === 'completed') return current
    return this.write({ ...this.unsigned(current), status: 'interrupted', interruptReason: reason, updatedAt: new Date().toISOString() })
  }

  recover(runId: string): WorkflowRecoveryCursor {
    const current = this.requireRecord(runId)
    if (current.status === 'completed') throw new Error(`Completed workflow cannot be recovered: ${runId}`)
    if (!this.verify(runId)) throw new Error(`Invalid workflow record cannot be recovered: ${runId}`)
    const lastEvent = current.events.at(-1)
    const checkpoint = current.events.filter((event): event is Extract<AgentRunEvent, { type: 'checkpoint_saved' }> => event.type === 'checkpoint_saved').at(-1)
    const recovered = this.write({ ...this.unsigned(current), status: 'running', recoveryCount: current.recoveryCount + 1, interruptReason: undefined, updatedAt: new Date().toISOString() })
    return {
      runId,
      workflowId: recovered.workflowId,
      nextSequence: (lastEvent?.sequence ?? 0) + 1,
      previousEventDigest: lastEvent?.eventDigest ?? 'genesis',
      checkpoint,
      recoveryCount: recovered.recoveryCount,
    }
  }

  read(runId: string) {
    const value = this.storage.getItem(this.key(runId))
    return value ? JSON.parse(value) as WorkflowExecutionRecord : null
  }

  latestRecoverable() {
    return this.list()
      .filter((record) => record.status !== 'completed' && record.events.length > 0 && this.verify(record.runId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
  }

  verify(runId: string) {
    const record = this.read(runId)
    if (!record || record.schemaVersion !== 'aperture.workflow-execution/v0.1') return false
    if (record.request.runId !== record.runId || record.requestDigest !== digestValue(JSON.stringify(record.request))) return false
    if (record.events.length && (!verifyEventChain(record.events) || validateEventProtocol(record.events).length > 0)) return false
    if (record.chainHead !== (record.events.at(-1)?.eventDigest ?? 'genesis')) return false
    if (record.status === 'completed' && record.events.at(-1)?.type !== 'run_completed') return false
    if (record.status !== 'completed' && record.events.at(-1)?.type === 'run_completed') return false
    return record.recordDigest === this.computeRecordDigest(this.unsigned(record))
  }

  discard(runId: string) {
    this.storage.removeItem(this.key(runId))
  }

  clear() {
    this.listKeys().forEach((key) => this.storage.removeItem(key))
  }

  private requireRecord(runId: string) {
    const record = this.read(runId)
    if (!record) throw new Error(`Workflow not started for ${runId}`)
    if (!this.verify(runId)) throw new Error(`Workflow record failed verification for ${runId}`)
    return record
  }

  private write(record: UnsignedWorkflowExecutionRecord) {
    const signed: WorkflowExecutionRecord = { ...record, recordDigest: this.computeRecordDigest(record) }
    this.storage.setItem(this.key(record.runId), JSON.stringify(signed))
    return signed
  }

  private unsigned(record: WorkflowExecutionRecord): UnsignedWorkflowExecutionRecord {
    const { recordDigest: _recordDigest, ...unsigned } = record
    return unsigned
  }

  private computeRecordDigest(record: UnsignedWorkflowExecutionRecord) {
    return digestValue(JSON.stringify(record))
  }

  private list() {
    return this.listKeys().map((key) => JSON.parse(this.storage.getItem(key)!) as WorkflowExecutionRecord)
  }

  private listKeys() {
    return Array.from({ length: this.storage.length }, (_, index) => this.storage.key(index)).filter((key): key is string => Boolean(key?.startsWith(this.prefix)))
  }

  private key(runId: string) {
    return `${this.prefix}.execution.${runId.toUpperCase()}`
  }
}
