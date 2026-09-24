import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ControlPlaneDatabase } from '../server/database.ts'
import { createControlPlaneRequestHandler } from '../server/http-server.ts'
import { LocalCommandAgentRunner } from '../server/local-command-agent-runner.ts'
import { LocalEvidenceStore } from '../server/local-evidence-store.ts'
import { AppError } from '../server/types.ts'
import { criteriaSyntaxHint, intentTemplates, lintIntentDraft, maximumStatementLength, parseAcceptanceCriteria, splitLines, type ParsedCriterion } from '../src/intent-templates.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function expectAppError(code: string, run: () => unknown) {
  try {
    run()
  } catch (error) {
    assert(error instanceof AppError, `expected an AppError for ${code}, got ${String(error)}`)
    assert(error.code === code, `expected error code ${code}, got ${error.code}`)
    assert(error.status === 400, `expected status 400 for ${code}, got ${error.status}`)
    return
  }
  throw new Error(`expected ${code} to be rejected`)
}

// --- 解析器：每个标注都必须映射到确切的领域枚举值 ---

const tagged = parseAcceptanceCriteria([
  '[确定性] 超过 5 MiB 返回 file_too_large',
  '[模型] 回答在准确性维度上不低于 4 分',
  '[人工] 错误文案符合产品语气',
  '[参考] 日志里带上请求耗时',
  '[关键][人工] 高风险变更由非作者复核',
  'unsupported_file_type 必须被拒绝',
].join('\n'))

assert(tagged.length === 6, `expected 6 criteria, got ${tagged.length}`)
assert(tagged[0].verificationType === 'deterministic' && tagged[0].criticality === 'critical', '[确定性] should map to deterministic + critical')
assert(tagged[0].statement === '超过 5 MiB 返回 file_too_large', `tag should be stripped from the statement, got ${tagged[0].statement}`)
assert(tagged[1].verificationType === 'model', '[模型] should map to model')
assert(tagged[2].verificationType === 'human', '[人工] should map to human')
assert(tagged[3].criticality === 'normal', '[参考] should downgrade criticality to normal')
assert(tagged[3].verificationType === 'deterministic', '[参考] alone should leave the verification default untouched')
assert(tagged[4].criticality === 'critical' && tagged[4].verificationType === 'human', 'two tags on one line should both apply')

// 没有标注时必须落到「关键 · 确定性」。默认成 normal 会让忘记标注的人静默关掉审批门禁。
assert(tagged[5].criticality === 'critical' && tagged[5].verificationType === 'deterministic', 'an untagged line must default to critical + deterministic')

const english = parseAcceptanceCriteria('[human] a reviewer signs off\n[normal][model] tone is acceptable')
assert(english[0].verificationType === 'human', 'English tags should be accepted')
assert(english[1].criticality === 'normal' && english[1].verificationType === 'model', 'English tags should combine like the Chinese ones')

// 打错的标注不能被静默吞掉：起草人会以为自己声明了人工验证。
const typo = parseAcceptanceCriteria('[确定] 返回 file_too_large')
assert(typo[0].warnings.some((warning) => warning.includes('不是已知标注')), 'an unrecognised tag must warn')
assert(typo[0].verificationType === 'deterministic', 'an unrecognised tag must fall back to the default, not to something invented')

// 未识别的方括号必须原样留在语句里。「打错的标注」与「以方括号开头的语句」无法区分，切掉它会让 contentDigest
// 与 Agent prompt 里的标准不再是起草人写下的那句话（对抗检查 F1）。
assert(typo[0].statement === '[确定] 返回 file_too_large', `an unrecognised tag must stay in the statement, got ${typo[0].statement}`)
const bracketed = parseAcceptanceCriteria('[POST /api/import] 上传 6 MiB 文件返回 file_too_large\n[边界情况] 超过 5 MiB 返回 file_too_large')
assert(bracketed[0].statement === '[POST /api/import] 上传 6 MiB 文件返回 file_too_large', `a statement that starts with a bracket must survive intact, got ${bracketed[0].statement}`)
assert(bracketed[1].statement === '[边界情况] 超过 5 MiB 返回 file_too_large', `a bracketed heading must survive intact, got ${bracketed[1].statement}`)
// 已知标注在前、未识别的在后：前面的照常生效，从未识别的那个开始全部是语句。
const mixed = parseAcceptanceCriteria('[人工][边界] 错误文案符合产品语气')
assert(mixed[0].verificationType === 'human' && mixed[0].statement === '[边界] 错误文案符合产品语气', `known tags before an unknown one must apply, got ${mixed[0].verificationType} / ${mixed[0].statement}`)

