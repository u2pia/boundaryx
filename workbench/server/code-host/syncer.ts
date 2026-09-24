import { SYSTEM_CODE_HOST_ACTOR_ID, type ControlPlaneDatabase } from '../database.ts'
import { AppError, type ChangeProposal, type CodeHostLink, type Project } from '../types.ts'
import { GATE_STATUS_CONTEXT, GithubCodeHost } from './github.ts'
import { codeHostFor } from './index.ts'

export type CodeHostSyncReport = {
  projectId: string
  syncedAt: string
  published: number
  checksImported: number
  gateUpdates: number
  merged: number
  closed: number
  errors: Array<{ proposalId?: string; code: string; message: string }>
}

type GateState = { state: 'pending' | 'success' | 'failure'; description: string }

/**
 * Keeps hosted projects and their host in step, from the control plane's own process — a run's worker never holds
 * a host credential. Polls rather than receiving webhooks: the server listens on loopback and GitHub cannot reach
 * it. Every host fact it records (checks, merges, closures) is recorded as the code-host system actor, so the audit
 * trail separates what GitHub reported from what a person decided.
 */
export class CodeHostSyncer {
  private readonly database: ControlPlaneDatabase
  private readonly env: NodeJS.ProcessEnv
  private readonly publicUrl?: string
  private readonly running = new Map<string, Promise<CodeHostSyncReport>>()
  private timer?: NodeJS.Timeout
  private readonly lastReports = new Map<string, CodeHostSyncReport>()

  constructor(input: { database: ControlPlaneDatabase; env?: NodeJS.ProcessEnv; publicUrl?: string }) {
    this.database = input.database
    this.env = input.env ?? process.env
    this.publicUrl = input.publicUrl?.replace(/\/+$/u, '')
  }

  start(intervalSeconds: number) {
    if (intervalSeconds <= 0) return
    this.timer = setInterval(() => void this.syncAll(), intervalSeconds * 1000)
    this.timer.unref()
  }

  close() {
    if (this.timer) clearInterval(this.timer)
  }

  lastReport(projectId: string) {
    return this.lastReports.get(projectId)
  }

  /** Called after a decision so the host reflects it without waiting for the next tick. Never throws. */
  nudge(projectId: string) {
    const project = this.database.getProject(projectId)
    if (project.codeHost !== 'github' || project.status !== 'active') return
    setTimeout(() => void this.syncProject(projectId).catch(() => undefined), 0).unref()
  }

  async syncAll() {
    const projects = this.database.listProjects().filter((project) => project.codeHost === 'github' && project.status === 'active')
    return Promise.all(projects.map((project) => this.syncProject(project.id).catch((error: unknown) => this.failedReport(project.id, error))))
  }

  /** One sync per project at a time; a caller arriving mid-sync waits for the one already running. */
  syncProject(projectId: string): Promise<CodeHostSyncReport> {
    const active = this.running.get(projectId)
    if (active) return active
    const run = this.runProject(projectId).finally(() => this.running.delete(projectId))
    this.running.set(projectId, run)
    return run
  }

  private failedReport(projectId: string, error: unknown): CodeHostSyncReport {
    const report = { projectId, syncedAt: new Date().toISOString(), published: 0, checksImported: 0, gateUpdates: 0, merged: 0, closed: 0, errors: [describe(error)] }
    this.lastReports.set(projectId, report)
    return report
  }

  private async runProject(projectId: string): Promise<CodeHostSyncReport> {
    const project = this.database.getProject(projectId)
    if (project.status !== 'active') throw new AppError(409, `Project ${project.slug} is archived`, 'project_archived')
    const host = codeHostFor(project, { dataDirectory: this.database.dataDirectory, env: this.env })
    if (!(host instanceof GithubCodeHost)) throw new AppError(409, `Project ${project.slug} is not hosted on a code host that syncs`, 'code_host_not_syncable')
    const report: CodeHostSyncReport = { projectId, syncedAt: new Date().toISOString(), published: 0, checksImported: 0, gateUpdates: 0, merged: 0, closed: 0, errors: [] }
    try {
      host.prepareForRun()
    } catch (error) {
      report.errors.push(describe(error))
      this.lastReports.set(projectId, report)
      return report
    }
    for (const proposal of this.database.listSyncableProposals(projectId)) {
      try {
        await this.syncProposal(project, host, proposal, report)
      } catch (error) {
        report.errors.push({ proposalId: proposal.id, ...describe(error) })
        if (this.database.getCodeHostLink(proposal.id)) this.database.recordCodeHostLinkError(proposal.id, describe(error).message)
      }
    }
    this.lastReports.set(projectId, report)
    return report
  }

