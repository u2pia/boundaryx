import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type DomainEvent = { aggregateType: string; aggregateId: string; aggregateVersion: number; eventType: string; actorId?: string; payload: Record<string, unknown>; previousEventDigest: string; eventDigest: string; recordedAt: string }
type ChangeProposal = { id: string; projectId: string; workItemId: string; intentVersionId: string; runId?: string; headRef: string; headSha: string; authorActorId: string; status: string }
type MergeEvidence = { id: string; approvedHeadSha: string; mergedSha: string; evidenceDigest: string }
type ReleaseCandidate = { id: string; changeProposalId: string; mergeEvidenceId: string; commitSha: string; sourceTreeDigest: string; contentDigest: string; artifactClass: string; artifactBindingDigest?: string; artifactEvidence: Array<{ packageDigest: string; artifactDigests: string[]; sourceCommitSha: string }>; status: string; createdByActorId: string; approval?: { approverActorId: string; candidateContentDigest: string } }
type DecisionBrief = { context: { observation: string; controlPlaneInjected: number; builderReported: number; rejected: number; undeclared: number; skillsLoaded: number; skillsRejected: number }; execution: { source: string; runId?: string } }
type EventIntegrity = { aggregateType: string; aggregateId: string; valid: boolean; eventCount: number; chainHead: string; faults: string[] }

const baseUrl = process.env.PILOT_CONTROL_PLANE_URL ?? 'http://127.0.0.1:8787'
const proposalId = process.env.PILOT_CHANGE_PROPOSAL_ID
const sessionCookie = process.env.PILOT_SESSION_COOKIE
const username = process.env.PILOT_USERNAME
const password = process.env.PILOT_PASSWORD
const humanAttestation = process.env.PILOT_HUMAN_ATTESTATION === 'true'
const attestedBy = process.env.PILOT_ATTESTED_BY?.trim()
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outputDirectory = resolve(process.env.PILOT_CASE_REPORT_DIR ?? join(repositoryRoot, 'output/pilot-cases'))

if (!proposalId) throw new Error('PILOT_CHANGE_PROPOSAL_ID is required')
if (!sessionCookie && (!username || !password)) throw new Error('Provide PILOT_SESSION_COOKIE or PILOT_USERNAME and PILOT_PASSWORD')

