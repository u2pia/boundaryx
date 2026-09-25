// Fills the default project with a worked example, produced by the real pipeline rather than written as rows: a small
// Git repository, Builder runs by a scripted agent (no model, no network), the checks the repository declares, the
// evidence packages, reviews and a merge. Everything the workbench shows for the demo is therefore something the
// platform actually did, and every gate applied to it.
//
//   npm run seed:demo            (reads CONTROL_PLANE_DATA_DIR / CONTROL_PLANE_DB like the server)
//
// It needs an owner (finish the first-run setup first) and does nothing when the default project already has work.
// The demo members it creates have random passwords nobody learns and are disabled once the example is recorded.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ControlPlaneDatabase, DEFAULT_PROJECT_ID } from '../server/database.ts'
import { LocalCommandAgentRunner } from '../server/local-command-agent-runner.ts'
import { LocalEvidenceStore } from '../server/local-evidence-store.ts'
import { LocalGitAuthority } from '../server/local-git-authority.ts'
import { LocalRunPostprocessor } from '../server/local-run-postprocessor.ts'
import type { Actor, TeamRole } from '../server/types.ts'

const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server')
const dataDirectory = resolve(process.env.CONTROL_PLANE_DATA_DIR ?? resolve(serverDirectory, '../.aperture'))
const databasePath = resolve(process.env.CONTROL_PLANE_DB ?? resolve(dataDirectory, 'control-plane.db'))
const demoRoot = join(dataDirectory, 'demo')
const repositoryPath = join(demoRoot, 'repository')
const agentScript = join(demoRoot, 'demo-agent.mjs')

/** What the scripted Builder writes for each work item, keyed by title. `stopped` makes it hand over a partial change. */
const scenarios: Record<string, { files: Record<string, string>; summary: string; stopped?: 'time_budget' }> = {
  '发票金额按分四舍五入': {
    summary: 'total() 改为按分四舍五入，并补充 0.005 边界用例。',
    files: {
      'src/invoice.mjs': "export function total(lines) {\n  const cents = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice * 100, 0)\n  return Math.round(cents) / 100\n}\n",
      'test/invoice.test.mjs': "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { total } from '../src/invoice.mjs'\n\ntest('sums the lines', () => assert.equal(total([{ quantity: 2, unitPrice: 3.5 }]), 7))\ntest('rounds to the cent', () => assert.equal(total([{ quantity: 1, unitPrice: 0.125 }, { quantity: 1, unitPrice: 0.2 }]), 0.33))\n",
    },
  },
  '支持按地区配置税率': {
    summary: '新增 taxFor(region, amount)，税率表放在 src/tax-rates.mjs，未知地区直接报错。',
    files: {
      'src/tax-rates.mjs': "export const taxRates = { CN: 0.13, SG: 0.09, DE: 0.19 }\n",
      'src/tax.mjs': "import { taxRates } from './tax-rates.mjs'\n\nexport function taxFor(region, amount) {\n  const rate = taxRates[region]\n  if (rate === undefined) throw new Error(`No tax rate for region ${region}`)\n  return Math.round(amount * rate * 100) / 100\n}\n",
      'test/tax.test.mjs': "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { taxFor } from '../src/tax.mjs'\n\ntest('applies the region rate', () => assert.equal(taxFor('CN', 100), 13))\ntest('refuses an unknown region', () => assert.throws(() => taxFor('XX', 100), /No tax rate/))\n",
    },
  },
  '导出发票 CSV': {
    summary: '新增 toCsv(lines)。',
    files: {
      // The Builder forgets to quote a field containing a comma; the test it wrote catches it and the check fails.
      'src/csv.mjs': "export function toCsv(lines) {\n  return ['description,quantity,unitPrice', ...lines.map((line) => `${line.description},${line.quantity},${line.unitPrice}`)].join('\\n')\n}\n",
      'test/csv.test.mjs': "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { toCsv } from '../src/csv.mjs'\n\ntest('quotes a description with a comma', () => assert.equal(toCsv([{ description: 'Pens, blue', quantity: 2, unitPrice: 1.5 }]).split('\\n')[1], '\"Pens, blue\",2,1.5'))\n",
    },
  },
  '发票折扣规则': {
    summary: '只完成了固定金额折扣；百分比折扣与叠加规则尚未实现。',
    stopped: 'time_budget',
    files: {
      'src/discount.mjs': "export function applyDiscount(amount, discount) {\n  if (discount.type === 'fixed') return Math.max(0, amount - discount.value)\n  throw new Error(`Discount type ${discount.type} is not implemented yet`)\n}\n",
      'test/discount.test.mjs': "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { applyDiscount } from '../src/discount.mjs'\n\ntest('fixed discount never goes below zero', () => assert.equal(applyDiscount(5, { type: 'fixed', value: 8 }), 0))\n",
    },
  },
}