  private async syncProposal(project: Project, host: GithubCodeHost, proposal: ChangeProposal, report: CodeHostSyncReport) {
    let link = this.database.getCodeHostLink(proposal.id)
    const open = proposal.status !== 'merged' && proposal.status !== 'closed'
    if (open && (!link || link.headShaPublished !== proposal.headSha)) {
      const published = await host.publishProposal({ proposal, title: this.title(proposal), body: this.body(project, proposal), externalId: link?.externalId })
      link = this.save(link, { changeProposalId: proposal.id, projectId: project.id, provider: 'github', ...published, state: 'open', gateStatePublished: undefined, gateShaPublished: undefined, gateDescriptionPublished: undefined })
      report.published += 1
    }
    if (!link) return

    const pull = await host.getPullRequest(link.externalId)
    if (pull.merged) {
      if (proposal.status !== 'merged') {
        if (!pull.mergedSha) throw new AppError(502, `Pull request ${pull.url} is merged but reports no merge commit`, 'code_host_api_failed')
        // prepareForRun fetched the default branch, which is where the merge commit landed.
        const contentCheck = host.compareMergedContent({ approvedHeadSha: proposal.headSha, baseSha: proposal.baseSha, mergedSha: pull.mergedSha, commits: pull.commits })
        const gateStateAtMerge = link.gateShaPublished === proposal.headSha && link.gateStatePublished ? link.gateStatePublished : 'unpublished'
        this.database.recordHostMerge({ proposalId: proposal.id, mergedSha: pull.mergedSha, host: { provider: 'github', externalId: link.externalId, url: link.url, mergedBy: pull.mergedBy, hostMergedAt: pull.mergedAt, contentCheck, gateStateAtMerge, hostHeadSha: pull.headSha } }, SYSTEM_CODE_HOST_ACTOR_ID)
        report.merged += 1
      }
      this.save(link, { ...link, state: 'merged', lastError: undefined })
      return
    }
    if (pull.state === 'closed') {
      if (this.database.closeProposalOnHost({ proposalId: proposal.id, url: link.url }, SYSTEM_CODE_HOST_ACTOR_ID)) report.closed += 1
      this.save(link, { ...link, state: 'closed', lastError: undefined })
      return
    }
    // Merged here and pushed: the host marks the pull request merged on its own, and the next pass records that.
    if (proposal.status === 'merged') return

    if (open) report.checksImported += this.importChecks(proposal, await host.listChecks(proposal.headSha), link.url)
    const gate = this.gateFor(proposal.id)
    // The description is compared too: "waiting for review" turning into "approved; waiting for evidence" is news.
    if (link.gateShaPublished !== proposal.headSha || link.gateStatePublished !== gate.state || link.gateDescriptionPublished !== gate.description) {
      await host.setGateStatus(proposal.headSha, gate.state, gate.description, this.publicUrl ? `${this.publicUrl}/#reviews` : undefined)
      link = this.save(link, { ...link, gateStatePublished: gate.state, gateShaPublished: proposal.headSha, gateDescriptionPublished: gate.description, lastError: undefined })
      report.gateUpdates += 1
    } else if (link.lastError) {
      this.save(link, { ...link, lastError: undefined })
    }
  }

  /** Host checks become external checks named `github/…`; only a change in status or conclusion is recorded. */
  private importChecks(proposal: ChangeProposal, checks: Awaited<ReturnType<GithubCodeHost['listChecks']>>, url: string) {
    const recorded = new Map(this.database.getReviewReadiness(proposal.id).checks.map((check) => [check.name, check]))
    let imported = 0
    for (const check of checks) {
      const name = `github/${check.name}`
      const existing = recorded.get(name)
      if (existing && (existing.source === 'run' || (existing.status === check.status && existing.conclusion === check.conclusion))) continue
      this.database.recordCheck({ proposalId: proposal.id, headSha: proposal.headSha, name, status: check.status, conclusion: check.conclusion, evidenceRef: url, source: 'external' }, SYSTEM_CODE_HOST_ACTOR_ID)
      imported += 1
    }
    return imported
  }

  /** `success` means exactly what a merge here would need: approved at this head with complete, passing evidence. */
  private gateFor(proposalId: string): GateState {
    const proposal = this.database.getChangeProposal(proposalId)
    const readiness = this.database.getReviewReadiness(proposalId)
    if (proposal.status === 'closed') return { state: 'failure', description: 'Rejected on the BoundaryX control plane' }
    if (proposal.status === 'changes_requested') return { state: 'failure', description: 'Changes requested on the BoundaryX control plane' }
    if (readiness.status === 'blocked') return { state: 'failure', description: `Blocked: ${readiness.blockers[0] ?? 'evidence gate failed'}` }
    if (proposal.status === 'approved' && readiness.status === 'ready') return { state: 'success', description: 'Approved on the BoundaryX control plane; evidence complete' }
    return { state: 'pending', description: proposal.status === 'approved' ? `Approved; waiting for evidence: ${readiness.blockers[0] ?? readiness.status}` : `Waiting for review on the BoundaryX control plane (evidence ${readiness.status})` }
  }

  private save(previous: CodeHostLink | undefined, next: Omit<CodeHostLink, 'syncedAt'>) {
    return this.database.saveCodeHostLink({ ...next, lastError: next.lastError }, SYSTEM_CODE_HOST_ACTOR_ID) ?? previous
  }

  private title(proposal: ChangeProposal) {
    return `[BoundaryX ${proposal.id}] ${this.database.getWorkItem(proposal.workItemId).title}`.slice(0, 250)
  }

  private body(project: Project, proposal: ChangeProposal) {
    const intent = this.database.getIntentVersion(proposal.intentVersionId)
    return [
      `Published by the BoundaryX control plane for project \`${project.slug}\`.`,
      '',
      `- Change proposal: \`${proposal.id}\`${this.publicUrl ? ` (${this.publicUrl}/#reviews)` : ''}`,
      `- Intent: ${intent.goal.slice(0, 500)}`,
      `- Base \`${proposal.baseSha.slice(0, 12)}\` → head \`${proposal.headSha.slice(0, 12)}\``,
      '',
      `Review and approve on the control plane — it is the review authority. The \`${GATE_STATUS_CONTEXT}\` status reflects its gate${project.mergeMode === 'host_protected' ? '; make it a required status check in branch protection before merging here' : '; the control plane merges and pushes once the gate passes'}.`,
    ].join('\n')
  }
}

function describe(error: unknown) {
  return { code: error instanceof AppError ? error.code : 'code_host_sync_failed', message: error instanceof Error ? error.message : String(error) }
}
