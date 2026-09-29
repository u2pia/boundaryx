import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const baseUrl = process.env.REAL_CASE_CONTROL_PLANE_URL ?? 'http://127.0.0.1:8787'
const ownerPassword = process.env.REAL_CASE_OWNER_PASSWORD
const reviewerPassword = process.env.REAL_CASE_REVIEWER_PASSWORD
const releaseApproverPassword = process.env.REAL_CASE_RELEASE_APPROVER_PASSWORD
const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '../..')
const caseId = `import-validator-${new Date().toISOString().replace(/\D/gu, '').slice(0, 14)}-${process.pid}`

if (!ownerPassword || !reviewerPassword || !releaseApproverPassword) throw new Error('REAL_CASE_OWNER_PASSWORD, REAL_CASE_REVIEWER_PASSWORD and REAL_CASE_RELEASE_APPROVER_PASSWORD are required')

function prepareRepository() {
  if (process.env.REAL_CASE_REPOSITORY) return realpathSync(resolve(process.env.REAL_CASE_REPOSITORY))
  const repositoryPath = join(repositoryRoot, 'examples/real-case-import-validator', caseId)
  mkdirSync(dirname(repositoryPath), { recursive: true })
  cpSync(join(scriptDirectory, 'fixtures/real-case-import-validator'), repositoryPath, { recursive: true })
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repositoryPath])
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.name', 'Aperture Real Case'])
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.email', 'real-case@aperture.invalid'])
  execFileSync('git', ['-C', repositoryPath, 'add', '-A'])
  execFileSync('git', ['-C', repositoryPath, 'commit', '--quiet', '-m', 'Create import validator fixture'])
  return realpathSync(repositoryPath)
}

const repositoryPath = prepareRepository()