function git(...args: string[]) {
  return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim()
}

function createRepository() {
  mkdirSync(repositoryPath, { recursive: true })
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repositoryPath])
  git('config', 'user.name', 'Aperture Demo')
  git('config', 'user.email', 'demo@aperture.invalid')
  mkdirSync(join(repositoryPath, 'src'))
  mkdirSync(join(repositoryPath, 'test'))
  mkdirSync(join(repositoryPath, '.aperture'))
  writeFileSync(join(repositoryPath, 'README.md'), '# 发票服务（演示仓库）\n\nAperture 默认项目的演示仓库。`npm test` 即 `node --test`。\n')
  writeFileSync(join(repositoryPath, 'src/invoice.mjs'), 'export function total(lines) {\n  return lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0)\n}\n')
  writeFileSync(join(repositoryPath, 'test/invoice.test.mjs'), "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { total } from '../src/invoice.mjs'\n\ntest('sums the lines', () => assert.equal(total([{ quantity: 2, unitPrice: 3.5 }]), 7))\n")
  writeFileSync(join(repositoryPath, '.aperture/project.json'), JSON.stringify({ schemaVersion: 'aperture.project.v1', productType: 'application', context: { required: ['README.md'], allowed: ['README.md', 'src/invoice.mjs'] }, checks: [{ name: 'node-tests', kind: 'test', command: [process.execPath, '--test'], timeoutMs: 60_000 }], testPaths: ['test'], policy: { maximumRisk: 'medium', allowUnisolatedRuntime: true } }, null, 2))
  git('add', '.')
  git('commit', '--quiet', '-m', 'Invoice service skeleton')
}

function writeAgent() {
  writeFileSync(agentScript, `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const scenarios = ${JSON.stringify(scenarios)}
const request = JSON.parse(readFileSync(process.env.APERTURE_RUN_REQUEST, 'utf8'))
const scenario = scenarios[request.workItem.title]
if (!scenario) { console.error('The demo agent has no script for ' + request.workItem.title); process.exit(1) }
for (const path of request.declaredContextPaths ?? []) { readFileSync(path, 'utf8'); console.log(JSON.stringify({ type: 'context_consumed', path })) }
for (const [path, content] of Object.entries(scenario.files)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
console.log(JSON.stringify({ type: 'message', summary: (scenario.stopped ? 'Stopped at the time budget: ' : '') + scenario.summary, ...(scenario.stopped ? { stopped: scenario.stopped } : {}) }))
`)
}

