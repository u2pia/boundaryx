// Agent Runs used to execute inside the HTTP request that started them. Because every runtime call and
// every declared check is a synchronous child process, that froze the whole Control Plane for the
// duration of a run: login, review and metrics all timed out while an agent was generating. The queue
// moves execution into a worker process per run, so the control plane stays answerable and a run that
// is going nowhere can be cancelled.
import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ControlPlaneDatabase } from './database.ts'
import { AppError, type AgentRun, type AgentRunner } from './types.ts'

const SERVER_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const DEFAULT_WORKER_ENTRY = resolve(SERVER_DIRECTORY, 'run-worker.ts')
const STDERR_TAIL_LIMIT = 8_000
const SIGKILL_GRACE_MS = 5_000

type RunningEntry = { child: ChildProcess; startedAt: number; stderrTail: string; killTimer?: NodeJS.Timeout }

export class AgentRunQueue {
  private readonly input: { database: ControlPlaneDatabase; databasePath: string; dataDirectory: string; concurrency: number; workerEntry: string; env: NodeJS.ProcessEnv; runner?: AgentRunner }
  private readonly running = new Map<string, RunningEntry>()
  private pending: string[] = []
  private closed = false

  constructor(input: { database: ControlPlaneDatabase; databasePath: string; dataDirectory: string; concurrency?: number; workerEntry?: string; env?: NodeJS.ProcessEnv; runner?: AgentRunner }) {
    this.input = { database: input.database, databasePath: input.databasePath, dataDirectory: input.dataDirectory, concurrency: Math.max(1, input.concurrency ?? 2), workerEntry: input.workerEntry ?? DEFAULT_WORKER_ENTRY, env: input.env ?? process.env, runner: input.runner }
  }

  /**
   * A run that is still `queued` or `running` in the database when the Control Plane starts belongs to a
   * process that no longer exists. Leaving it non-terminal would make it poll forever, so it is failed
   * explicitly and the reason is written to the event log. The leftover worktree of such a run — and of any
   * older run that reached a terminal state before the cleanup existed — is removed here too, which is what
   * keeps a crashed worker from leaking a checkout forever.
   */
  reconcile() {
    const orphaned = this.input.database.listUnfinishedAgentRuns()
    const reconciled: AgentRun[] = []
    for (const run of orphaned) {
      this.input.database.recordAgentRunEvent(run.id, 'agent_run.worker_lost', { previousStatus: run.status, workerPid: run.workerPid ?? null }, run.startedByActorId)
      reconciled.push(this.input.database.completeAgentRun({ runId: run.id, status: 'failed', actorId: run.startedByActorId, errorMessage: 'Control Plane restarted while the run was in flight; the worker process no longer exists' }))
    }
    for (const run of this.input.database.listTerminalAgentRunsWithWorktree()) this.cleanUpWorktree(run)
    return reconciled.map((run) => run.id)
  }

  enqueue(runId: string) {
    if (this.closed) throw new AppError(503, 'Control Plane is shutting down', 'queue_closed')
    this.pending.push(runId)
    this.pump()
    return this.position(runId)
  }

  /** 0 while executing, 1-based place in line while waiting. */
  position(runId: string) {
    if (this.running.has(runId)) return 0
    const index = this.pending.indexOf(runId)
    return index < 0 ? undefined : index + 1
  }

  cancel(runId: string, actorId: string): AgentRun {
    const run = this.input.database.requestAgentRunCancellation(runId, actorId)
    const entry = this.running.get(runId)
    if (!entry) {
      this.pending = this.pending.filter((pending) => pending !== runId)
      // Cancelled while waiting in line: no worker ever claimed it, so the worktree it was admitted with is
      // removed right here rather than in a worker process that will never run.
      const cancelled = this.input.database.completeAgentRun({ runId, status: 'cancelled', actorId, errorMessage: 'Agent run was cancelled before execution started' })
      this.cleanUpWorktree(cancelled)
      this.pump()
      return cancelled
    }
    this.signal(runId, entry, 'SIGTERM')
    return run
  }

