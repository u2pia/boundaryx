import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ControlPlaneDatabase } from '../server/database.ts'
import { createControlPlaneRequestHandler } from '../server/http-server.ts'
import { normalizeIntentDraft } from '../server/intent-drafter.ts'
import { LocalCommandAgentRunner } from '../server/local-command-agent-runner.ts'
import { LocalEvidenceStore } from '../server/local-evidence-store.ts'
import { AppError } from '../server/types.ts'
import { draftChangedFields, formatAcceptanceCriteria, formatIntentExamples, intentFormContent, parseAcceptanceCriteria, parseIntentExamples, type IntentFormContent } from '../src/intent-templates.ts'

/**
 * An Intent drafted by the model is a suggestion the developer edits: nothing exists until they submit, what they
 * submit is validated like any Intent, and the version records which draft it came from and what was changed, so an
 * approver can tell labels a person chose from labels the model chose.
 */
const root = mkdtempSync(join(tmpdir(), 'aperture-intent-draft-'))
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')
const apiKey = 'sk-intent-draft-secret-2026'

// A stand-in for an OpenAI-compatible provider: it answers with whatever reply the test queues next, after a delay
// when the test needs a draft to still be in progress.
const replies: Array<string | { text: string; delayMs: number }> = []
const received: Array<{ authorization?: string; prompt: string }> = []
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: Array<{ content: string }> }
  received.push({ authorization: request.headers.authorization, prompt: body.messages[0].content })
  const reply = replies.shift() ?? 'no reply queued'
  if (typeof reply !== 'string') await new Promise((done) => setTimeout(done, reply.delayMs))
  if (response.destroyed) return
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ message: { content: typeof reply === 'string' ? reply : reply.text } }] }))
})
provider.listen(0, '127.0.0.1')
await once(provider, 'listening')
const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`

const modelDraft = {
  goal: '开户页校验身份证号，不合法时给出具体原因',
  constraints: ['不得删除或弱化既有测试', '不得改动手机号校验'],
  nonGoals: ['不做港澳台证件'],
  examples: [{ input: '11010519491231002X', expected: '校验通过' }],
  riskLevel: 'low',
  riskRationale: '只是前端校验',
  acceptanceCriteria: [
    { statement: '18 位且校验码正确的号码通过，末位 X 不区分大小写', criticality: 'critical', verificationType: 'deterministic', verifiedBy: ['node-tests', 'made-up-check'] },
    { statement: '长度不是 18 位时提示「身份证号应为 18 位」', criticality: 'critical', verificationType: 'deterministic' },
    { statement: '错误提示文案符合开户页的语气', criticality: 'sometimes', verificationType: 'human', verifiedBy: ['node-tests'] },
  ],
  questions: ['15 位旧号码是否需要支持？'],
}

try {
  // --- Normalisation, without the network ---
  const normalized = normalizeIntentDraft(modelDraft, ['node-tests'])
  assert.deepEqual(normalized.acceptanceCriteria[0].verifiedBy, ['node-tests'], 'a check the manifest does not declare is dropped')
  assert.ok(normalized.adjustments.some((item) => item.includes('made-up-check')), 'and the drop is reported')
  assert.equal(normalized.acceptanceCriteria[2].criticality, 'critical', 'an unknown criticality falls back to the strict default')
  assert.equal(normalized.acceptanceCriteria[2].verifiedBy, undefined, 'a human criterion never names checks')
  assert.equal(normalizeIntentDraft({ ...modelDraft, riskLevel: 'extreme' }, []).riskLevel, 'medium', 'an unknown risk becomes medium')
  const highWithoutHuman = normalizeIntentDraft({ ...modelDraft, riskLevel: 'high', acceptanceCriteria: [modelDraft.acceptanceCriteria[0]] }, [])
  assert.ok(highWithoutHuman.adjustments.some((item) => item.includes('人工标准')), 'a high risk draft without a critical human criterion is pointed out, not repaired')
  assert.ok(!highWithoutHuman.acceptanceCriteria.some((criterion) => criterion.verificationType === 'human'), 'the drafter does not invent the human criterion')
  for (const bad of [undefined, 'text', { goal: '' }, { goal: 'x', acceptanceCriteria: [] }]) {
    assert.throws(() => normalizeIntentDraft(bad, []), (error: unknown) => error instanceof AppError && error.code === 'intent_draft_unparseable')
  }

  // --- The form round-trips what the server hands over ---
  const formatted = formatAcceptanceCriteria(normalized.acceptanceCriteria)
  assert.deepEqual(parseAcceptanceCriteria(formatted).map(({ statement, criticality, verificationType, verifiedBy }) => ({ statement, criticality, verificationType, ...(verifiedBy ? { verifiedBy } : {}) })), normalized.acceptanceCriteria, 'criteria survive formatting and parsing unchanged')
  assert.deepEqual(parseIntentExamples(formatIntentExamples(normalized.examples)).examples, normalized.examples, 'examples survive formatting and parsing unchanged')

  // --- Over HTTP ---
  const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), migrationDirectory)
  const handler = createControlPlaneRequestHandler({
    database,
    agentRunner: new LocalCommandAgentRunner({ database, executable: process.execPath, args: ['-e', ''], worktreeRoot: join(root, 'agent-runs'), timeoutMs: 10_000 }),
    evidenceStore: new LocalEvidenceStore(join(root, 'evidence')),
  })
  // closeAfterMs: the client goes away (a cancel or a closed tab) before the response is written.
  async function call<T>(path: string, input: { cookie?: string; body?: Record<string, unknown>; closeAfterMs?: number } = {}) {
    const payload = input.body ? JSON.stringify(input.body) : ''
    const headers: IncomingHttpHeaders = { ...(input.cookie ? { cookie: input.cookie } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) }
    const requestStream = Readable.from(payload ? [Buffer.from(payload)] : []) as IncomingMessage
    Object.assign(requestStream, { method: input.body ? 'POST' : 'GET', url: path, headers })
    const chunks: Buffer[] = []
    let status = 200
    let responseHeaders: Record<string, string | number | string[]> = {}
    const responseStream = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } }) as ServerResponse
    responseStream.writeHead = ((statusCode: number, nextHeaders?: Record<string, string | number | string[]>) => { status = statusCode; responseHeaders = nextHeaders ?? {}; return responseStream }) as ServerResponse['writeHead']
    const finished = once(responseStream, 'finish')
    if (input.closeAfterMs !== undefined) setTimeout(() => responseStream.destroy(), input.closeAfterMs)
    await handler(requestStream, responseStream)
    if (input.closeAfterMs === undefined) await finished
    const setCookie = responseHeaders['set-cookie']
    const cookieValue = Array.isArray(setCookie) ? setCookie[0] : typeof setCookie === 'string' ? setCookie : undefined
    const text = Buffer.concat(chunks).toString('utf8')
    return { status, cookie: cookieValue?.split(';')[0], text, body: text ? JSON.parse(text) as T : undefined }
  }
  type Draft = { id: string; model: string; riskLevel: string; acceptanceCriteria: Array<{ statement: string; criticality: string; verificationType: string; verifiedBy?: string[] }>; questions: string[]; adjustments: string[]; goal: string; constraints: string[]; nonGoals: string[]; examples: Array<{ input: string; expected: string }> }
  type Version = { id: string; status: string; contentDigest: string; draft?: { draftId: string; model: string; changedFields: string[] } }

  const owner = (await call('/api/setup', { body: { username: 'owner', displayName: 'Owner', password: 'owner-password-2026' } })).cookie!
  await call('/api/actors', { cookie: owner, body: { username: 'developer', displayName: 'Developer', role: 'developer', password: 'developer-password-2026' } })
  const developer = (await call('/api/auth/login', { body: { username: 'developer', password: 'developer-password-2026' } })).cookie!
  assert.ok(developer, 'the developer can log in')
  const brief = { title: '开户页身份证号校验', brief: '开户页要校验身份证号，18 位，末位可以是 X，失败给具体原因，别动手机号校验', productType: 'application' }
  const draftPath = '/api/projects/PRJ-DEFAULT/intent-drafts'

  const unconfigured = await call<{ error: { code: string } }>(draftPath, { cookie: developer, body: brief })
  assert.equal(unconfigured.body?.error.code, 'agent_provider_not_configured', 'drafting needs a configured provider')
  const saved = await call('/api/settings/agent-provider', { cookie: owner, body: { providerId: 'fake', model: 'fake-drafter-1', baseUrl: providerUrl, wireApi: 'chat', apiKey } })
  assert.equal(saved.status, 200, saved.text)

  assert.equal((await call(draftPath, { body: brief })).status, 401, 'drafting needs a session')
  assert.equal((await call<{ error: { code: string } }>(draftPath, { cookie: developer, body: { ...brief, brief: 'x'.repeat(4001) } })).body?.error.code, 'invalid_intent_brief', 'the brief is bounded')

  replies.push('这是草稿：\n```json\n' + JSON.stringify(modelDraft) + '\n```')
  const drafted = await call<{ intentDraft: Draft }>(draftPath, { cookie: developer, body: brief })
  assert.equal(drafted.status, 201, drafted.text)
  const draft = drafted.body!.intentDraft
  assert.equal(draft.model, 'fake-drafter-1')
  assert.equal(draft.riskLevel, 'low')
  assert.deepEqual(draft.questions, modelDraft.questions)
  assert.equal(received.at(-1)?.authorization, `Bearer ${apiKey}`, 'the stored key is sent to the provider it was saved for')
  assert.ok(received.at(-1)?.prompt.includes(brief.brief), 'the brief reaches the model')
  assert.ok(!drafted.text.includes(apiKey), 'the key never comes back')
  assert.equal(database.listWorkItems().length, 0, 'drafting creates nothing')
  assert.ok(draft.adjustments[0]?.includes('项目还没接入仓库'), `a manifest that cannot be read is reported in the draft, not swallowed (${draft.adjustments[0]})`)

  // One draft in progress per person: a second request while the first holds the provider is refused, not queued.
  replies.push({ text: JSON.stringify(modelDraft), delayMs: 300 })
  const slow = call<{ intentDraft: Draft }>(draftPath, { cookie: developer, body: brief })
  await new Promise((done) => setTimeout(done, 50))
  const concurrent = await call<{ error: { code: string } }>(draftPath, { cookie: developer, body: brief })
  assert.equal(concurrent.status, 429)
  assert.equal(concurrent.body?.error.code, 'intent_draft_in_progress')
  assert.equal((await slow).status, 201, 'the first draft still completes')

  // A client that goes away cancels the model call and releases the lock; nothing is recorded for it.
  const draftsBefore = (database as unknown as { db: { prepare(sql: string): { get(): { count: number } } } }).db.prepare('SELECT COUNT(*) AS count FROM intent_drafts').get().count
  replies.push({ text: JSON.stringify(modelDraft), delayMs: 5_000 })
  const cancelStarted = Date.now()
  await call(draftPath, { cookie: developer, body: brief, closeAfterMs: 50 })
  assert.ok(Date.now() - cancelStarted < 2_000, 'the handler returns as soon as the client is gone, without waiting for the model')
  assert.equal((database as unknown as { db: { prepare(sql: string): { get(): { count: number } } } }).db.prepare('SELECT COUNT(*) AS count FROM intent_drafts').get().count, draftsBefore, 'a cancelled draft is not recorded')
  replies.length = 0
  replies.push(JSON.stringify(modelDraft))
  assert.equal((await call(draftPath, { cookie: developer, body: brief })).status, 201, 'the lock is released after a cancel')

  replies.push('抱歉，我不能完成')
  assert.equal((await call<{ error: { code: string } }>(draftPath, { cookie: developer, body: brief })).body?.error.code, 'intent_draft_unparseable', 'a reply without a draft is refused')

  // Submitting the draft unchanged records that nothing was changed; the digest is what it would be without a draft.
  async function submit(cookie: string, content: { riskLevel: string; acceptanceCriteria: Draft['acceptanceCriteria'] }, draftId?: string) {
    const workItem = await call<{ workItem: { id: string } }>('/api/work-items', { cookie, body: { projectId: 'PRJ-DEFAULT', title: brief.title, description: draft.goal, productType: 'application' } })
    return call<{ intentVersion: Version; error?: { code: string } }>(`/api/work-items/${workItem.body!.workItem.id}/intent-versions`, { cookie, body: { ...(draftId ? { draftId } : {}), goal: draft.goal, constraints: draft.constraints, nonGoals: draft.nonGoals, examples: draft.examples, ...content } })
  }
  const unchanged = await submit(developer, { riskLevel: draft.riskLevel, acceptanceCriteria: draft.acceptanceCriteria }, draft.id)
  assert.equal(unchanged.status, 201, unchanged.text)
  assert.deepEqual(unchanged.body!.intentVersion.draft, { draftId: draft.id, providerId: 'fake', model: 'fake-drafter-1', changedFields: [], questions: modelDraft.questions }, 'the model\'s open questions travel with the version to the approver')
  assert.deepEqual(database.getIntentVersion(unchanged.body!.intentVersion.id).draft?.questions, modelDraft.questions, 'and are read back from the draft, not only returned once')
  const withoutDraft = await submit(developer, { riskLevel: draft.riskLevel, acceptanceCriteria: draft.acceptanceCriteria })
  assert.equal(withoutDraft.body!.intentVersion.draft, undefined)
  assert.equal(withoutDraft.body!.intentVersion.contentDigest.length, unchanged.body!.intentVersion.contentDigest.length)

  // The developer raises the risk and relabels a criterion; both are recorded as the developer's changes.
  const edited = await submit(developer, { riskLevel: 'medium', acceptanceCriteria: draft.acceptanceCriteria.map((criterion, index) => index === 1 ? { ...criterion, criticality: 'normal' } : criterion) }, draft.id)
  assert.equal(edited.status, 201, edited.text)
  assert.deepEqual(edited.body!.intentVersion.draft?.changedFields, ['riskLevel', 'acceptanceCriteria'])
  assert.equal(edited.body!.intentVersion.status, 'draft', 'a medium risk Intent still waits for approval')

  // The submitted Intent is validated as usual: a draft is no way past the gates.
  const highWithoutHumanOverHttp = await submit(developer, { riskLevel: 'high', acceptanceCriteria: draft.acceptanceCriteria.filter((criterion) => criterion.verificationType !== 'human') }, draft.id)
  assert.equal(highWithoutHumanOverHttp.body?.error?.code, 'high_risk_requires_human_verification')

  // A draft belongs to its author: another member cannot present it as the origin of their Intent.
  const foreign = await submit(owner, { riskLevel: draft.riskLevel, acceptanceCriteria: draft.acceptanceCriteria }, draft.id)
  assert.equal(foreign.body?.error?.code, 'intent_draft_foreign')
  assert.equal((await submit(developer, { riskLevel: 'low', acceptanceCriteria: draft.acceptanceCriteria }, 'intent-draft-missing')).body?.error?.code, 'intent_draft_not_found')

  // The form's "you changed …" note and the server's changedFields come from the same comparison.
  const draftForm = { goal: draft.goal, constraints: draft.constraints.join('\n'), nonGoals: draft.nonGoals.join('\n'), examples: formatIntentExamples(draft.examples), riskLevel: draft.riskLevel as IntentFormContent['riskLevel'], criteria: formatAcceptanceCriteria(draft.acceptanceCriteria as IntentFormContent['acceptanceCriteria']) }
  const draftContent = draft as unknown as IntentFormContent
  const formCases: Array<[string, Partial<typeof draftForm>]> = [
    ['as drafted', {}],
    ['whitespace and blank lines only', { goal: `  ${draft.goal}  `, constraints: `\n${draft.constraints.join('\n\n')}  \n` }],
    ['a repeated non-goal', { nonGoals: [...draft.nonGoals, ...draft.nonGoals].join('\n') }],
    ['the goal', { goal: `${draft.goal}，并记录校验失败次数` }],
    ['an example and the risk', { examples: `${draftForm.examples}\n输入：123\n期望：提示「身份证号应为 18 位」`, riskLevel: 'medium' }],
    ['a criterion made non-blocking', { criteria: formatAcceptanceCriteria(draft.acceptanceCriteria.map((criterion, index) => index === 0 ? { ...criterion, criticality: 'normal' } : criterion) as IntentFormContent['acceptanceCriteria']) }],
  ]
  for (const [label, edit] of formCases) {
    const content = intentFormContent({ ...draftForm, ...edit })
    const workItem = await call<{ workItem: { id: string } }>('/api/work-items', { cookie: developer, body: { projectId: 'PRJ-DEFAULT', title: brief.title, description: content.goal, productType: 'application' } })
    const submitted = await call<{ intentVersion: Version }>(`/api/work-items/${workItem.body!.workItem.id}/intent-versions`, { cookie: developer, body: { draftId: draft.id, ...content } })
    assert.equal(submitted.status, 201, `${label}: ${submitted.text}`)
    assert.deepEqual(draftChangedFields(draftContent, content), submitted.body!.intentVersion.draft?.changedFields, `${label}: the form and the server agree on what changed`)
  }

  // The draft row is append-only and its generation is on the project's event chain.
  assert.throws(() => (database as unknown as { db: { exec(sql: string): void } }).db.exec(`UPDATE intent_drafts SET model = 'other' WHERE id = '${draft.id}'`), /append-only/u)
  const events = await call<{ events: Array<{ eventType: string; payload: Record<string, unknown> }> }>('/api/events', { cookie: owner })
  const generated = events.body?.events?.find((event) => event.eventType === 'intent.draft_generated' && event.payload.draftId === draft.id)
  assert.ok(generated, `intent.draft_generated is recorded (${events.status})`)
  assert.equal(generated.payload.draftId, draft.id)
  assert.ok(!JSON.stringify(generated.payload).includes(brief.brief), 'the event carries the brief by digest only')

  console.log('intent draft smoke passed')
} finally {
  provider.close()
  rmSync(root, { recursive: true, force: true })
}
