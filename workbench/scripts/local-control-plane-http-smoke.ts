import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { ControlPlaneDatabase } from '../server/database.ts'
import { createControlPlaneRequestHandler } from '../server/http-server.ts'
import { LocalCommandAgentRunner } from '../server/local-command-agent-runner.ts'
import { LocalEvidenceStore } from '../server/local-evidence-store.ts'

const root = mkdtempSync(join(tmpdir(), 'aperture-http-control-plane-'))
const repositoryPath = join(root, 'repository')
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')
const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), migrationDirectory)
const agentScript = join(root, 'http-agent.mjs')
const agentRunner = new LocalCommandAgentRunner({ database, executable: process.execPath, args: [agentScript], worktreeRoot: join(root, 'agent-runs'), timeoutMs: 10_000 })
const evidenceStore = new LocalEvidenceStore(join(root, 'evidence'))
const handler = createControlPlaneRequestHandler({ database, agentRunner, evidenceStore })

function git(...args: string[]) {
  return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim()
}

async function request<T>(path: string, input: { method?: string; cookie?: string; body?: Record<string, unknown> } = {}) {
  const body = input.body ? JSON.stringify(input.body) : ''
  const headers: IncomingHttpHeaders = { ...(input.cookie ? { cookie: input.cookie } : {}), ...(body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}) }
  const requestStream = Readable.from(body ? [Buffer.from(body)] : []) as IncomingMessage
  Object.assign(requestStream, { method: input.method ?? (input.body ? 'POST' : 'GET'), url: path, headers })
  const chunks: Buffer[] = []
  let status = 200
  let responseHeaders: Record<string, string | number | string[]> = {}
  const responseStream = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } }) as ServerResponse
  responseStream.writeHead = ((statusCode: number, nextHeaders?: Record<string, string | number | string[]>) => {
    status = statusCode
    responseHeaders = nextHeaders ?? {}
    return responseStream
  }) as ServerResponse['writeHead']
  const finished = once(responseStream, 'finish')
  await handler(requestStream, responseStream)
  await finished
  const text = Buffer.concat(chunks).toString('utf8')
  const setCookie = responseHeaders['set-cookie']
  const cookieValue = Array.isArray(setCookie) ? setCookie[0] : typeof setCookie === 'string' ? setCookie : undefined
  return { status, cookie: cookieValue?.split(';')[0], body: text ? JSON.parse(text) as T : undefined }
}

mkdirSync(repositoryPath)
execFileSync('git', ['init', '--initial-branch=main', repositoryPath])
git('config', 'user.name', 'Aperture HTTP Test')
git('config', 'user.email', 'aperture-http@example.test')
writeFileSync(join(repositoryPath, 'README.md'), '# HTTP Authority\n')
mkdirSync(join(repositoryPath, '.aperture'))
mkdirSync(join(repositoryPath, 'evals'))
writeFileSync(join(repositoryPath, 'evals/dataset.jsonl'), '{"id":"http-task-1","input":"generate a file","expected":"generated.ts exists"}\n')
writeFileSync(join(repositoryPath, '.aperture/project.json'), JSON.stringify({ schemaVersion: 'aperture.project.v1', productType: 'agent_system', context: { required: ['README.md'], allowed: ['README.md'] }, checks: [{ name: 'http-fixture', kind: 'evaluation', command: [process.execPath, '-e', 'console.log(JSON.stringify({type:"evaluation_metrics",metrics:{task_success_rate:1}}))'], timeoutMs: 10_000 }], evaluation: { profile: 'agent_dataset', datasetPath: 'evals/dataset.jsonl', thresholds: [{ metric: 'task_success_rate', operator: 'gte', threshold: 0.9 }] }, policy: { maximumRisk: 'high', allowUnisolatedRuntime: true } }, null, 2))
git('add', 'README.md', '.aperture/project.json', 'evals/dataset.jsonl')
git('commit', '-m', 'initial')
git('checkout', '-b', 'agent/http-authority')
writeFileSync(join(repositoryPath, 'feature.ts'), 'export const local = true\n')
git('add', 'feature.ts')
git('commit', '-m', 'agent implementation')
writeFileSync(agentScript, `import { readFileSync, writeFileSync } from 'node:fs'\nconst request = JSON.parse(readFileSync(process.env.APERTURE_RUN_REQUEST, 'utf8'))\nreadFileSync('README.md', 'utf8')\nconsole.log(JSON.stringify({ type: 'context_consumed', path: 'README.md' }))\nwriteFileSync('generated.ts', 'export const runId = ' + JSON.stringify(request.runId) + '\\n')\n`)