const blankTag = parseAcceptanceCriteria('[人工]')
assert(blankTag[0].statement === '' && blankTag[0].warnings.some((warning) => warning.includes('只有标注')), 'a tag with no statement must be reported')

const duplicated = parseAcceptanceCriteria('返回 file_too_large\n返回 file_too_large')
assert(duplicated[1].warnings.some((warning) => warning.includes('重复')), 'a duplicated statement must warn')

// --- 模糊度检查：提示而不是拦截 ---

const vague = parseAcceptanceCriteria('[确定性] 把界面优化一下')
assert(vague[0].warnings.some((warning) => warning.includes('优化')), 'a vague statement must warn')
const anchored = parseAcceptanceCriteria('[确定性] 首屏渲染在 200ms 内完成')
assert(anchored[0].warnings.length === 0, `a measurable statement must not warn, got ${anchored[0].warnings.join('; ')}`)
const humanJudgement = parseAcceptanceCriteria('[人工] 错误文案符合产品语气')
assert(humanJudgement[0].warnings.length === 0, 'a statement that openly needs human judgement must not be nagged for missing numbers')

assert(splitLines(' a \n\n b \n') .join('|') === 'a|b', 'splitLines should trim and drop blank lines')

// 「稳定」回到模糊词表：不再为了让一条已有标准不告警而修改判据（对抗检查 F6）。
const stable = parseAcceptanceCriteria('[确定性] 无效输入返回稳定且可测试的错误顺序')
assert(stable[0].warnings.some((warning) => warning.includes('稳定')), '「稳定」 without an anchor must warn')

// 长度上限：超长是「几条标准写在一行」的信号，并且整条会进入 Agent prompt（对抗检查 F4）。
const oversized = parseAcceptanceCriteria('[确定性] 返回 file_too_large ' + 'x'.repeat(maximumStatementLength))
assert(oversized[0].warnings.some((warning) => warning.includes('上限')), 'an oversized statement must warn on the criterion')
assert(lintIntentDraft({ goal: '仅允许 CSV/JSON 且上限 5 MiB', constraints: ['x'], riskLevel: 'low', criteria: oversized }).blockers.some((blocker) => blocker.includes('拆成多条')), 'an oversized statement must block')

// --- 模版：必须在教语法，而不是依赖默认值 ---