const database = new ControlPlaneDatabase(databasePath, resolve(serverDirectory, 'migrations'))
try {
  const owner = database.listActors().find((actor) => actor.role === 'owner' && actor.status === 'active')
  if (!owner) throw new Error('No owner yet: finish the first-run setup in the workbench, then seed the demo')
  if (database.getIdentityMode() === 'team') throw new Error('Team mode refuses password decisions, so the scripted demo members could not review; seed in local mode')
  if (database.listWorkItems([DEFAULT_PROJECT_ID]).length > 0) {
    console.log(`The default project already has work items; nothing seeded (${databasePath})`)
    process.exit(0)
  }
  if (existsSync(repositoryPath)) throw new Error(`${repositoryPath} exists but the default project is empty; remove it to seed again`)

  const member = (username: string, displayName: string, role: TeamRole): Actor => database.listActors().find((actor) => actor.username === username) ?? database.createActor({ username, displayName, role, password: randomBytes(24).toString('base64url') }, owner.id)
  const builder = member('demo-builder', '演示 · 开发者', 'developer')
  const reviewer = member('demo-reviewer', '演示 · 评审人', 'reviewer')
  const maintainer = member('demo-maintainer', '演示 · 维护者', 'maintainer')

  createRepository()
  writeAgent()
  database.updateProjectSettings(DEFAULT_PROJECT_ID, { repositoryPath, defaultBranch: 'main', description: '演示项目：内置发票服务示例仓库，数据由真实流水线生成，所有成员可见。' }, owner.id)
  const evidenceStore = new LocalEvidenceStore(join(dataDirectory, 'evidence'))
  const runner = new LocalCommandAgentRunner({ database, executable: process.execPath, args: [agentScript], worktreeRoot: join(demoRoot, 'runs'), timeoutMs: 120_000, postprocessor: new LocalRunPostprocessor({ database, evidenceStore }) })
  const authority = new LocalGitAuthority(database)

  const plan = (title: string, description: string, goal: string, criteria: string[]) => {
    const workItem = database.createWorkItem({ projectId: DEFAULT_PROJECT_ID, title, description, productType: 'application', ownerActorId: builder.id }, builder.id)
    const intent = database.createIntentVersion({ workItemId: workItem.id, goal, constraints: ['只改 src/ 与 test/', '保持 node --test 通过'], riskLevel: 'medium', acceptanceCriteria: criteria.map((statement) => ({ statement, criticality: 'critical' as const, verificationType: 'deterministic' as const })) }, builder.id)
    return { workItem, intent }
  }
  const build = (item: ReturnType<typeof plan>) => {
    database.approveIntentVersion(item.intent.id, reviewer.id, '目标与验收标准清楚，可以开工。')
    const run = runner.run({ workItemId: item.workItem.id, intentVersionId: item.intent.id, baseRef: 'main', declaredContextPaths: ['src/invoice.mjs'] }, builder.id)
    if (!run.changeProposalId) throw new Error(`Demo run ${run.id} produced no change proposal: ${run.errorMessage ?? run.status}`)
    return { run, proposal: database.getChangeProposal(run.changeProposalId) }
  }
  const approve = (proposalId: string, comment: string) => {
    const readiness = database.getReviewReadiness(proposalId)
    for (const evidence of readiness.evidence) database.recordEvidenceView(evidence.id, reviewer.id, evidence.sha256)
    database.recordReview({ proposalId, headSha: database.getChangeProposal(proposalId).headSha, reviewerActorId: reviewer.id, decision: 'approved', comment })
  }

  // 1. The whole way through: approved intent, run, passing checks, evidence viewed, approved, merged.
  const rounding = build(plan('发票金额按分四舍五入', '0.1 + 0.2 这类浮点误差会让发票合计多出或少掉一分钱。', '发票合计按分四舍五入，消除浮点误差', ['合计按分四舍五入', '已有合计用例保持通过']))
  approve(rounding.proposal.id, '看过证据包：node-tests 通过，边界用例覆盖 0.005。')
  authority.mergeChangeProposal(rounding.proposal.id, maintainer.id)

  // 2. Ready and waiting: a real member reviews it.
  const tax = build(plan('支持按地区配置税率', '不同地区税率不同，目前税额写死在调用方。', '按地区查税率计算税额，未知地区明确报错', ['按地区税率计算税额', '未知地区报错而不是按 0 计算']))

  // 3. Blocked: the Builder's own test fails, so nobody can approve it until a new revision fixes it.
  build(plan('导出发票 CSV', '财务需要把发票明细导出为 CSV。', '把发票明细导出为 CSV，字段中的逗号要正确转义', ['导出表头与明细行', '包含逗号的字段加引号']))

  // 4. Partial: the Builder ran out of time; approving it takes a written acknowledgement.
  build(plan('发票折扣规则', '支持固定金额与百分比两种折扣。', '实现固定金额与百分比折扣，折后金额不低于 0', ['固定金额折扣', '百分比折扣', '折后金额不低于 0']))

  // 5. Not started: the intent waits for someone other than its author to approve it.
  plan('退款单关联原发票', '退款需要追溯到原发票，目前只记录金额。', '退款单必须关联一张已开具的原发票', ['退款单保存原发票号', '原发票不存在时拒绝创建退款单'])

  for (const actor of [builder, reviewer, maintainer]) database.updateActor(actor.id, { status: 'disabled' }, owner.id)
  console.log(`demo seeded into ${DEFAULT_PROJECT_ID} · repository ${repositoryPath} · merged ${rounding.proposal.id} · awaiting review ${tax.proposal.id} · ${database.listWorkItems([DEFAULT_PROJECT_ID]).length} work items`)
} finally {
  database.close()
}