async function request<T>(path: string, cookie?: string, body?: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}${path}`, { method: body ? 'POST' : 'GET', headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await response.text()
  const payload = text ? JSON.parse(text) as T & { error?: { code: string; message: string } } : undefined
  if (!response.ok) throw new Error(`${response.status} ${payload?.error?.code ?? 'request_failed'}: ${payload?.error?.message ?? text}`)
  return { body: payload as T, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}

const cookie = sessionCookie ?? (await request<{ actor: { id: string } }>('/api/auth/login', undefined, { username, password })).cookie!
const proposalResponse = (await request<{ changeProposal: ChangeProposal; mergeEvidence?: MergeEvidence; events: DomainEvent[] }>(`/api/change-proposals/${encodeURIComponent(proposalId)}`, cookie)).body
const proposal = proposalResponse.changeProposal
const brief = (await request<{ decisionBrief: DecisionBrief }>(`/api/change-proposals/${encodeURIComponent(proposal.id)}/decision-brief`, cookie)).body.decisionBrief
const candidates = (await request<{ releaseCandidates: ReleaseCandidate[] }>('/api/release-candidates', cookie)).body.releaseCandidates
const candidate = candidates.find((item) => item.changeProposalId === proposal.id)
const allEvents = (await request<{ events: DomainEvent[] }>('/api/events?limit=1000', cookie)).body.events
const proposalIntegrity = (await request<{ integrity: EventIntegrity }>(`/api/event-integrity/change_proposal/${encodeURIComponent(proposal.id)}`, cookie)).body.integrity
const releaseIntegrity = candidate ? (await request<{ integrity: EventIntegrity }>(`/api/event-integrity/release_candidate/${encodeURIComponent(candidate.id)}`, cookie)).body.integrity : undefined

function orderedChain(events: DomainEvent[], aggregateType: string, aggregateId: string) {
  return events.filter((event) => event.aggregateType === aggregateType && event.aggregateId === aggregateId).sort((left, right) => left.aggregateVersion - right.aggregateVersion)
}

function chainIssues(chain: DomainEvent[], label: string) {
  if (!chain.length) return [`${label} event chain is missing`]
  const issues = chain[0].previousEventDigest === 'genesis' ? [] : [`${label} event chain does not start at genesis`]
  chain.forEach((event, index) => {
    if (!/^sha256:[0-9a-f]{64}$/u.test(event.eventDigest)) issues.push(`${label} event ${event.eventType} has an invalid digest`)
    if (index && event.previousEventDigest !== chain[index - 1].eventDigest) issues.push(`${label} event chain is discontinuous at ${event.eventType}`)
  })
  return issues
}

const proposalEvents = orderedChain(proposalResponse.events, 'change_proposal', proposal.id)
const releaseEvents = candidate ? orderedChain(allEvents, 'release_candidate', candidate.id) : []
const eventForHead = (eventType: string) => proposalEvents.findLast((event) => event.eventType === eventType && event.payload.headSha === proposal.headSha)
const assignmentEvent = eventForHead('review.assigned')
const briefEvent = eventForHead('review.decision_brief_opened')
const evidenceEvent = eventForHead('evidence.viewed')
const approvalEvent = eventForHead('review.approved')
const releaseCreatedEvent = releaseEvents.find((event) => event.eventType === 'release_candidate.created')
const releaseApprovedEvent = releaseEvents.find((event) => event.eventType === 'release_candidate.approved')
const elapsedSeconds = (start?: string, end?: string) => start && end ? Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / 1000)) : undefined
const reasons = [
  ...(humanAttestation && attestedBy ? [] : ['human execution attestation is missing; set PILOT_HUMAN_ATTESTATION=true and PILOT_ATTESTED_BY']),
  ...(proposal.status === 'merged' ? [] : [`proposal status is ${proposal.status}, not merged`]),
  ...(proposalResponse.mergeEvidence ? [] : ['Merge Evidence is missing']),
  ...(candidate?.status === 'approved' ? [] : ['approved Release Candidate is missing']),
  ...(brief.execution.source === 'local_agent_run' && brief.execution.runId ? [] : [`execution source ${brief.execution.source} has no local Agent Run context evidence`]),
  ...(approvalEvent?.actorId && approvalEvent.actorId !== proposal.authorActorId ? [] : ['terminal reviewer is missing or is the proposal author']),
  ...(briefEvent?.actorId === approvalEvent?.actorId ? [] : ['the terminal reviewer did not open the Decision Brief for this Head']),
  ...(evidenceEvent?.actorId === approvalEvent?.actorId ? [] : ['the terminal reviewer did not open Evidence for this Head']),
  ...(briefEvent && approvalEvent && briefEvent.recordedAt <= approvalEvent.recordedAt ? [] : ['Decision Brief was not opened before the terminal decision']),
  ...(evidenceEvent && approvalEvent && evidenceEvent.recordedAt <= approvalEvent.recordedAt ? [] : ['Evidence was not opened before the terminal decision']),
  ...(candidate?.approval && candidate.approval.approverActorId !== candidate.createdByActorId ? [] : ['Release approval is missing or self-approved']),
  ...(proposalResponse.mergeEvidence && proposalResponse.mergeEvidence.approvedHeadSha === proposal.headSha ? [] : ['Merge Evidence is not bound to the approved Head']),
  ...(proposalResponse.mergeEvidence && candidate?.commitSha === proposalResponse.mergeEvidence.mergedSha ? [] : ['Release Candidate commit is not bound to Merge Evidence']),
  ...(candidate?.approval?.candidateContentDigest === candidate?.contentDigest ? [] : ['Release approval is not bound to the candidate content digest']),
  ...(proposalIntegrity.valid ? [] : [`Change Proposal event seals do not verify: ${proposalIntegrity.faults.join('; ')}`]),
  ...(releaseIntegrity?.valid ? [] : [`Release Candidate event seals do not verify: ${releaseIntegrity?.faults.join('; ') ?? 'candidate missing'}`]),
  ...chainIssues(proposalEvents, 'Change Proposal'),
  ...chainIssues(releaseEvents, 'Release Candidate'),
]
const caseId = `pilot-${proposal.id.toLowerCase()}-${proposal.headSha.slice(0, 8)}`
const report = {
  caseId,
  result: candidate?.status === 'approved' ? 'release_approved' : 'incomplete',
  pilotEligible: reasons.length === 0,
  pilotExclusionReasons: reasons,
  humanAttestation: humanAttestation && attestedBy ? { attestedBy, attestedAt: new Date().toISOString(), statement: 'Reviewer and Release Approver actions were performed by humans, not by the validation script or an automated client.' } : undefined,
  capturedAt: new Date().toISOString(),
  projectId: proposal.projectId,
  workItemId: proposal.workItemId,
  intentVersionId: proposal.intentVersionId,
  runId: proposal.runId,
  changeProposalId: proposal.id,
  headRef: proposal.headRef,
  headSha: proposal.headSha,
  mergeEvidence: proposalResponse.mergeEvidence ? { id: proposalResponse.mergeEvidence.id, digest: proposalResponse.mergeEvidence.evidenceDigest, mergedSha: proposalResponse.mergeEvidence.mergedSha } : undefined,
  releaseCandidate: candidate ? { id: candidate.id, status: candidate.status, contentDigest: candidate.contentDigest, sourceTreeDigest: candidate.sourceTreeDigest, artifactClass: candidate.artifactClass, artifactBindingDigest: candidate.artifactBindingDigest, artifactDigests: candidate.artifactEvidence.flatMap((evidence) => evidence.artifactDigests) } : undefined,
  eventChainHeads: { changeProposal: proposalEvents.at(-1)?.eventDigest, releaseCandidate: releaseEvents.at(-1)?.eventDigest },
  eventIntegrity: { changeProposal: proposalIntegrity, releaseCandidate: releaseIntegrity },
  pilotMetrics: {
    review: {
      assignmentToDecisionSeconds: elapsedSeconds(assignmentEvent?.recordedAt, approvalEvent?.recordedAt),
      briefToDecisionSeconds: elapsedSeconds(briefEvent?.recordedAt, approvalEvent?.recordedAt),
      evidenceToDecisionSeconds: elapsedSeconds(evidenceEvent?.recordedAt, approvalEvent?.recordedAt),
      evidenceExpandedBeforeDecision: Boolean(evidenceEvent && approvalEvent && evidenceEvent.recordedAt <= approvalEvent.recordedAt),
      reworkRounds: proposalEvents.filter((event) => event.eventType === 'review.changes_requested').length,
    },
    context: brief.context,
  },
}

mkdirSync(outputDirectory, { recursive: true })
writeFileSync(join(outputDirectory, `${caseId}.json`), `${JSON.stringify(report, null, 2)}\n`)
writeFileSync(join(outputDirectory, `${caseId}.md`), `# Pilot Change · ${caseId}\n\n- Pilot eligible: \`${report.pilotEligible}\`\n- Result: \`${report.result}\`\n- Change Proposal: \`${report.changeProposalId}\` @ \`${report.headSha}\`\n- Release Candidate: \`${report.releaseCandidate?.id ?? 'missing'}\`\n- Brief → Decision: \`${report.pilotMetrics.review.briefToDecisionSeconds ?? 'n/a'}s\`\n- Evidence → Decision: \`${report.pilotMetrics.review.evidenceToDecisionSeconds ?? 'n/a'}s\`\n- Rework rounds: \`${report.pilotMetrics.review.reworkRounds}\`\n- Exclusion reasons: ${report.pilotExclusionReasons.length ? report.pilotExclusionReasons.map((reason) => `\`${reason}\``).join(', ') : 'none'}\n`)
console.log(JSON.stringify(report, null, 2))
