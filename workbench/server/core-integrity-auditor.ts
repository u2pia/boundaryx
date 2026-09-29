import { join } from 'node:path'
import type { ControlPlaneDatabase } from './database.ts'
import { LocalEvidenceStore } from './local-evidence-store.ts'
import { readOperationalEvidence } from './operational-evidence.ts'
import { sha256 } from './security.ts'

export type IntegritySeverity = 'critical' | 'warning' | 'info'

export type IntegrityFinding = {
  severity: IntegritySeverity
  code: string
  message: string
  aggregateType?: string
  aggregateId?: string
}

export type CoreIntegrityReport = {
  schemaVersion: 'aperture.core-integrity.v1'
  generatedAt: string
  valid: boolean
  summary: { critical: number; warning: number; info: number; aggregateCount: number; eventCount: number; checkedBindings: number }
  findings: IntegrityFinding[]
  eventSeal: ReturnType<ControlPlaneDatabase['getEventSealStatus']>
}

type StoredEvent = { aggregateType: string; aggregateId: string; eventType: string; actorId: string | null; payload: Record<string, unknown> }

export function auditCoreIntegrity(input: { database: ControlPlaneDatabase; evidenceDirectory?: string; env?: NodeJS.ProcessEnv }): CoreIntegrityReport {
  const { database } = input
  const env = input.env ?? process.env
  const findings: IntegrityFinding[] = []
  let aggregateCount = 0
  let eventCount = 0
  let checkedBindings = 0
  const add = (finding: IntegrityFinding) => findings.push(finding)

  const quickCheck = (database.db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>).map((row) => row.quick_check)
  if (quickCheck.length !== 1 || quickCheck[0] !== 'ok') add({ severity: 'critical', code: 'sqlite_quick_check_failed', message: `SQLite quick_check failed: ${quickCheck.join(', ')}` })
  const foreignKeyFaults = database.db.prepare('PRAGMA foreign_key_check').all() as Array<Record<string, unknown>>
  if (foreignKeyFaults.length) add({ severity: 'critical', code: 'foreign_key_check_failed', message: `${foreignKeyFaults.length} foreign key violation(s) found` })

  const eventRows = database.db.prepare('SELECT aggregate_type, aggregate_id, event_type, actor_id, payload_json FROM domain_events ORDER BY aggregate_type, aggregate_id, aggregate_version').all() as Array<{ aggregate_type: string; aggregate_id: string; event_type: string; actor_id: string | null; payload_json: string }>
  const events = new Map<string, StoredEvent[]>()
  for (const row of eventRows) {
    try {
      const key = `${row.aggregate_type}\u0000${row.aggregate_id}`
      const event: StoredEvent = { aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, eventType: row.event_type, actorId: row.actor_id, payload: JSON.parse(row.payload_json) as Record<string, unknown> }
      events.set(key, [...(events.get(key) ?? []), event])
    } catch {
      add({ severity: 'critical', code: 'event_payload_invalid', message: `Event payload is not valid JSON`, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id })
    }
  }
  aggregateCount = events.size
  eventCount = eventRows.length
  for (const key of events.keys()) {
    const [aggregateType, aggregateId] = key.split('\u0000')
    try {
      const integrity = database.getEventIntegrity(aggregateType, aggregateId)
      if (!integrity.valid) add({ severity: 'critical', code: 'event_chain_invalid', message: integrity.faults.join('; '), aggregateType, aggregateId })
    } catch (error) {
      add({ severity: 'critical', code: 'event_chain_unreadable', message: error instanceof Error ? error.message : String(error), aggregateType, aggregateId })
    }
  }

  const eventFor = (aggregateType: string, aggregateId: string, eventType: string, predicate: (event: StoredEvent) => boolean) => (events.get(`${aggregateType}\u0000${aggregateId}`) ?? []).findLast((event) => event.eventType === eventType && predicate(event))
  const requireBinding = (input: { aggregateType: string; aggregateId: string; eventType: string; code: string; message: string; predicate: (event: StoredEvent) => boolean }) => {
    checkedBindings += 1
    if (!eventFor(input.aggregateType, input.aggregateId, input.eventType, input.predicate)) add({ severity: 'critical', code: input.code, message: input.message, aggregateType: input.aggregateType, aggregateId: input.aggregateId })
  }

  const actors = database.db.prepare("SELECT id, username, display_name, role, status FROM actors WHERE username NOT LIKE 'system:%'").all() as Array<{ id: string; username: string; display_name: string; role: string; status: string }>
  for (const actor of actors) {
    requireBinding({ aggregateType: 'actor', aggregateId: actor.id, eventType: 'actor.created', code: 'actor_creation_unbound', message: `Actor ${actor.username} has no matching creation event`, predicate: (event) => event.payload.username === actor.username })
    checkedBindings += 1
    const actorEvents = events.get(`actor\u0000${actor.id}`) ?? []
    const created = actorEvents.find((event) => event.eventType === 'actor.created')
    if (!created) continue
    const replayed = { username: String(created.payload.username), displayName: String(created.payload.displayName), role: String(created.payload.role), status: 'active' }
    for (const event of actorEvents.filter((item) => item.eventType === 'actor.updated')) {
      for (const [field, target] of [['displayName', 'displayName'], ['role', 'role'], ['status', 'status']] as const) {
        const change = event.payload[field] as { to?: unknown } | undefined
        if (change?.to !== undefined) replayed[target] = String(change.to)
      }
    }
    if (replayed.username !== actor.username || replayed.displayName !== actor.display_name || replayed.role !== actor.role || replayed.status !== actor.status) add({ severity: 'critical', code: 'actor_state_event_mismatch', message: `Actor ${actor.id} current state does not match replayed actor events`, aggregateType: 'actor', aggregateId: actor.id })
  }

  const workItems = database.db.prepare('SELECT id, title, owner_actor_id, authority_ref FROM work_items').all() as Array<{ id: string; title: string; owner_actor_id: string; authority_ref: string }>
  for (const item of workItems) requireBinding({ aggregateType: 'work_item', aggregateId: item.id, eventType: 'work_item.created', code: 'work_item_creation_unbound', message: `Work Item ${item.id} has no matching creation event`, predicate: (event) => event.payload.title === item.title && event.payload.ownerActorId === item.owner_actor_id && event.payload.authorityRef === item.authority_ref })

  const intents = database.db.prepare('SELECT id, work_item_id, version, content_digest, status, approved_by, approval_basis FROM intent_versions').all() as Array<{ id: string; work_item_id: string; version: number; content_digest: string; status: string; approved_by: string | null; approval_basis: string | null }>
  for (const intent of intents) {
    requireBinding({ aggregateType: 'work_item', aggregateId: intent.work_item_id, eventType: 'intent.versioned', code: 'intent_version_unbound', message: `Intent ${intent.id} has no matching version event`, predicate: (event) => event.payload.intentVersionId === intent.id && event.payload.version === intent.version && event.payload.contentDigest === intent.content_digest })
    if (intent.status === 'approved') requireBinding({ aggregateType: 'work_item', aggregateId: intent.work_item_id, eventType: 'intent.approved', code: 'intent_approval_unbound', message: `Approved Intent ${intent.id} has no matching approval event`, predicate: (event) => event.payload.intentVersionId === intent.id && event.payload.contentDigest === intent.content_digest && event.payload.basis === intent.approval_basis && (!intent.approved_by || event.actorId === intent.approved_by) })
    checkedBindings += 1
    const stored = database.getIntentVersion(intent.id)
    const acceptanceCriteria = stored.acceptanceCriteria.map((criterion) => ({ statement: criterion.statement, criticality: criterion.criticality, verificationType: criterion.verificationType, ...(criterion.verifiedBy?.length ? { verifiedBy: criterion.verifiedBy } : {}) }))
    const canonical = { workItemId: stored.workItemId, version: stored.version, goal: stored.goal, constraints: stored.constraints, ...(stored.nonGoals?.length ? { nonGoals: stored.nonGoals } : {}), ...(stored.examples?.length ? { examples: stored.examples.map((example) => ({ input: example.input, expected: example.expected })) } : {}), riskLevel: stored.riskLevel, acceptanceCriteria }
    if (`sha256:${sha256(JSON.stringify(canonical))}` !== stored.contentDigest) add({ severity: 'critical', code: 'intent_content_digest_mismatch', message: `Intent ${intent.id} content no longer matches its digest`, aggregateType: 'work_item', aggregateId: intent.work_item_id })
  }

  const proposals = database.db.prepare('SELECT id, work_item_id, intent_version_id, base_sha, head_sha, author_actor_id FROM change_proposals').all() as Array<{ id: string; work_item_id: string; intent_version_id: string; base_sha: string; head_sha: string; author_actor_id: string }>
  for (const proposal of proposals) {
    requireBinding({ aggregateType: 'change_proposal', aggregateId: proposal.id, eventType: 'change_proposal.created', code: 'proposal_creation_unbound', message: `Change Proposal ${proposal.id} has no matching creation event`, predicate: (event) => event.payload.workItemId === proposal.work_item_id && event.payload.intentVersionId === proposal.intent_version_id && event.payload.authorActorId === proposal.author_actor_id })
    checkedBindings += 1
    const headEvent = (events.get(`change_proposal\u0000${proposal.id}`) ?? []).filter((event) => event.eventType === 'change_proposal.created' || event.eventType === 'change_proposal.revision_changed').at(-1)
    if (!headEvent || headEvent.payload.headSha !== proposal.head_sha) add({ severity: 'critical', code: 'proposal_head_unbound', message: `Change Proposal ${proposal.id} current Head SHA is not the latest revision recorded by its events`, aggregateType: 'change_proposal', aggregateId: proposal.id })
    if (headEvent?.payload.baseSha !== undefined && headEvent.payload.baseSha !== proposal.base_sha) add({ severity: 'critical', code: 'proposal_base_unbound', message: `Change Proposal ${proposal.id} current Base SHA is not the latest revision recorded by its events`, aggregateType: 'change_proposal', aggregateId: proposal.id })
    else if (headEvent?.eventType === 'change_proposal.revision_changed' && headEvent.payload.baseSha === undefined) add({ severity: 'warning', code: 'proposal_base_legacy_event', message: `Change Proposal ${proposal.id} was revised before revision events recorded Base SHA; current Base cannot be independently reconciled`, aggregateType: 'change_proposal', aggregateId: proposal.id })
  }

  const checks = database.db.prepare('SELECT id, change_proposal_id, head_sha, name, status, conclusion, source, run_id FROM check_runs').all() as Array<{ id: string; change_proposal_id: string; head_sha: string; name: string; status: string; conclusion: string | null; source: string; run_id: string | null }>
  for (const check of checks) requireBinding({ aggregateType: 'change_proposal', aggregateId: check.change_proposal_id, eventType: 'check.recorded', code: 'check_unbound', message: `Check ${check.id} has no matching recorded event`, predicate: (event) => event.payload.checkId === check.id && event.payload.headSha === check.head_sha && event.payload.name === check.name && event.payload.status === check.status && (event.payload.conclusion ?? null) === check.conclusion && event.payload.source === check.source && (event.payload.runId ?? null) === check.run_id })

  const evidenceStore = new LocalEvidenceStore(input.evidenceDirectory ?? join(database.dataDirectory, 'evidence'), { create: false })
  const evidenceRows = database.db.prepare('SELECT id, change_proposal_id, head_sha, uri, sha256, summary_json FROM evidence_packages').all() as Array<{ id: string; change_proposal_id: string; head_sha: string; uri: string; sha256: string; summary_json: string }>
  for (const evidence of evidenceRows) {
    const summaryDigest = `sha256:${sha256(JSON.stringify(JSON.parse(evidence.summary_json)))}`
    requireBinding({ aggregateType: 'change_proposal', aggregateId: evidence.change_proposal_id, eventType: 'evidence.recorded', code: 'evidence_unbound', message: `Evidence ${evidence.id} has no matching recorded event`, predicate: (event) => event.payload.evidenceId === evidence.id && event.payload.headSha === evidence.head_sha && event.payload.uri === evidence.uri && event.payload.sha256 === evidence.sha256 && event.payload.summaryDigest === summaryDigest })
    if (evidence.uri.startsWith('local://evidence/')) {
      try { evidenceStore.read(evidence.uri, evidence.sha256) } catch (error) { add({ severity: 'critical', code: 'evidence_package_invalid', message: `Evidence ${evidence.id}: ${error instanceof Error ? error.message : String(error)}`, aggregateType: 'change_proposal', aggregateId: evidence.change_proposal_id }) }
    } else add({ severity: 'warning', code: 'external_evidence_not_verified', message: `Evidence ${evidence.id} uses external URI ${evidence.uri}; this local audit cannot verify its bytes`, aggregateType: 'change_proposal', aggregateId: evidence.change_proposal_id })
  }

  const reviews = database.db.prepare('SELECT id, change_proposal_id, head_sha, reviewer_actor_id, decision FROM review_decisions').all() as Array<{ id: string; change_proposal_id: string; head_sha: string; reviewer_actor_id: string; decision: string }>
  for (const review of reviews) requireBinding({ aggregateType: 'change_proposal', aggregateId: review.change_proposal_id, eventType: `review.${review.decision}`, code: 'review_decision_unbound', message: `Review ${review.id} has no matching decision event`, predicate: (event) => event.payload.reviewId === review.id && event.payload.headSha === review.head_sha && event.actorId === review.reviewer_actor_id })

  const assignments = database.db.prepare('SELECT id, change_proposal_id, assignee_actor_id, head_sha FROM review_assignments').all() as Array<{ id: string; change_proposal_id: string; assignee_actor_id: string; head_sha: string }>
  for (const assignment of assignments) {
    requireBinding({ aggregateType: 'change_proposal', aggregateId: assignment.change_proposal_id, eventType: 'review.assigned', code: 'review_assignment_unbound', message: `Review Assignment ${assignment.id} has no matching assignment event`, predicate: (event) => event.payload.assignmentId === assignment.id && event.payload.assigneeActorId === assignment.assignee_actor_id })
    checkedBindings += 1
    const assignmentHeadBound = (events.get(`change_proposal\u0000${assignment.change_proposal_id}`) ?? []).some((event) => (event.eventType === 'review.assigned' && event.payload.assignmentId === assignment.id && event.payload.headSha === assignment.head_sha) || (event.eventType === 'change_proposal.revision_changed' && event.payload.assignmentReset === assignment.id && event.payload.headSha === assignment.head_sha))
    if (!assignmentHeadBound) add({ severity: 'critical', code: 'review_assignment_head_unbound', message: `Review Assignment ${assignment.id} current Head SHA is not recorded by assignment or revision events`, aggregateType: 'change_proposal', aggregateId: assignment.change_proposal_id })
  }

  const governance = database.db.prepare('SELECT id, change_proposal_id, head_sha, decision_type, actor_id FROM governance_decisions').all() as Array<{ id: string; change_proposal_id: string; head_sha: string; decision_type: 'override' | 'reject'; actor_id: string }>
  for (const decision of governance) requireBinding({ aggregateType: 'change_proposal', aggregateId: decision.change_proposal_id, eventType: decision.decision_type === 'override' ? 'decision.override_recorded' : 'decision.rejected', code: 'governance_decision_unbound', message: `Governance Decision ${decision.id} has no matching event`, predicate: (event) => event.payload.decisionId === decision.id && event.payload.headSha === decision.head_sha && event.actorId === decision.actor_id })

  const merges = database.db.prepare('SELECT id, change_proposal_id, evidence_digest, merged_sha FROM merge_evidence').all() as Array<{ id: string; change_proposal_id: string; evidence_digest: string; merged_sha: string }>
  for (const merge of merges) {
    requireBinding({ aggregateType: 'change_proposal', aggregateId: merge.change_proposal_id, eventType: 'change_proposal.merged', code: 'merge_evidence_unbound', message: `Merge Evidence ${merge.id} has no matching event`, predicate: (event) => event.payload.mergeEvidenceId === merge.id && event.payload.evidenceDigest === merge.evidence_digest && event.payload.mergedSha === merge.merged_sha })
    checkedBindings += 1
    try { database.getMergeEvidence(merge.change_proposal_id) } catch (error) { add({ severity: 'critical', code: 'merge_evidence_invalid', message: error instanceof Error ? error.message : String(error), aggregateType: 'change_proposal', aggregateId: merge.change_proposal_id }) }
  }

  const releases = database.db.prepare('SELECT id, change_proposal_id, merge_evidence_id, commit_sha, source_tree_digest, content_digest, status FROM release_candidates').all() as Array<{ id: string; change_proposal_id: string; merge_evidence_id: string; commit_sha: string; source_tree_digest: string; content_digest: string; status: string }>
  for (const release of releases) {
    requireBinding({ aggregateType: 'release_candidate', aggregateId: release.id, eventType: 'release_candidate.created', code: 'release_candidate_unbound', message: `Release Candidate ${release.id} has no matching creation event`, predicate: (event) => event.payload.changeProposalId === release.change_proposal_id && event.payload.mergeEvidenceId === release.merge_evidence_id && event.payload.commitSha === release.commit_sha && event.payload.sourceTreeDigest === release.source_tree_digest && event.payload.contentDigest === release.content_digest })
    if (release.status === 'approved') {
      const approval = database.db.prepare('SELECT id, approver_actor_id, candidate_content_digest FROM release_approvals WHERE release_candidate_id = ?').get(release.id) as { id: string; approver_actor_id: string; candidate_content_digest: string } | undefined
      checkedBindings += 1
      if (!approval || !eventFor('release_candidate', release.id, 'release_candidate.approved', (event) => event.payload.approvalId === approval.id && event.payload.candidateContentDigest === approval.candidate_content_digest && event.actorId === approval.approver_actor_id)) add({ severity: 'critical', code: 'release_approval_unbound', message: `Approved Release Candidate ${release.id} has no matching approval row and event`, aggregateType: 'release_candidate', aggregateId: release.id })
    }
    checkedBindings += 1
    try { database.getReleaseCandidate(release.id) } catch (error) { add({ severity: 'critical', code: 'release_candidate_invalid', message: error instanceof Error ? error.message : String(error), aggregateType: 'release_candidate', aggregateId: release.id }) }
  }

  const attestations = database.db.prepare(`
    SELECT a.*, r.id AS revocation_id, r.reason AS revocation_reason, r.revoked_by_actor_id, r.identity_json AS revocation_identity_json, r.revoked_at
    FROM operational_attestations a
    LEFT JOIN operational_attestation_revocations r ON r.operational_attestation_id = a.id
    ORDER BY a.created_at
  `).all() as Array<Record<string, string | null>>
  for (const row of attestations) {
    const attestationId = String(row.id)
    const summaryJson = String(row.summary_json)
    const identityJson = String(row.identity_json)
    requireBinding({
      aggregateType: 'operational_attestation',
      aggregateId: attestationId,
      eventType: 'operational_attestation.recorded',
      code: 'operational_attestation_unbound',
      message: `Operational Attestation ${attestationId} has no matching recorded event`,
      predicate: (event) => event.actorId === row.attested_by_actor_id
        && event.payload.attestationType === row.attestation_type
        && event.payload.subjectType === row.subject_type
        && event.payload.subjectId === row.subject_id
        && event.payload.evidenceUri === row.evidence_uri
        && event.payload.evidenceDigest === row.evidence_digest
        && event.payload.summaryDigest === `sha256:${sha256(summaryJson)}`
        && event.payload.performedAt === row.performed_at
        && event.payload.validUntil === row.valid_until
        && JSON.stringify(event.payload.identity) === identityJson,
    })
    try {
      const evidence = readOperationalEvidence(database.dataDirectory, String(row.evidence_uri), String(row.evidence_digest))
      if (evidence.document.schemaVersion !== 'aperture.recovery-drill.v1') throw new Error(`unsupported schema ${String(evidence.document.schemaVersion)}`)
      if (evidence.document.performedAt !== row.performed_at || evidence.document.validUntil !== row.valid_until) throw new Error('evidence validity does not match the attestation row')
      if (JSON.stringify(evidence.document) !== JSON.stringify(JSON.parse(summaryJson))) throw new Error('evidence document does not match the recorded summary')
    } catch (error) {
      add({ severity: 'critical', code: 'operational_evidence_invalid', message: error instanceof Error ? error.message : String(error), aggregateType: 'operational_attestation', aggregateId: attestationId })
    }
    if (row.revocation_id) {
      const revocationIdentityJson = String(row.revocation_identity_json)
      requireBinding({
        aggregateType: 'operational_attestation',
        aggregateId: attestationId,
        eventType: 'operational_attestation.revoked',
        code: 'operational_attestation_revocation_unbound',
        message: `Operational Attestation ${attestationId} has no matching revocation event`,
        predicate: (event) => event.actorId === row.revoked_by_actor_id
          && event.payload.revocationId === row.revocation_id
          && event.payload.reason === row.revocation_reason
          && event.payload.revokedAt === row.revoked_at
          && JSON.stringify(event.payload.identity) === revocationIdentityJson,
      })
    }
  }

  const holdouts = database.db.prepare("SELECT aggregate_id, payload_json FROM domain_events WHERE aggregate_type = 'project' AND event_type = 'project.evaluation_holdout_registered'").all() as Array<{ aggregate_id: string; payload_json: string }>
  for (const holdout of holdouts) {
    const digest = String((JSON.parse(holdout.payload_json) as Record<string, unknown>).digest ?? '')
    if (database.readEvaluationHoldout(holdout.aggregate_id, digest) === undefined) add({ severity: 'critical', code: 'holdout_invalid', message: `Registered Holdout ${digest} is missing or has the wrong digest`, aggregateType: 'project', aggregateId: holdout.aggregate_id })
  }

  const eventSeal = database.getEventSealStatus()
  if (eventSeal.keySource === 'colocated') add({ severity: 'warning', code: 'event_seal_key_colocated', message: 'Event Seal Key is stored next to the database; use APERTURE_EVENT_SEAL_KEY_FILE outside the data directory for team-governed deployment' })
  if (database.getIdentityMode() === 'development') add({ severity: 'info', code: 'identity_mode_development', message: 'Identity mode is Development; password decisions remain self-asserted' })
  const host = env.CONTROL_PLANE_HOST ?? '127.0.0.1'
  const nonLoopback = !['127.0.0.1', '::1', 'localhost'].includes(host)
  const secureSetting = env.CONTROL_PLANE_SECURE_COOKIES?.trim().toLowerCase()
  const secureCookies = secureSetting ? secureSetting === 'true' : Boolean(env.CONTROL_PLANE_PUBLIC_URL?.startsWith('https://'))
  if (nonLoopback && !secureCookies) add({ severity: 'warning', code: 'network_without_secure_cookie', message: `Control Plane host ${host} is non-loopback without Secure session cookies` })

  const summary = {
    critical: findings.filter((finding) => finding.severity === 'critical').length,
    warning: findings.filter((finding) => finding.severity === 'warning').length,
    info: findings.filter((finding) => finding.severity === 'info').length,
    aggregateCount,
    eventCount,
    checkedBindings,
  }
  return { schemaVersion: 'aperture.core-integrity.v1', generatedAt: new Date().toISOString(), valid: summary.critical === 0, summary, findings, eventSeal }
}

export function coreIntegrityMarkdown(report: CoreIntegrityReport) {
  const lines = [
    '# Core Integrity Audit',
    '',
    `Generated: ${report.generatedAt}`,
    `Result: ${report.valid ? 'PASS' : 'FAIL'}`,
    '',
    '## Summary',
    '',
    `- Critical: ${report.summary.critical}`,
    `- Warning: ${report.summary.warning}`,
    `- Info: ${report.summary.info}`,
    `- Event aggregates: ${report.summary.aggregateCount}`,
    `- Events: ${report.summary.eventCount}`,
    `- State/event bindings checked: ${report.summary.checkedBindings}`,
    '',
    '## Findings',
    '',
    ...(report.findings.length ? report.findings.map((finding) => `- **${finding.severity.toUpperCase()} · ${finding.code}**${finding.aggregateType ? ` · ${finding.aggregateType}/${finding.aggregateId}` : ''}: ${finding.message}`) : ['- No findings.']),
    '',
  ]
  return lines.join('\n')
}
