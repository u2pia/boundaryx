import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ControlPlaneDatabase } from './database.ts'
import type { AgentRun } from './types.ts'

/**
 * What a queued or running Run is doing, for the running Intent. The stage and the checks come from the events the
 * Control Plane recorded; the Builder's steps are the Builder's own account from APERTURE_PROGRESS_FILE, shown as
 * such and never used as evidence. The file lives next to request.json and goes when the worktree is removed, so the
 * runner copies it into an `agent_run.builder_progress` event first.
 */
export type BuilderStep = { at: string; summary: string }

export type AgentRunProgress = {
  stage: 'queued' | 'building' | 'checking'
  startedAt?: string
  deadlineAt?: string
  builderSteps: { total: number; recent: BuilderStep[] }
  checks: { declared: number; done: number; failed: number; latest?: { name: string; conclusion: string } }
}

const PROGRESS_FILE = 'progress.jsonl'
// Enough for the latest steps of any Builder; older lines are not read.
const TAIL_BYTES = 64 * 1024

export function progressPathFor(requestPath: string) {
  return join(dirname(requestPath), PROGRESS_FILE)
}

/** The Builder's steps so far: how many, and the last `limit` of them. A missing or unreadable file is no steps. */
export function readBuilderSteps(path: string, limit = 5): { total: number; recent: BuilderStep[] } {
  let text = ''
  let skipped = false
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    const descriptor = openSync(path, 'r')
    try { readSync(descriptor, buffer, 0, buffer.length, start) } finally { closeSync(descriptor) }
    text = buffer.toString('utf8')
    skipped = start > 0
  } catch {
    return { total: 0, recent: [] }
  }
  const lines = text.split('\n')
  // The first line of a tail may be cut in half; the count is approximate once the file outgrows the tail.
  if (skipped) lines.shift()
  const steps = lines.flatMap((line) => {
    try {
      const value = JSON.parse(line) as Partial<BuilderStep>
      return typeof value.summary === 'string' ? [{ at: String(value.at ?? ''), summary: value.summary.slice(0, 200) }] : []
    } catch {
      return []
    }
  })
  return { total: steps.length, recent: steps.slice(-limit) }
}

export function agentRunProgress(database: ControlPlaneDatabase, run: AgentRun): AgentRunProgress | undefined {
  if (run.status !== 'queued' && run.status !== 'running') return undefined
  const events = database.listAggregateEvents('agent_run', run.id)
  const declared = (events.find((event) => event.eventType === 'agent_run.project_manifest_bound')?.payload.checks as unknown[] | undefined)?.length ?? 0
  const completed = events.filter((event) => event.eventType === 'agent_run.check_completed')
  const latest = completed.at(-1)?.payload as { name?: string; conclusion?: string } | undefined
  const building = !events.some((event) => event.eventType === 'agent_run.change_proposed' || event.eventType === 'agent_run.change_revised')
  let plan: { requestPath: string; timeoutMs: number } | undefined
  try { plan = database.getAgentRunPlan(run.id) } catch { /* a run admitted before plans existed */ }
  const running = run.status === 'running'
  return {
    stage: running ? (building ? 'building' : 'checking') : 'queued',
    ...(running ? { startedAt: run.startedAt } : {}),
    ...(running && plan ? { deadlineAt: new Date(Date.parse(run.startedAt) + plan.timeoutMs).toISOString() } : {}),
    builderSteps: running && plan ? readBuilderSteps(progressPathFor(plan.requestPath)) : { total: 0, recent: [] },
    checks: { declared, done: completed.length, failed: completed.filter((event) => event.payload.conclusion === 'failure').length, ...(latest?.name ? { latest: { name: latest.name, conclusion: String(latest.conclusion ?? '') } } : {}) },
  }
}