async function request<T>(path: string, input: { method?: string; cookie?: string; body?: Record<string, unknown> } = {}) {
  const response = await fetch(`${baseUrl}${path}`, { method: input.method ?? (input.body ? 'POST' : 'GET'), headers: { ...(input.cookie ? { cookie: input.cookie } : {}), ...(input.body ? { 'content-type': 'application/json' } : {}) }, body: input.body ? JSON.stringify(input.body) : undefined })
  const text = await response.text()
  const payload = text ? JSON.parse(text) as T & { error?: { code: string; message: string } } : undefined
  if (!response.ok) throw new Error(`${response.status} ${payload?.error?.code ?? 'request_failed'}: ${payload?.error?.message ?? text}`)
  return { body: payload as T, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}

type ActorView = { id: string; username: string }
type ProjectView = { id: string; slug: string; repositoryPath?: string; defaultBranch: string; status: string }
type AgentRunView = { id: string; status: string; changeProposalId: string; errorMessage?: string }
type EvidenceCheck = { name: string; kind: string; conclusion: string; provenance?: string }
type TestProvenance = { independent: boolean; agentModifiedTestFiles: string[]; note: string }
type DomainEvent = { aggregateType: string; aggregateId: string; aggregateVersion: number; eventType: string; previousEventDigest: string; eventDigest: string; recordedAt: string }
type ReleaseCandidateView = {
  id: string
  status: string
  commitSha: string
  sourceTreeDigest: string
  artifactClass: string
  artifactBindingDigest?: string
  artifactEvidence: Array<{ evidenceId: string; packageDigest: string; artifactCount: number; artifactDigests: string[]; sourceCommitSha: string; buildCheckName: string }>
  contentDigest: string
  approval?: { approverActorId: string; candidateContentDigest: string }
}

const setupStatus = await request<{ required: boolean }>('/api/setup/status')
let ownerCookie: string
let owner: ActorView
if (setupStatus.body.required) {
  const setup = await request<{ actor: ActorView }>('/api/setup', { body: { username: 'real-owner', displayName: 'Real Case Owner', password: ownerPassword } })
  ownerCookie = setup.cookie!
  owner = setup.body.actor
} else {
  const login = await request<{ actor: ActorView }>('/api/auth/login', { body: { username: 'real-owner', password: ownerPassword } })
  ownerCookie = login.cookie!
  owner = login.body.actor
}

const actors = await request<{ actors: ActorView[] }>('/api/actors', { cookie: ownerCookie })
let reviewer = actors.body.actors.find((actor) => actor.username === 'real-reviewer')
if (!reviewer) reviewer = (await request<{ actor: ActorView }>('/api/actors', { cookie: ownerCookie, body: { username: 'real-reviewer', displayName: 'Real Case Reviewer', role: 'reviewer', password: reviewerPassword } })).body.actor
let releaseApprover = actors.body.actors.find((actor) => actor.username === 'real-release-approver')
if (!releaseApprover) releaseApprover = (await request<{ actor: ActorView }>('/api/actors', { cookie: ownerCookie, body: { username: 'real-release-approver', displayName: 'Real Case Release Approver', role: 'maintainer', password: releaseApproverPassword } })).body.actor

const projects = (await request<{ projects: ProjectView[] }>('/api/projects', { cookie: ownerCookie })).body.projects
const project = projects.find((item) => item.status === 'active' && item.repositoryPath === repositoryPath)
  ?? (await request<{ project: ProjectView }>('/api/projects', { cookie: ownerCookie, body: { slug: `real-${Date.now().toString(36)}-${process.pid}`, name: '真实案例 · 导入校验', codeHost: 'local', repositoryPath, defaultBranch: 'main' } })).body.project
await request(`/api/projects/${project.id}/members`, { cookie: ownerCookie, body: { actorId: reviewer.id, role: 'reviewer' } })
await request(`/api/projects/${project.id}/members`, { cookie: ownerCookie, body: { actorId: releaseApprover.id, role: 'maintainer' } })

const reviewerLogin = await request<{ actor: ActorView }>('/api/auth/login', { body: { username: reviewer.username, password: reviewerPassword } })
const reviewerCookie = reviewerLogin.cookie!
const releaseApproverLogin = await request<{ actor: ActorView }>('/api/auth/login', { body: { username: releaseApprover.username, password: releaseApproverPassword } })
const releaseApproverCookie = releaseApproverLogin.cookie!

const workItem = (await request<{ workItem: { id: string } }>('/api/work-items', { cookie: ownerCookie, body: { projectId: project.id, title: '为导入功能增加格式与大小校验', description: '完整真实案例：由 Builder 修改 TypeScript 应用，经独立评审、合并和发布批准。', productType: 'application' } })).body.workItem
const intent = (await request<{ intentVersion: { id: string } }>(`/api/work-items/${workItem.id}/intent-versions`, { cookie: ownerCookie, body: {
  goal: '实现确定性的导入文件校验：仅允许 CSV/JSON，最大 5 MiB，并保持错误顺序稳定。',
  constraints: ['不得删除、跳过或弱化既有测试', '不得使用网络或增加外部依赖', '只修改当前 Git Worktree', '保持返回结构兼容'],
  riskLevel: 'medium',
  acceptanceCriteria: [
    { statement: 'CSV 与 JSON 文件在 5 MiB 以内通过校验', criticality: 'critical', verificationType: 'deterministic', verifiedBy: ['node-tests'] },
    { statement: '不支持的扩展名返回 unsupported_file_type', criticality: 'critical', verificationType: 'deterministic', verifiedBy: ['node-tests'] },
    { statement: '超过 5 MiB 返回 file_too_large', criticality: 'critical', verificationType: 'deterministic', verifiedBy: ['node-tests'] },
    { statement: '空文件名且大小为 -1 时，按 file_name_required、invalid_file_size、unsupported_file_type 的固定顺序返回全部错误', criticality: 'critical', verificationType: 'deterministic', verifiedBy: ['node-tests'] },
    { statement: '生成绑定当前源码 Revision 的应用构建产物', criticality: 'critical', verificationType: 'deterministic', verifiedBy: ['application-build'] },
  ],
} })).body.intentVersion

const intentApproval = await request<{ intentVersion: { status: string } }>(`/api/intent-versions/${encodeURIComponent(intent.id)}/approve`, { cookie: reviewerCookie, body: { comment: '验收标准可断言且绑定项目 Manifest 中的检查，批准启动 Run。' } })
assert.equal(intentApproval.body.intentVersion.status, 'approved')
const queued = (await request<{ agentRun: AgentRunView }>('/api/agent-runs', { cookie: ownerCookie, body: { workItemId: workItem.id, intentVersionId: intent.id, declaredContextPaths: ['README.md', 'package.json', 'src/import-validator.ts', 'test/import-validator.test.ts', 'scripts/build.mjs'] } })).body.agentRun

const runTimeoutMs = Number(process.env.REAL_CASE_RUN_TIMEOUT_MS ?? 15 * 60 * 1000)
const deadline = Date.now() + runTimeoutMs
let worstHealthLatencyMs = 0
let agentRun: AgentRunView = queued
while (['queued', 'running'].includes(agentRun.status)) {
  if (Date.now() > deadline) throw new Error(`Agent run ${queued.id} did not finish within ${runTimeoutMs}ms`)
  const healthStarted = Date.now()
  await request('/api/health')
  worstHealthLatencyMs = Math.max(worstHealthLatencyMs, Date.now() - healthStarted)
  await new Promise((wait) => setTimeout(wait, 2_000))
  agentRun = (await request<{ agentRun: AgentRunView }>(`/api/agent-runs/${queued.id}`, { cookie: ownerCookie })).body.agentRun
}
assert.equal(agentRun.status, 'succeeded', `agent run ${agentRun.id} ended as ${agentRun.status}: ${agentRun.errorMessage ?? 'no reason recorded'}`)
assert.ok(agentRun.changeProposalId)

const assignment = (await request<{ assignment: { assigneeActorId: string; status: string } }>(`/api/change-proposals/${agentRun.changeProposalId}/assignments`, { cookie: ownerCookie, body: { assigneeActorId: reviewer.id, dueHours: 24 } })).body.assignment
assert.equal(assignment.assigneeActorId, reviewer.id)

type DecisionBriefView = { review: { briefOpenedAt?: string }; viewer: { canRecordTerminalDecision: boolean }; gate: { state: string } }
const unreadBrief = (await request<{ decisionBrief: DecisionBriefView }>(`/api/change-proposals/${agentRun.changeProposalId}/decision-brief`, { cookie: reviewerCookie })).body.decisionBrief
assert.equal(unreadBrief.review.briefOpenedAt, undefined, 'GET must not record a Decision Brief view')
assert.equal(unreadBrief.viewer.canRecordTerminalDecision, true)
assert.equal(unreadBrief.gate.state, 'ready')
const openedBrief = await request<{ view: { reviewerActorId: string; viewedAt: string }; decisionBrief: DecisionBriefView }>(`/api/change-proposals/${agentRun.changeProposalId}/decision-brief`, { cookie: reviewerCookie, body: {} })
const reopenedBrief = await request<{ view: { reviewerActorId: string; viewedAt: string }; decisionBrief: DecisionBriefView }>(`/api/change-proposals/${agentRun.changeProposalId}/decision-brief`, { cookie: reviewerCookie, body: {} })
assert.equal(openedBrief.body.view.reviewerActorId, reviewer.id)
assert.equal(openedBrief.body.view.viewedAt, reopenedBrief.body.view.viewedAt, 'Decision Brief view recording must be idempotent for a revision')
assert.equal(openedBrief.body.decisionBrief.review.briefOpenedAt, openedBrief.body.view.viewedAt)

const reviewProjection = await request<{ readiness: Array<{ changeProposalId: string; status: string; evidence: Array<{ id: string }> }> }>('/api/reviews', { cookie: ownerCookie })
const readiness = reviewProjection.body.readiness.find((item) => item.changeProposalId === agentRun.changeProposalId)
assert.equal(readiness?.status, 'ready')
assert.ok(readiness?.evidence[0]?.id)

const viewed = await request<{ evidencePackage: { packageDigest: string; checks: EvidenceCheck[]; testProvenance: TestProvenance; artifacts?: Array<{ path: string; sha256: string; sourceCommitSha: string }> }; view: { reviewerActorId: string } }>(`/api/evidence/${readiness!.evidence[0].id}/view`, { cookie: reviewerCookie, body: {} })
assert.equal(viewed.body.view.reviewerActorId, reviewer.id)
assert.equal(viewed.body.evidencePackage.checks.every((check) => check.conclusion === 'success'), true)
assert.ok(viewed.body.evidencePackage.artifacts?.length, 'the Application case must produce a build artifact')

const testProvenance = viewed.body.evidencePackage.testProvenance
assert.equal(testProvenance.independent, true, 'the evidence package carries no independent test signal')
if (testProvenance.agentModifiedTestFiles.length) {
  const baseline = viewed.body.evidencePackage.checks.find((check) => check.name.endsWith('@baseline'))
  assert.ok(baseline, 'the run modified test files but the package has no baseline conclusion')
  assert.equal(baseline.provenance, 'pre_existing')
  assert.equal(baseline.conclusion, 'success')
}

const proposalBeforeReview = (await request<{ changeProposal: { id: string; status: string; headSha: string; headRef: string } }>(`/api/change-proposals/${agentRun.changeProposalId}`, { cookie: reviewerCookie })).body.changeProposal
await request(`/api/change-proposals/${agentRun.changeProposalId}/reviews`, { cookie: reviewerCookie, body: { headSha: proposalBeforeReview.headSha, decision: 'approved', comment: '已查看 Decision Brief 与 Evidence Package，逐条核对 AC-1、AC-2、AC-3、AC-4、AC-5，批准该 Revision。' } })
const approvedProposal = (await request<{ changeProposal: { id: string; status: string; headSha: string; headRef: string } }>(`/api/change-proposals/${agentRun.changeProposalId}`, { cookie: ownerCookie })).body.changeProposal
assert.equal(approvedProposal.status, 'approved')

const merged = (await request<{ proposal: { status: string }; evidence: { id: string; approvedHeadSha: string; mergedSha: string; evidenceDigest: string } }>(`/api/change-proposals/${agentRun.changeProposalId}/merge`, { cookie: ownerCookie, body: {} })).body
assert.equal(merged.proposal.status, 'merged')
assert.equal(merged.evidence.approvedHeadSha, approvedProposal.headSha)
assert.equal(merged.evidence.mergedSha, approvedProposal.headSha)

const candidate = (await request<{ releaseCandidate: ReleaseCandidateView }>(`/api/change-proposals/${agentRun.changeProposalId}/release-candidates`, { cookie: ownerCookie, body: {} })).body.releaseCandidate
assert.equal(candidate.status, 'review_ready')
assert.equal(candidate.commitSha, merged.evidence.mergedSha)
assert.equal(candidate.artifactClass, 'source_with_build_attestation')
assert.ok(candidate.artifactBindingDigest)
assert.equal(candidate.artifactEvidence.length, 1)
assert.equal(candidate.artifactEvidence[0].packageDigest, viewed.body.evidencePackage.packageDigest)
assert.equal(candidate.artifactEvidence[0].sourceCommitSha, approvedProposal.headSha)
assert.equal(candidate.artifactEvidence[0].buildCheckName, 'application-build')

const released = (await request<{ releaseCandidate: ReleaseCandidateView }>(`/api/release-candidates/${candidate.id}/approve`, { cookie: releaseApproverCookie, body: { comment: '已复核 Merge Evidence、源码树摘要和构建产物绑定，批准发布。' } })).body.releaseCandidate
assert.equal(released.status, 'approved')
assert.equal(released.approval?.approverActorId, releaseApprover.id)
assert.equal(released.approval?.candidateContentDigest, candidate.contentDigest)

const events = (await request<{ events: DomainEvent[] }>(`/api/events?limit=500&projectId=${encodeURIComponent(project.id)}`, { cookie: ownerCookie })).body.events
function verifyEventChain(aggregateType: string, aggregateId: string, expectedTypes: string[]) {
  const chain = events.filter((event) => event.aggregateType === aggregateType && event.aggregateId === aggregateId).sort((left, right) => left.aggregateVersion - right.aggregateVersion)
  assert.ok(chain.length, `missing ${aggregateType}/${aggregateId} event chain`)
  assert.equal(chain[0].previousEventDigest, 'genesis')
  chain.forEach((event, index) => {
    assert.match(event.eventDigest, /^sha256:[0-9a-f]{64}$/u)
    if (index) assert.equal(event.previousEventDigest, chain[index - 1].eventDigest, `${aggregateType}/${aggregateId} event chain is discontinuous at ${event.eventType}`)
  })
  const types = new Set(chain.map((event) => event.eventType))
  expectedTypes.forEach((eventType) => assert.ok(types.has(eventType), `missing ${eventType} in ${aggregateType}/${aggregateId} event chain`))
  return chain
}

verifyEventChain('work_item', workItem.id, ['work_item.created', 'intent.versioned', 'intent.approved'])
verifyEventChain('agent_run', agentRun.id, ['agent_run.started', 'agent_run.succeeded'])
const proposalEvents = verifyEventChain('change_proposal', approvedProposal.id, ['change_proposal.created', 'review.assigned', 'review.decision_brief_opened', 'evidence.viewed', 'review.approved', 'change_proposal.merged'])
const releaseEvents = verifyEventChain('release_candidate', released.id, ['release_candidate.created', 'release_candidate.approved'])
assert.equal(proposalEvents.filter((event) => event.eventType === 'review.decision_brief_opened').length, 1, 'Decision Brief view event must be idempotent')

const report = {
  caseId,
  result: 'release_approved',
  completedAt: new Date().toISOString(),
  repositoryPath,
  actors: { ownerActorId: owner.id, reviewerActorId: reviewer.id, releaseApproverActorId: releaseApprover.id },
  projectId: project.id,
  workItemId: workItem.id,
  intentVersionId: intent.id,
  runId: agentRun.id,
  changeProposalId: approvedProposal.id,
  headRef: approvedProposal.headRef,
  headSha: approvedProposal.headSha,
  evidenceDigest: viewed.body.evidencePackage.packageDigest,
  mergeEvidence: { id: merged.evidence.id, digest: merged.evidence.evidenceDigest, mergedSha: merged.evidence.mergedSha },
  releaseCandidate: { id: released.id, status: released.status, contentDigest: released.contentDigest, sourceTreeDigest: released.sourceTreeDigest, artifactBindingDigest: released.artifactBindingDigest, artifactDigests: released.artifactEvidence.flatMap((evidence) => evidence.artifactDigests) },
  eventChainHeads: { changeProposal: proposalEvents.at(-1)?.eventDigest, releaseCandidate: releaseEvents.at(-1)?.eventDigest },
  worstHealthLatencyMsDuringRun: worstHealthLatencyMs,
  testProvenance: { agentModifiedTestFiles: testProvenance.agentModifiedTestFiles, conclusions: viewed.body.evidencePackage.checks.filter((check) => check.kind === 'test').map((check) => `${check.name}=${check.conclusion}/${check.provenance ?? 'unknown'}`) },
}
const reportDirectory = join(repositoryRoot, 'output/real-cases')
mkdirSync(reportDirectory, { recursive: true })
writeFileSync(join(reportDirectory, `${caseId}.json`), `${JSON.stringify(report, null, 2)}\n`)
writeFileSync(join(reportDirectory, `${caseId}.md`), `# AI Native SDLC Real Case · ${caseId}\n\n- Result: \`${report.result}\`\n- Project: \`${report.projectId}\`\n- Work Item: \`${report.workItemId}\`\n- Intent: \`${report.intentVersionId}\`\n- Agent Run: \`${report.runId}\`\n- Change Proposal: \`${report.changeProposalId}\` @ \`${report.headSha}\`\n- Evidence: \`${report.evidenceDigest}\`\n- Merge Evidence: \`${report.mergeEvidence.digest}\`\n- Release Candidate: \`${report.releaseCandidate.id}\` · \`${report.releaseCandidate.status}\`\n- Release content digest: \`${report.releaseCandidate.contentDigest}\`\n- Artifact binding digest: \`${report.releaseCandidate.artifactBindingDigest}\`\n- Proposal event chain head: \`${report.eventChainHeads.changeProposal}\`\n- Release event chain head: \`${report.eventChainHeads.releaseCandidate}\`\n- Worst health latency during Run: \`${report.worstHealthLatencyMsDuringRun} ms\`\n`)

console.log(JSON.stringify(report, null, 2))