try {
  const health = await request<{ status: string; agentRunner: string }>('/api/health')
  assert.equal(health.status, 200)
  assert.equal(health.body?.status, 'ok')
  assert.equal(health.body?.agentRunner, agentRunner.id)

  const setupStatus = await request<{ required: boolean }>('/api/setup/status')
  assert.equal(setupStatus.body?.required, true)

  const setup = await request<{ actor: { id: string } }>('/api/setup', { body: { username: 'owner', displayName: 'Local Owner', password: 'owner-password-2026' } })
  assert.equal(setup.status, 201)
  assert.ok(setup.cookie)
  const ownerCookie = setup.cookie!
  const ownerId = setup.body!.actor.id
  assert.equal((await request('/api/projects/PRJ-DEFAULT/settings', { cookie: ownerCookie, body: { repositoryPath } })).status, 200)

  const authorResponse = await request<{ actor: { id: string } }>('/api/actors', { cookie: ownerCookie, body: { username: 'author', displayName: 'Agent Author', role: 'developer', password: 'author-password-2026' } })
  const reviewerResponse = await request<{ actor: { id: string } }>('/api/actors', { cookie: ownerCookie, body: { username: 'reviewer', displayName: 'Human Reviewer', role: 'reviewer', password: 'reviewer-password-2026' } })
  const maintainerResponse = await request<{ actor: { id: string } }>('/api/actors', { cookie: ownerCookie, body: { username: 'maintainer', displayName: 'Release Maintainer', role: 'maintainer', password: 'maintainer-password-2026' } })
  assert.equal(authorResponse.status, 201)
  assert.equal(reviewerResponse.status, 201)
  assert.equal(maintainerResponse.status, 201)

  const workItemResponse = await request<{ workItem: { id: string; productType: string } }>('/api/work-items', { cookie: ownerCookie, body: { projectId: 'PRJ-DEFAULT', title: '验证 HTTP 本地审查链路', description: '本地身份、Git revision 和 Event Log。', productType: 'agent_system', ownerActorId: authorResponse.body!.actor.id } })
  const workItemId = workItemResponse.body!.workItem.id
  assert.equal(workItemResponse.body?.workItem.productType, 'agent_system')
  const intentResponse = await request<{ intentVersion: { id: string } }>(`/api/work-items/${workItemId}/intent-versions`, { cookie: ownerCookie, body: { goal: '完成本地 Change Proposal 审查', constraints: ['offline'], riskLevel: 'medium', acceptanceCriteria: [{ statement: '审查绑定 Head SHA', criticality: 'critical', verificationType: 'deterministic' }] } })
  const intentVersionId = intentResponse.body!.intentVersion.id

  const authorLogin = await request<{ actor: { id: string } }>('/api/auth/login', { body: { username: 'author', password: 'author-password-2026' } })
  const authorCookie = authorLogin.cookie!
  // Evaluation holdouts: an owner registers one, a developer cannot, and nobody reads the content back.
  assert.equal((await request('/api/projects/PRJ-DEFAULT/evaluation-holdouts', { cookie: authorCookie, body: { content: '{"input":"a","expected":"b"}\n' } })).status, 403)
  const holdoutResponse = await request<{ holdout: { digest: string } }>('/api/projects/PRJ-DEFAULT/evaluation-holdouts', { cookie: ownerCookie, body: { content: '{"input":"a","expected":"b"}\n' } })
  assert.equal(holdoutResponse.status, 201)
  const holdoutList = await request<{ holdouts: Array<{ digest: string }> }>('/api/projects/PRJ-DEFAULT/evaluation-holdouts', { cookie: authorCookie })
  assert.deepEqual(holdoutList.body!.holdouts.map((holdout) => holdout.digest), [holdoutResponse.body!.holdout.digest])
  assert.ok(!JSON.stringify(holdoutList.body).includes('expected'), 'the holdout content is never returned')
  const proposalResponse = await request<{ changeProposal: { id: string; headSha: string } }>('/api/change-proposals', { cookie: authorCookie, body: { workItemId, intentVersionId, runId: 'RUN-HTTP-001', baseRef: 'main', headRef: 'agent/http-authority' } })
  assert.equal(proposalResponse.status, 201)
  const proposal = proposalResponse.body!.changeProposal

  const authorCheckAttempt = await request<{ error: { code: string } }>(`/api/change-proposals/${proposal.id}/checks`, { cookie: authorCookie, body: { headSha: proposal.headSha, name: 'unit', status: 'completed', conclusion: 'success' } })
  assert.equal(authorCheckAttempt.status, 403)
  assert.equal(authorCheckAttempt.body?.error.code, 'forbidden')

  const maintainerLogin = await request('/api/auth/login', { body: { username: 'maintainer', password: 'maintainer-password-2026' } })
  const maintainerCookie = maintainerLogin.cookie!
  const checkResponse = await request<{ check: { id: string; source: string } }>(`/api/change-proposals/${proposal.id}/checks`, { cookie: maintainerCookie, body: { headSha: proposal.headSha, name: 'unit', status: 'completed', conclusion: 'success' } })
  assert.equal(checkResponse.status, 201)
  assert.equal(checkResponse.body?.check.source, 'external')
  const storedPackage = evidenceStore.write({ schemaVersion: 'aperture.evidence.v1', generatedAt: new Date().toISOString(), workItem: { id: workItemId, title: '验证 HTTP 本地审查链路', productType: 'agent_system' }, intent: { id: intentVersionId, version: 1, goal: '完成本地 Change Proposal 审查', riskLevel: 'medium', contentDigest: database.getIntentVersion(intentVersionId).contentDigest, constraints: ['offline'], acceptanceCriteria: database.getIntentVersion(intentVersionId).acceptanceCriteria }, git: { repositoryPath, baseRef: 'main', baseSha: database.getChangeProposal(proposal.id).baseSha, headRef: 'agent/http-authority', headSha: proposal.headSha, changedFiles: 1, additions: 1, deletions: 0 }, run: { id: 'RUN-HTTP-001', adapterId: 'http-fixture', isolation: 'unisolated_process', networkEgress: 'unrestricted', productionEligible: false }, checks: [{ id: checkResponse.body!.check.id, name: 'unit', conclusion: 'success', exitCode: 0, durationMs: 1, stdoutDigest: 'sha256:test-stdout', stderrDigest: 'sha256:test-stderr', stdoutExcerpt: 'passed', stderrExcerpt: '' }], provenance: { runEventChainHead: database.listAggregateEvents('agent_run', 'RUN-HTTP-001').at(-1)?.eventDigest ?? 'genesis', proposalEventChainHead: database.listAggregateEvents('change_proposal', proposal.id).at(-1)!.eventDigest, generatedBy: 'http-smoke' } })
  const authorEvidenceAttempt = await request<{ error: { code: string } }>(`/api/change-proposals/${proposal.id}/evidence`, { cookie: authorCookie, body: { runId: 'RUN-HTTP-001', headSha: proposal.headSha, uri: storedPackage.uri, sha256: storedPackage.sha256, summary: { passed: 1 } } })
  assert.equal(authorEvidenceAttempt.status, 403)
  assert.equal(authorEvidenceAttempt.body?.error.code, 'forbidden')

  const forgedEvidenceAttempt = await request<{ error: { code: string } }>(`/api/change-proposals/${proposal.id}/evidence`, { cookie: maintainerCookie, body: { runId: 'RUN-HTTP-001', headSha: proposal.headSha, uri: storedPackage.uri, sha256: 'sha256:forged-digest', summary: { passed: 1 } } })
  assert.equal(forgedEvidenceAttempt.status, 409)

  // An intact package still has to be about this proposal, and a hand-written coverage claim is discarded.
  const otherRunAttempt = await request<{ error: { code: string } }>(`/api/change-proposals/${proposal.id}/evidence`, { cookie: maintainerCookie, body: { runId: 'RUN-HTTP-OTHER', headSha: proposal.headSha, uri: storedPackage.uri, sha256: storedPackage.sha256, summary: { passed: 1 } } })
  assert.equal(otherRunAttempt.body?.error.code, 'evidence_package_mismatch')
  const evidenceResponse = await request<{ evidence: { id: string; summary: Record<string, unknown> } }>(`/api/change-proposals/${proposal.id}/evidence`, { cookie: maintainerCookie, body: { runId: 'RUN-HTTP-001', headSha: proposal.headSha, uri: storedPackage.uri, sha256: storedPackage.sha256, summary: { passed: 1, criteriaCoverage: [{ criterionId: 'forged', checkNames: ['unit'], independent: true }] } } })
  assert.equal(evidenceResponse.status, 201)
  assert.equal(evidenceResponse.body?.evidence.summary.criteriaCoverage, undefined)
  assert.equal(evidenceResponse.body?.evidence.summary.passed, 1)

  const selfReview = await request<{ error: { code: string } }>(`/api/change-proposals/${proposal.id}/reviews`, { cookie: authorCookie, body: { headSha: proposal.headSha, decision: 'approved', comment: 'self approve' } })
  assert.equal(selfReview.status, 403)
  assert.equal(selfReview.body?.error.code, 'self_review_forbidden')

  const reviewerLogin = await request('/api/auth/login', { body: { username: 'reviewer', password: 'reviewer-password-2026' } })
  const authorAssign = await request<{ error: { code: string } }>(`/api/change-proposals/${proposal.id}/assignments`, { cookie: authorCookie, body: { assigneeActorId: reviewerResponse.body!.actor.id } })
  assert.equal(authorAssign.body?.error.code, 'review_assignment_forbidden')
  const claim = await request<{ assignment: { basis: string; status: string } }>(`/api/change-proposals/${proposal.id}/assignments`, { cookie: reviewerLogin.cookie!, body: { assigneeActorId: reviewerResponse.body!.actor.id, dueHours: 8 } })
  assert.equal(claim.status, 201)
  assert.deepEqual([claim.body?.assignment.basis, claim.body?.assignment.status], ['self_claim', 'pending'])
  const evidenceView = await request<{ evidencePackage: { packageDigest: string }; view: { reviewerActorId: string } }>(`/api/evidence/${evidenceResponse.body!.evidence.id}/view`, { cookie: reviewerLogin.cookie!, body: {} })
  assert.equal(evidenceView.status, 200)
  assert.equal(evidenceView.body?.evidencePackage.packageDigest, storedPackage.sha256)
  assert.equal(evidenceView.body?.view.reviewerActorId, reviewerResponse.body!.actor.id)
  const review = await request(`/api/change-proposals/${proposal.id}/reviews`, { cookie: reviewerLogin.cookie!, body: { headSha: proposal.headSha, decision: 'approved', comment: 'Evidence verified' } })
  assert.equal(review.status, 201)

  const reviewProjection = await request<{ reviews: Array<{ reviewerDisplayName: string; headSha: string; invalidatedAt?: string }>; metrics: { approvedCount: number; currentDecisionCount: number; approvalDecisionCount: number; evidenceExpandedApprovalCount: number; decidedProposalCount: number; firstPassApprovalCount: number; reworkedProposalCount: number; acceptedChangeCount: number }; readiness: Array<{ changeProposalId: string; status: string; successfulCheckCount: number; evidence: unknown[] }> }>('/api/reviews', { cookie: reviewerLogin.cookie! })
  assert.equal(reviewProjection.status, 200)
  const projectedAssignments = (reviewProjection.body as unknown as { assignments: Array<{ status: string; evidenceOpenedAt?: string }> }).assignments
  assert.equal(projectedAssignments[0].status, 'approved')
  assert.ok(projectedAssignments[0].evidenceOpenedAt, 'the evidence view opened the assignment')
  assert.equal(reviewProjection.body?.reviews[0].reviewerDisplayName, 'Human Reviewer')
  assert.equal(reviewProjection.body?.reviews[0].headSha, proposal.headSha)
  assert.equal(reviewProjection.body?.reviews[0].invalidatedAt, undefined)
  assert.equal(reviewProjection.body?.metrics.approvedCount, 1)
  assert.equal(reviewProjection.body?.metrics.currentDecisionCount, 1)
  assert.equal(reviewProjection.body?.readiness[0].changeProposalId, proposal.id)
  assert.equal(reviewProjection.body?.readiness[0].status, 'ready')
  assert.equal(reviewProjection.body?.readiness[0].successfulCheckCount, 1)
  assert.equal(reviewProjection.body?.readiness[0].evidence.length, 1)
  // The falsification counters the Metrics page renders. This reviewer opened the evidence package bound to
  // this head before deciding, so the approval must count as evidence-expanded.
  assert.equal(reviewProjection.body?.metrics.approvalDecisionCount, 1)
  assert.equal(reviewProjection.body?.metrics.evidenceExpandedApprovalCount, 1)
  assert.equal(reviewProjection.body?.metrics.decidedProposalCount, 1)
  assert.equal(reviewProjection.body?.metrics.firstPassApprovalCount, 1)
  assert.equal(reviewProjection.body?.metrics.reworkedProposalCount, 0)
  assert.equal(reviewProjection.body?.metrics.acceptedChangeCount, 1)

  const proposalDetail = await request<{ changeProposal: { status: string }; events: unknown[] }>(`/api/change-proposals/${proposal.id}`, { cookie: reviewerLogin.cookie! })
  assert.equal(proposalDetail.body?.changeProposal.status, 'approved')
  assert.ok((proposalDetail.body?.events.length ?? 0) >= 4)

  const forbiddenMerge = await request<{ error: { code: string } }>(`/api/change-proposals/${proposal.id}/merge`, { cookie: authorCookie, body: {} })
  assert.equal(forbiddenMerge.status, 403)
  assert.equal(forbiddenMerge.body?.error.code, 'forbidden')
  git('checkout', 'main')
  const merge = await request<{ proposal: { status: string }; evidence: { approvedHeadSha: string; mergedSha: string; evidenceDigest: string }; changed: boolean }>(`/api/change-proposals/${proposal.id}/merge`, { cookie: ownerCookie, body: {} })
  assert.equal(merge.status, 201, JSON.stringify(merge.body))
  assert.equal(merge.body?.changed, true)
  assert.equal(merge.body?.proposal.status, 'merged')
  assert.equal(merge.body?.evidence.approvedHeadSha, proposal.headSha)
  assert.equal(merge.body?.evidence.mergedSha, proposal.headSha)
  assert.match(merge.body?.evidence.evidenceDigest ?? '', /^sha256:[0-9a-f]{64}$/u)
  assert.equal(git('rev-parse', 'main'), proposal.headSha)
  assert.equal(git('status', '--porcelain'), '')
  const mergedDetail = await request<{ changeProposal: { status: string }; mergeEvidence: { evidenceDigest: string }; events: Array<{ eventType: string }> }>(`/api/change-proposals/${proposal.id}`, { cookie: ownerCookie })
  assert.equal(mergedDetail.body?.changeProposal.status, 'merged')
  assert.equal(mergedDetail.body?.mergeEvidence.evidenceDigest, merge.body?.evidence.evidenceDigest)
  assert.equal(mergedDetail.body?.events.some((event) => event.eventType === 'change_proposal.merged'), true)
  const repeatedMerge = await request<{ changed: boolean }>(`/api/change-proposals/${proposal.id}/merge`, { cookie: ownerCookie, body: {} })
  assert.equal(repeatedMerge.status, 200)
  assert.equal(repeatedMerge.body?.changed, false)

  const releaseCandidate = await request<{ releaseCandidate: { id: string; status: string; commitSha: string; sourceTreeDigest: string; sourceFileCount: number; contentDigest: string } }>(`/api/change-proposals/${proposal.id}/release-candidates`, { cookie: ownerCookie, body: {} })
  assert.equal(releaseCandidate.status, 201)
  assert.equal(releaseCandidate.body?.releaseCandidate.status, 'review_ready')
  assert.equal(releaseCandidate.body?.releaseCandidate.commitSha, proposal.headSha)
  assert.match(releaseCandidate.body?.releaseCandidate.sourceTreeDigest ?? '', /^sha256:[0-9a-f]{64}$/u)
  assert.match(releaseCandidate.body?.releaseCandidate.contentDigest ?? '', /^sha256:[0-9a-f]{64}$/u)
  assert.ok((releaseCandidate.body?.releaseCandidate.sourceFileCount ?? 0) >= 3)
  const selfReleaseApproval = await request<{ error: { code: string } }>(`/api/release-candidates/${releaseCandidate.body!.releaseCandidate.id}/approve`, { cookie: ownerCookie, body: { comment: 'self approve' } })
  assert.equal(selfReleaseApproval.status, 403)
  assert.equal(selfReleaseApproval.body?.error.code, 'release_self_approval_forbidden')
  const approvedRelease = await request<{ releaseCandidate: { status: string; approval: { approverActorId: string; candidateContentDigest: string } } }>(`/api/release-candidates/${releaseCandidate.body!.releaseCandidate.id}/approve`, { cookie: maintainerCookie, body: { comment: 'Source snapshot and Merge Evidence verified.' } })
  assert.equal(approvedRelease.status, 201)
  assert.equal(approvedRelease.body?.releaseCandidate.status, 'approved')
  assert.equal(approvedRelease.body?.releaseCandidate.approval.approverActorId, maintainerResponse.body?.actor.id)
  assert.equal(approvedRelease.body?.releaseCandidate.approval.candidateContentDigest, releaseCandidate.body?.releaseCandidate.contentDigest)
  const releaseList = await request<{ releaseCandidates: Array<{ id: string; status: string }> }>('/api/release-candidates', { cookie: ownerCookie })
  assert.equal(releaseList.body?.releaseCandidates.some((candidate) => candidate.id === releaseCandidate.body?.releaseCandidate.id && candidate.status === 'approved'), true)
  assert.equal(database.listAggregateEvents('release_candidate', releaseCandidate.body!.releaseCandidate.id).some((event) => event.eventType === 'release_candidate.approved'), true)
  assert.throws(() => database.db.prepare("UPDATE release_approvals SET comment = 'tampered' WHERE release_candidate_id = ?").run(releaseCandidate.body!.releaseCandidate.id), /append-only/u)

  // DOMAIN_MODEL.md §6.1: the medium risk Intent has to be approved, by someone other than its author, before a Run starts.
  const unapprovedRun = await request<{ error: { code: string } }>('/api/agent-runs', { cookie: authorCookie, body: { workItemId, intentVersionId, baseRef: 'main', declaredContextPaths: ['README.md'] } })
  assert.deepEqual([unapprovedRun.status, unapprovedRun.body?.error.code], [409, 'intent_not_approved'])
  const selfApproval = await request<{ error: { code: string } }>(`/api/intent-versions/${encodeURIComponent(intentVersionId)}/approve`, { cookie: ownerCookie, body: {} })
  assert.deepEqual([selfApproval.status, selfApproval.body?.error.code], [403, 'self_intent_approval_forbidden'])
  const intentApproval = await request<{ intentVersion: { status: string; approval: { basis: string; actorId: string } } }>(`/api/intent-versions/${encodeURIComponent(intentVersionId)}/approve`, { cookie: reviewerLogin.cookie!, body: { comment: 'criteria are testable' } })
  assert.equal(intentApproval.status, 200)
  assert.deepEqual([intentApproval.body?.intentVersion.status, intentApproval.body?.intentVersion.approval.basis, intentApproval.body?.intentVersion.approval.actorId], ['approved', 'named_approval', reviewerResponse.body!.actor.id])

  const agentRunResponse = await request<{ agentRun: { id: string; status: string; changeProposalId: string } }>('/api/agent-runs', { cookie: authorCookie, body: { workItemId, intentVersionId, baseRef: 'main', declaredContextPaths: ['README.md'] } })
  assert.equal(agentRunResponse.status, 201)
  assert.equal(agentRunResponse.body?.agentRun.status, 'succeeded')
  assert.ok(agentRunResponse.body?.agentRun.changeProposalId)
  const agentRunDetail = await request<{ agentRun: { status: string }; events: Array<{ eventType: string; payload: Record<string, unknown> }>; declaredContextPaths: string[] }>(`/api/agent-runs/${agentRunResponse.body!.agentRun.id}`, { cookie: authorCookie })
  assert.equal(agentRunDetail.body?.agentRun.status, 'succeeded')
  assert.equal(agentRunDetail.body?.events.some((event) => event.eventType === 'agent_run.project_manifest_bound'), true)
  assert.equal(agentRunDetail.body?.events.some((event) => event.eventType === 'agent_run.context_consumed'), true)
  // Both sides of the Context reconciliation the run detail view renders: what was declared at admission and
  // what the run reported reading, including whether that report was independently observed.
  assert.deepEqual(agentRunDetail.body?.declaredContextPaths, ['README.md'])
  const consumedContext = agentRunDetail.body!.events.filter((event) => event.eventType === 'agent_run.context_consumed')
  assert.equal(consumedContext.every((event) => event.payload.independentlyObserved === false && event.payload.reportSource === 'agent_protocol'), true)
  assert.equal(consumedContext.some((event) => event.payload.path === 'README.md' && event.payload.declared === true), true)
  const generatedProposal = (await request<{ changeProposal: { id: string; headSha: string } }>(`/api/change-proposals/${agentRunResponse.body!.agentRun.changeProposalId}`, { cookie: authorCookie })).body!.changeProposal
  const revisionRequested = await request(`/api/change-proposals/${generatedProposal.id}/reviews`, { cookie: reviewerLogin.cookie!, body: { headSha: generatedProposal.headSha, decision: 'changes_requested', comment: 'Run the Builder again and update generated.ts.' } })
  assert.equal(revisionRequested.status, 201)
  const revisedRun = await request<{ agentRun: { id: string; status: string; changeProposalId: string; revisionOfProposalId: string; startSha: string } }>(`/api/change-proposals/${generatedProposal.id}/revise`, { cookie: authorCookie, body: {} })
  assert.equal(revisedRun.status, 201)
  assert.equal(revisedRun.body?.agentRun.status, 'succeeded')
  assert.equal(revisedRun.body?.agentRun.changeProposalId, generatedProposal.id)
  assert.equal(revisedRun.body?.agentRun.revisionOfProposalId, generatedProposal.id)
  assert.equal(revisedRun.body?.agentRun.startSha, generatedProposal.headSha)
  const revisedDetail = await request<{ changeProposal: { status: string; headSha: string; runId: string }; events: Array<{ eventType: string }> }>(`/api/change-proposals/${generatedProposal.id}`, { cookie: authorCookie })
  assert.equal(revisedDetail.body?.changeProposal.status, 'review_ready')
  assert.equal(revisedDetail.body?.changeProposal.runId, revisedRun.body?.agentRun.id)
  assert.notEqual(revisedDetail.body?.changeProposal.headSha, generatedProposal.headSha)
  assert.equal(revisedDetail.body?.events.some((event) => event.eventType === 'change_proposal.revision_changed'), true)

  const session = await request<{ actor: { id: string } }>('/api/session', { cookie: ownerCookie })
  assert.equal(session.body?.actor.id, ownerId)
  assert.equal((await request('/api/events?limit=50', { cookie: ownerCookie })).status, 200)

  console.log(`local control plane HTTP smoke passed · ${proposal.id} · direct handler`)
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