  snapshot() {
    return { concurrency: this.input.concurrency, running: [...this.running.entries()].map(([runId, entry]) => ({ runId, pid: entry.child.pid ?? null, elapsedMs: Date.now() - entry.startedAt })), queued: [...this.pending] }
  }

  close() {
    this.closed = true
    for (const [runId, entry] of this.running) this.signal(runId, entry, 'SIGTERM')
  }

  /**
   * Signals the worker's whole process group, not just the worker: the worker spends most of its life
   * blocked in a synchronous child process, so it cannot act on a signal itself.
   */
  private signal(runId: string, entry: RunningEntry, signal: NodeJS.Signals) {
    const pid = entry.child.pid
    if (!pid) return
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        entry.child.kill(signal)
      } catch {}
    }
    if (signal === 'SIGTERM' && !entry.killTimer) {
      entry.killTimer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {}
      }, SIGKILL_GRACE_MS)
      entry.killTimer.unref()
    }
  }

  private pump() {
    while (!this.closed && this.running.size < this.input.concurrency && this.pending.length) this.start(this.pending.shift()!)
  }

  private start(runId: string) {
    const child = spawn(process.execPath, ['--experimental-strip-types', this.input.workerEntry, runId], {
      cwd: resolve(SERVER_DIRECTORY, '..'),
      // Own process group so cancellation reaches the agent and every check it spawned.
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...this.input.env, CONTROL_PLANE_DB: this.input.databasePath, CONTROL_PLANE_DATA_DIR: this.input.dataDirectory },
    })
    const entry: RunningEntry = { child, startedAt: Date.now(), stderrTail: '' }
    this.running.set(runId, entry)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { entry.stderrTail = (entry.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT) })
    child.on('error', (error) => { entry.stderrTail = `${entry.stderrTail}\n${error.message}`.slice(-STDERR_TAIL_LIMIT) })
    child.on('exit', (code, signal) => {
      if (entry.killTimer) clearTimeout(entry.killTimer)
      this.running.delete(runId)
      this.finalize(runId, code, signal, entry.stderrTail)
      this.pump()
    })
  }

  /** The worker normally writes its own terminal state. This covers the cases where it could not. */
  private finalize(runId: string, code: number | null, signal: NodeJS.Signals | null, stderrTail: string) {
    let run: AgentRun
    try {
      run = this.input.database.getAgentRun(runId)
    } catch {
      return
    }
    if (run.status !== 'queued' && run.status !== 'running') return
    const cancelled = this.input.database.isAgentRunCancellationRequested(runId)
    this.input.database.recordAgentRunEvent(runId, 'agent_run.worker_exited', { exitCode: code, signal: signal ?? null, cancelled, stderrTail: stderrTail.slice(-2_000) }, run.startedByActorId)
    const terminal = this.input.database.completeAgentRun({
      runId,
      status: cancelled ? 'cancelled' : 'failed',
      actorId: run.startedByActorId,
      errorMessage: cancelled
        ? `Agent run was cancelled (worker terminated by ${signal ?? `exit ${code}`})`
        : `Worker process exited without recording a result (${signal ? `signal ${signal}` : `exit code ${code}`}): ${stderrTail.slice(-1_000) || 'no stderr'}`,
    })
    // The worker may have been killed before it could remove its own worktree.
    this.cleanUpWorktree(terminal)
  }

  /**
   * Best-effort removal of a terminal run's worktree. A failure here is recorded by the runner as a
   * `agent_run.worktree_pruned` event with `pruned: false`; it never changes the run's conclusion, and the
   * next Control Plane start retries every run that still has no successful cleanup event.
   */
  private cleanUpWorktree(run: AgentRun) {
    if (!this.input.runner?.cleanUpWorktree) return
    try {
      this.input.runner.cleanUpWorktree(run, run.startedByActorId)
    } catch (error) {
      this.input.database.recordAgentRunEvent(run.id, 'agent_run.worktree_pruned', { worktreePath: run.worktreePath, branchRef: run.branchRef, repositoryPath: run.repositoryPath, pruned: false, skippedPaths: [run.worktreePath], error: error instanceof Error ? error.message : String(error), proposalBranchPreserved: true, evidencePreserved: true }, run.startedByActorId)
    }
  }
}
