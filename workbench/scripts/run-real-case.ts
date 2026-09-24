import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

const baseUrl = process.env.REAL_CASE_CONTROL_PLANE_URL ?? 'http://127.0.0.1:8787'
const repositoryPath = resolve(process.env.REAL_CASE_REPOSITORY ?? '../examples/real-case-import-validator')
const ownerPassword = process.env.REAL_CASE_OWNER_PASSWORD
const reviewerPassword = process.env.REAL_CASE_REVIEWER_PASSWORD

if (!ownerPassword || !reviewerPassword) throw new Error('REAL_CASE_OWNER_PASSWORD and REAL_CASE_REVIEWER_PASSWORD are required')

async function request<T>(path: string, input: { method?: string; cookie?: string; body?: Record<string, unknown> } = {}) {
  const response = await fetch(`${baseUrl}${path}`, { method: input.method ?? (input.body ? 'POST' : 'GET'), headers: { ...(input.cookie ? { cookie: input.cookie } : {}), ...(input.body ? { 'content-type': 'application/json' } : {}) }, body: input.body ? JSON.stringify(input.body) : undefined })
  const text = await response.text()
  const payload = text ? JSON.parse(text) as T & { error?: { code: string; message: string } } : undefined
  if (!response.ok) throw new Error(`${response.status} ${payload?.error?.code ?? 'request_failed'}: ${payload?.error?.message ?? text}`)
  return { body: payload as T, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}

const setupStatus = await request<{ required: boolean }>('/api/setup/status')
let ownerCookie: string
if (setupStatus.body.required) {
  const setup = await request<{ actor: { id: string } }>('/api/setup', { body: { username: 'real-owner', displayName: 'Real Case Owner', password: ownerPassword } })
  ownerCookie = setup.cookie!
} else {
  const login = await request<{ actor: { id: string } }>('/api/auth/login', { body: { username: 'real-owner', password: ownerPassword } })
  ownerCookie = login.cookie!
}

const actors = await request<{ actors: Array<{ id: string; username: string }> }>('/api/actors', { cookie: ownerCookie })
let reviewer = actors.body.actors.find((actor) => actor.username === 'real-reviewer')
if (!reviewer) {
  reviewer = (await request<{ actor: { id: string; username: string } }>('/api/actors', { cookie: ownerCookie, body: { username: 'real-reviewer', displayName: 'Real Case Reviewer', role: 'reviewer', password: reviewerPassword } })).body.actor
}

// The repository belongs to a project; reuse the one already pointing at it, or create it once.
type ProjectView = { id: string; slug: string; repositoryPath?: string; defaultBranch: string; status: string }
const projects = (await request<{ projects: ProjectView[] }>('/api/projects', { cookie: ownerCookie })).body.projects
const project = projects.find((item) => item.status === 'active' && item.repositoryPath === realpathSync(repositoryPath))
  ?? (await request<{ project: ProjectView }>('/api/projects', { cookie: ownerCookie, body: { slug: `real-case-${Date.now().toString(36)}`, name: '真实案例 · 导入校验', codeHost: 'local', repositoryPath: realpathSync(repositoryPath), defaultBranch: 'main' } })).body.project
await request(`/api/projects/${project.id}/members`, { cookie: ownerCookie, body: { actorId: reviewer.id, role: 'reviewer' } })

const workItem = (await request<{ workItem: { id: string } }>('/api/work-items', { cookie: ownerCookie, body: { projectId: project.id, title: '为导入功能增加格式与大小校验', description: '真实案例：由 Codex 修改 TypeScript 应用，使既定验收测试通过。', productType: 'application' } })).body.workItem
const intent = (await request<{ intentVersion: { id: string } }>(`/api/work-items/${workItem.id}/intent-versions`, { cookie: ownerCookie, body: {
  goal: '实现确定性的导入文件校验：仅允许 CSV/JSON，最大 5 MiB，并保持错误顺序稳定。',
  constraints: ['不得删除、跳过或弱化既有测试', '不得使用网络或增加外部依赖', '只修改当前 Git Worktree', '保持返回结构兼容'],
  riskLevel: 'medium',
  acceptanceCriteria: [
    { statement: 'CSV 与 JSON 文件在 5 MiB 以内通过校验', criticality: 'critical', verificationType: 'deterministic' },
    { statement: '不支持的扩展名返回 unsupported_file_type', criticality: 'critical', verificationType: 'deterministic' },
    { statement: '超过 5 MiB 返回 file_too_large', criticality: 'critical', verificationType: 'deterministic' },
    { statement: '空文件名且大小为 -1 时，按 file_name_required、invalid_file_size、unsupported_file_type 的固定顺序返回全部错误', criticality: 'critical', verificationType: 'deterministic' },
  ],
} })).body.intentVersion

type AgentRunView = { id: string; status: string; changeProposalId: string; errorMessage?: string }
const reviewerLogin = await request('/api/auth/login', { body: { username: 'real-reviewer', password: reviewerPassword } })
const reviewerCookie = reviewerLogin.cookie!
// DOMAIN_MODEL.md §6.1: the medium risk Intent is approved by the reviewer, not its author, before the Run is admitted.
const intentApproval = await request<{ intentVersion: { status: string } }>(`/api/intent-versions/${encodeURIComponent(intent.id)}/approve`, { cookie: reviewerCookie, body: { comment: '验收标准可断言，批准启动 Run。' } })
assert.equal(intentApproval.body.intentVersion.status, 'approved')
const queued = (await request<{ agentRun: AgentRunView }>('/api/agent-runs', { cookie: ownerCookie, body: { workItemId: workItem.id, intentVersionId: intent.id, declaredContextPaths: ['README.md', 'package.json', 'src/import-validator.ts', 'test/import-validator.test.ts'] } })).body.agentRun

// Runs execute in a worker process, so the start request only admits the run. Poll for the outcome, and
// keep probing /api/health so the case also demonstrates the control plane staying available meanwhile.
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

const reviewProjection = await request<{ readiness: Array<{ changeProposalId: string; status: string; evidence: Array<{ id: string }> }> }>('/api/reviews', { cookie: ownerCookie })
const readiness = reviewProjection.body.readiness.find((item) => item.changeProposalId === agentRun.changeProposalId)
assert.equal(readiness?.status, 'ready')
assert.ok(readiness?.evidence[0]?.id)

type EvidenceCheck = { name: string; kind: string; conclusion: string; provenance?: string }
type TestProvenance = { independent: boolean; agentModifiedTestFiles: string[]; note: string }
const viewed = await request<{ evidencePackage: { packageDigest: string; checks: EvidenceCheck[]; testProvenance: TestProvenance }; view: { reviewerActorId: string } }>(`/api/evidence/${readiness!.evidence[0].id}/view`, { cookie: reviewerCookie, body: {} })
assert.equal(viewed.body.view.reviewerActorId, reviewer.id)
assert.equal(viewed.body.evidencePackage.checks.every((check) => check.conclusion === 'success'), true)

// The reviewer must be able to tell which conclusion the agent could not have authored the tests for.
const testProvenance = viewed.body.evidencePackage.testProvenance
assert.equal(testProvenance.independent, true, 'the evidence package carries no independent test signal')
if (testProvenance.agentModifiedTestFiles.length) {
  const baseline = viewed.body.evidencePackage.checks.find((check) => check.name.endsWith('@baseline'))
  assert.ok(baseline, 'the run modified test files but the package has no baseline conclusion')
  assert.equal(baseline.provenance, 'pre_existing')
  assert.equal(baseline.conclusion, 'success')
}

await request(`/api/change-proposals/${agentRun.changeProposalId}/reviews`, { cookie: reviewerCookie, body: { headSha: (await request<{ changeProposal: { headSha: string } }>(`/api/change-proposals/${agentRun.changeProposalId}`, { cookie: reviewerCookie })).body.changeProposal.headSha, decision: 'approved', comment: '已查看 Evidence Package；既定测试全部通过，批准该 Revision。' } })
const final = await request<{ changeProposal: { id: string; status: string; headSha: string; headRef: string }; events: Array<{ eventType: string; eventDigest: string }> }>(`/api/change-proposals/${agentRun.changeProposalId}`, { cookie: reviewerCookie })
assert.equal(final.body.changeProposal.status, 'approved')

console.log(JSON.stringify({
  result: 'approved',
  repositoryPath,
  workItemId: workItem.id,
  intentVersionId: intent.id,
  runId: agentRun.id,
  changeProposalId: final.body.changeProposal.id,
  headRef: final.body.changeProposal.headRef,
  headSha: final.body.changeProposal.headSha,
  evidenceDigest: viewed.body.evidencePackage.packageDigest,
  eventChainHead: final.body.events.at(-1)?.eventDigest,
  worstHealthLatencyMsDuringRun: worstHealthLatencyMs,
  testProvenance: { agentModifiedTestFiles: testProvenance.agentModifiedTestFiles, conclusions: viewed.body.evidencePackage.checks.filter((check) => check.kind === 'test').map((check) => `${check.name}=${check.conclusion}/${check.provenance ?? 'unknown'}`) },
}, null, 2))