for (const [productType, template] of Object.entries(intentTemplates)) {
  const criteria = parseAcceptanceCriteria(template.criteria)
  assert(criteria.length >= 4, `${productType} template should seed at least 4 criteria`)
  const untagged = criteria.filter((criterion) => !template.criteria.split('\n').some((line) => line.includes(criterion.statement) && /^\s*[[［]/u.test(line)))
  assert(untagged.length === 0, `${productType} template must tag every criterion explicitly, ${untagged.length} were untagged`)
  assert(criteria.some((criterion) => criterion.verificationType === 'human'), `${productType} template should show what a human-verified criterion looks like`)
  assert(criteria.some((criterion) => criterion.criticality === 'normal'), `${productType} template should show the non-blocking [参考] form`)
  assert(splitLines(template.constraints).length >= 3, `${productType} template should seed real constraints, not placeholders like local-first`)
  // 模版留着占位符是刻意的：套用之后 linter 立刻要求逐项替换，模版不能是「可以直接提交的空话」。
  const lint = lintIntentDraft({ goal: template.goal, constraints: splitLines(template.constraints), riskLevel: 'medium', criteria })
  assert(lint.warnings.length > 0, `${productType} template should still be flagged as unfinished right after it is applied`)
  assert(criteria.some((criterion) => criterion.warnings.some((warning) => warning.includes('占位符'))), `${productType} template placeholders should be called out`)
}

assert(intentTemplates.agent_system.criteria.includes('[模型]'), 'the agent template should show the model-evaluated form')
assert(criteriaSyntaxHint.includes('[人工]'), 'the shared syntax hint should name the tags')

// --- 高风险不变量（DOMAIN_MODEL.md：高风险 Intent 必须定义人工审批要求） ---

const humanFree: ParsedCriterion[] = parseAcceptanceCriteria('[确定性] 返回 file_too_large')
const highRiskBlocked = lintIntentDraft({ goal: '仅允许 CSV/JSON 且上限 5 MiB', constraints: ['不得弱化既有测试'], riskLevel: 'high', criteria: humanFree })
assert(highRiskBlocked.blockers.some((blocker) => blocker.includes('[人工]')), 'high risk without a human criterion must be blocked in the draft')

const highRiskOk = lintIntentDraft({ goal: '仅允许 CSV/JSON 且上限 5 MiB', constraints: ['不得弱化既有测试'], riskLevel: 'high', criteria: parseAcceptanceCriteria('[确定性] 返回 file_too_large\n[人工] 由非作者复核安全影响') })
assert(highRiskOk.blockers.length === 0, `adding a human criterion must clear the blocker, got ${highRiskOk.blockers.join('; ')}`)

// 用一条自己声明「不阻塞合并」的 [参考][人工] 满足「必须有人工审批」是自相矛盾的（对抗检查 F2.1）。
const normalHuman = lintIntentDraft({ goal: '仅允许 CSV/JSON 且上限 5 MiB', constraints: ['不得弱化既有测试'], riskLevel: 'high', criteria: parseAcceptanceCriteria('[确定性] 返回 file_too_large\n[参考][人工] 由非作者复核安全影响') })
assert(normalHuman.blockers.some((blocker) => blocker.includes('关键的 [人工]')), 'a non-critical human criterion must not satisfy the high risk invariant')

// 中、高风险至少一条关键标准；全部降级为 [参考] 的 Intent 会在门禁生效那天静默绕过它（对抗检查 F3）。
const allNormal = parseAcceptanceCriteria('[参考] 超过 5 MiB 返回 file_too_large\n[参考] 不支持扩展名返回 unsupported_file_type')
assert(lintIntentDraft({ goal: '仅允许 CSV/JSON 且上限 5 MiB', constraints: ['x'], riskLevel: 'medium', criteria: allNormal }).blockers.some((blocker) => blocker.includes('至少要有一条关键标准')), 'a medium risk intent with only [参考] criteria must block')
const lowAllNormal = lintIntentDraft({ goal: '仅允许 CSV/JSON 且上限 5 MiB', constraints: ['x'], riskLevel: 'low', criteria: allNormal })
assert(lowAllNormal.blockers.length === 0 && lowAllNormal.warnings.some((warning) => warning.includes('不会阻塞任何审批')), 'a low risk intent may be all [参考], with a warning')

const mediumRiskOk = lintIntentDraft({ goal: '仅允许 CSV/JSON 且上限 5 MiB', constraints: ['不得弱化既有测试'], riskLevel: 'medium', criteria: humanFree })
assert(mediumRiskOk.blockers.length === 0, 'the human-criterion requirement applies to high risk only')

const emptyStatement = lintIntentDraft({ goal: '仅允许 CSV/JSON 且上限 5 MiB', constraints: ['不得弱化既有测试'], riskLevel: 'low', criteria: parseAcceptanceCriteria('[人工]') })
assert(emptyStatement.blockers.some((blocker) => blocker.includes('只写了标注')), 'a tag-only line must block rather than be silently dropped')

const modelOnly = lintIntentDraft({ goal: '在 120 条标注工单上合规率不低于 95%', constraints: ['不得访问 holdout'], riskLevel: 'high', criteria: parseAcceptanceCriteria('[模型] 合规率不低于 95%\n[人工] 抽样 20 条无不可接受行为') })
assert(modelOnly.warnings.every((warning) => !warning.includes('唯一关键证据')), 'a human criterion alongside the model one should not trip the model-only warning')
const modelOnlyCritical = lintIntentDraft({ goal: '在 120 条标注工单上合规率不低于 95%', constraints: ['不得访问 holdout'], riskLevel: 'high', criteria: parseAcceptanceCriteria('[模型] 合规率不低于 95%\n[参考][人工] 抽样 20 条无不可接受行为') })
assert(modelOnlyCritical.warnings.some((warning) => warning.includes('唯一关键证据')), 'critical criteria that are all model-evaluated must warn')

// --- 服务端：同一条不变量必须在 database 层生效，绕过前端也拦得住 ---

const root = mkdtempSync(join(tmpdir(), 'aperture-intent-template-'))
try {
  const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')
  const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), migrationDirectory)
  const owner = database.createActor({ username: 'owner', displayName: 'Owner', role: 'owner', password: 'owner-password-2026' })
  const workItem = database.createWorkItem({ title: '为导入功能增加格式与大小校验', description: '模版与验收标准的服务端不变量', productType: 'application', ownerActorId: owner.id }, owner.id)

  expectAppError('high_risk_requires_human_verification', () => database.createIntentVersion({
    workItemId: workItem.id,
    goal: '仅允许 CSV/JSON，最大 5 MiB',
    constraints: ['不得弱化既有测试'],
    riskLevel: 'high',
    acceptanceCriteria: [{ statement: '超过 5 MiB 返回 file_too_large', criticality: 'critical', verificationType: 'deterministic' }],
  }, owner.id))

  expectAppError('invalid_acceptance_criteria', () => database.createIntentVersion({
    workItemId: workItem.id,
    goal: '仅允许 CSV/JSON，最大 5 MiB',
    constraints: [],
    riskLevel: 'medium',
    acceptanceCriteria: [{ statement: '超过 5 MiB 返回 file_too_large', criticality: 'blocking' as 'critical', verificationType: 'deterministic' }],
  }, owner.id))

  expectAppError('invalid_acceptance_criteria', () => database.createIntentVersion({
    workItemId: workItem.id,
    goal: '仅允许 CSV/JSON，最大 5 MiB',
    constraints: [],
    riskLevel: 'medium',
    acceptanceCriteria: [{ statement: '超过 5 MiB 返回 file_too_large', criticality: 'critical', verificationType: 'vibes' as 'model' }],
  }, owner.id))

  expectAppError('invalid_acceptance_criteria', () => database.createIntentVersion({
    workItemId: workItem.id,
    goal: '仅允许 CSV/JSON，最大 5 MiB',
    constraints: [],
    riskLevel: 'medium',
    acceptanceCriteria: [{ statement: '   ', criticality: 'critical', verificationType: 'deterministic' }],
  }, owner.id))

  expectAppError('high_risk_requires_human_verification', () => database.createIntentVersion({
    workItemId: workItem.id,
    goal: '仅允许 CSV/JSON，最大 5 MiB',
    constraints: [],
    riskLevel: 'high',
    acceptanceCriteria: [
      { statement: '超过 5 MiB 返回 file_too_large', criticality: 'critical', verificationType: 'deterministic' },
      { statement: '由非作者复核安全影响', criticality: 'normal', verificationType: 'human' },
    ],
  }, owner.id))

  expectAppError('intent_requires_critical_criterion', () => database.createIntentVersion({
    workItemId: workItem.id,
    goal: '仅允许 CSV/JSON，最大 5 MiB',
    constraints: [],
    riskLevel: 'medium',
    acceptanceCriteria: [{ statement: '超过 5 MiB 返回 file_too_large', criticality: 'normal', verificationType: 'deterministic' }],
  }, owner.id))

  expectAppError('invalid_acceptance_criteria', () => database.createIntentVersion({
    workItemId: workItem.id,
    goal: '仅允许 CSV/JSON，最大 5 MiB',
    constraints: [],
    riskLevel: 'medium',
    acceptanceCriteria: [{ statement: 'x'.repeat(maximumStatementLength + 1), criticality: 'critical', verificationType: 'deterministic' }],
  }, owner.id))

  assert(database.listIntentVersions(workItem.id).length === 0, 'a rejected intent must not be partially stored')

  // 低风险允许全部 normal——这是唯一一个「不设门禁」被允许显式声明的地方。
  const lowRiskWorkItem = database.createWorkItem({ title: '低风险全参考', description: '低风险可以不设关键项', productType: 'application', ownerActorId: owner.id }, owner.id)
  database.createIntentVersion({ workItemId: lowRiskWorkItem.id, goal: '日志里带上请求耗时', constraints: [], riskLevel: 'low', acceptanceCriteria: [{ statement: '日志里带上请求耗时 ms', criticality: 'normal', verificationType: 'deterministic' }] }, owner.id)

  const stored = database.createIntentVersion({
    workItemId: workItem.id,
    goal: '仅允许 CSV/JSON，最大 5 MiB，并保持错误顺序稳定',
    constraints: splitLines(intentTemplates.application.constraints),
    riskLevel: 'high',
    acceptanceCriteria: parseAcceptanceCriteria([
      '[确定性] 超过 5 MiB 返回 file_too_large',
      '[模型] 错误文案在清晰度上不低于 4 分',
      '[人工] 由非作者复核安全影响',
      '[参考] 日志里带上请求耗时',
    ].join('\n')).map(({ statement, criticality, verificationType }) => ({ statement, criticality, verificationType })),
  }, owner.id)

  // 关键断言：落库的是起草人声明的值，不再是全部 critical/deterministic。
  const verificationTypes = stored.acceptanceCriteria.map((criterion) => criterion.verificationType)
  assert(verificationTypes.join(',') === 'deterministic,model,human,deterministic', `verification types must survive as declared, got ${verificationTypes.join(',')}`)
  const criticalities = stored.acceptanceCriteria.map((criterion) => criterion.criticality)
  assert(criticalities.join(',') === 'critical,critical,critical,normal', `criticalities must survive as declared, got ${criticalities.join(',')}`)

  const reread = database.getIntentVersion(stored.id)
  assert(reread.acceptanceCriteria.map((criterion) => criterion.verificationType).join(',') === 'deterministic,model,human,deterministic', 'verification types must round-trip through SQLite')
  assert(reread.constraints.length === 4 && reread.constraints.every((constraint) => !constraint.includes('local-first')), 'constraints must be the drafted ones, not the old hardcoded tokens')

  // 两份不同的标注组合必须产生不同的 contentDigest：这两个字段确实参与了 Intent 的身份。用低风险是因为只有它
  // 允许唯一一条标准是 normal，这样两组除标注外完全相同。
  const otherWorkItem = database.createWorkItem({ title: '同一目标但标注不同', description: 'digest 对比', productType: 'application', ownerActorId: owner.id }, owner.id)
  const digestA = database.createIntentVersion({ workItemId: otherWorkItem.id, goal: '仅允许 CSV/JSON，最大 5 MiB', constraints: [], riskLevel: 'low', acceptanceCriteria: [{ statement: '超过 5 MiB 返回 file_too_large', criticality: 'critical', verificationType: 'deterministic' }] }, owner.id).contentDigest
  const digestB = database.createIntentVersion({ workItemId: otherWorkItem.id, goal: '仅允许 CSV/JSON，最大 5 MiB', constraints: [], riskLevel: 'low', acceptanceCriteria: [{ statement: '超过 5 MiB 返回 file_too_large', criticality: 'normal', verificationType: 'human' }] }, owner.id).contentDigest
  assert(digestA !== digestB, 'criticality and verificationType must participate in contentDigest')

  // --- HTTP 边界：同一条不变量必须让绕过前端的调用者也撞到 400，而不是靠前端禁用按钮维持 ---

  const httpRoot = mkdtempSync(join(root, 'http-'))
  const httpDatabase = new ControlPlaneDatabase(join(httpRoot, 'control-plane.db'), migrationDirectory)
  const handler = createControlPlaneRequestHandler({
    database: httpDatabase,
    agentRunner: new LocalCommandAgentRunner({ database: httpDatabase, executable: process.execPath, args: ['-e', ''], worktreeRoot: join(httpRoot, 'agent-runs'), timeoutMs: 10_000 }),
    evidenceStore: new LocalEvidenceStore(join(httpRoot, 'evidence')),
  })

  async function call<T>(path: string, input: { method?: string; cookie?: string; body?: Record<string, unknown> } = {}) {
    const payload = input.body ? JSON.stringify(input.body) : ''
    const headers: IncomingHttpHeaders = { ...(input.cookie ? { cookie: input.cookie } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) }
    const requestStream = Readable.from(payload ? [Buffer.from(payload)] : []) as IncomingMessage
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
    const setCookie = responseHeaders['set-cookie']
    const cookieValue = Array.isArray(setCookie) ? setCookie[0] : typeof setCookie === 'string' ? setCookie : undefined
    const text = Buffer.concat(chunks).toString('utf8')
    return { status, cookie: cookieValue?.split(';')[0], body: text ? JSON.parse(text) as T : undefined }
  }

  const setup = await call<{ actor: { id: string } }>('/api/setup', { body: { username: 'owner', displayName: 'Local Owner', password: 'owner-password-2026' } })
  assert(setup.status === 201 && setup.cookie, `setup should succeed, got ${setup.status}`)
  const cookie = setup.cookie
  const created = await call<{ workItem: { id: string } }>('/api/work-items', { cookie, body: { projectId: 'PRJ-DEFAULT', title: '为导入功能增加格式与大小校验', description: 'HTTP 边界校验', productType: 'application' } })
  assert(created.status === 201 && created.body, `work item should be created, got ${created.status}`)
  const workItemId = created.body.workItem.id

  const rejected = await call<{ error: { code: string } }>(`/api/work-items/${workItemId}/intent-versions`, { cookie, body: {
    goal: '仅允许 CSV/JSON，最大 5 MiB',
    constraints: ['不得弱化既有测试'],
    riskLevel: 'high',
    acceptanceCriteria: [{ statement: '超过 5 MiB 返回 file_too_large', criticality: 'critical', verificationType: 'deterministic' }],
  } })
  assert(rejected.status === 400, `a high risk intent without a human criterion must be rejected over HTTP, got ${rejected.status}`)
  assert(rejected.body?.error.code === 'high_risk_requires_human_verification', `expected high_risk_requires_human_verification, got ${rejected.body?.error.code}`)

  const normalHumanOverHttp = await call<{ error: { code: string } }>(`/api/work-items/${workItemId}/intent-versions`, { cookie, body: {
    goal: '仅允许 CSV/JSON，最大 5 MiB',
    constraints: [],
    riskLevel: 'high',
    acceptanceCriteria: [
      { statement: '超过 5 MiB 返回 file_too_large', criticality: 'critical', verificationType: 'deterministic' },
      { statement: '由非作者复核安全影响', criticality: 'normal', verificationType: 'human' },
    ],
  } })
  assert(normalHumanOverHttp.status === 400 && normalHumanOverHttp.body?.error.code === 'high_risk_requires_human_verification', `a non-critical human criterion must not satisfy the invariant over HTTP, got ${normalHumanOverHttp.status}`)

  const badEnum = await call<{ error: { code: string } }>(`/api/work-items/${workItemId}/intent-versions`, { cookie, body: {
    goal: '仅允许 CSV/JSON，最大 5 MiB',
    constraints: [],
    riskLevel: 'medium',
    acceptanceCriteria: [{ statement: '超过 5 MiB 返回 file_too_large', criticality: 'critical', verificationType: 'vibes' }],
  } })
  assert(badEnum.status === 400 && badEnum.body?.error.code === 'invalid_acceptance_criteria', `an unknown verification type must be rejected over HTTP, got ${badEnum.status} ${badEnum.body?.error.code}`)

  const accepted = await call<{ intentVersion: { acceptanceCriteria: Array<{ verificationType: string; criticality: string }> } }>(`/api/work-items/${workItemId}/intent-versions`, { cookie, body: {
    goal: '仅允许 CSV/JSON，最大 5 MiB，并保持错误顺序稳定',
    constraints: splitLines(intentTemplates.application.constraints),
    riskLevel: 'high',
    acceptanceCriteria: parseAcceptanceCriteria('[确定性] 超过 5 MiB 返回 file_too_large\n[人工] 由非作者复核安全影响\n[参考] 日志里带上请求耗时').map(({ statement, criticality, verificationType }) => ({ statement, criticality, verificationType })),
  } })
  assert(accepted.status === 201, `a compliant high risk intent must be accepted, got ${accepted.status} ${JSON.stringify(accepted.body)}`)
  assert(accepted.body?.intentVersion.acceptanceCriteria.map((criterion) => criterion.verificationType).join(',') === 'deterministic,human,deterministic', 'the HTTP layer must not rewrite verification types')
  assert(accepted.body?.intentVersion.acceptanceCriteria.map((criterion) => criterion.criticality).join(',') === 'critical,critical,normal', 'the HTTP layer must not rewrite criticalities')

  console.log(`intent template smoke passed · ${Object.keys(intentTemplates).length} templates · ${stored.acceptanceCriteria.length} criteria stored as declared · HTTP boundary enforces the high risk invariant`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
