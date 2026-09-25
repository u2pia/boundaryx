import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ControlPlaneDatabase, DEFAULT_PROJECT_ID } from '../server/database.ts'

// The demo is only worth showing if the pipeline really produced it, so this seeds a fresh install and checks that
// every gate left the example where the story says: one merged, one to review, one blocked, one partial, one unapproved.
const root = mkdtempSync(join(tmpdir(), 'aperture-seed-demo-'))
const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const migrationDirectory = resolve(scriptsDirectory, '../server/migrations')
const seed = () => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', resolve(scriptsDirectory, 'seed-demo.ts')], { encoding: 'utf8', env: { ...process.env, CONTROL_PLANE_DATA_DIR: root } })

try {
  assert.match(seed().stderr, /No owner yet/u, 'nothing is seeded before the first-run setup')
  const setup = new ControlPlaneDatabase(join(root, 'control-plane.db'), migrationDirectory)
  setup.createActor({ username: 'owner', displayName: 'Owner', role: 'owner', password: 'owner-password-2026' })
  const reviewer = setup.createActor({ username: 'reviewer', displayName: 'Reviewer', role: 'reviewer', password: 'reviewer-password-2026' })
  setup.close()

  const first = seed()
  assert.equal(first.status, 0, first.stderr)
  const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), migrationDirectory)
  try {
    const workItems = database.listWorkItems([DEFAULT_PROJECT_ID])
    assert.equal(workItems.length, 5)
    const byTitle = (title: string) => workItems.find((workItem) => workItem.title === title)!
    const proposalOf = (title: string) => database.getChangeProposal(database.listAgentRuns().find((run) => run.workItemId === byTitle(title).id)!.changeProposalId!)
    assert.equal(byTitle('发票金额按分四舍五入').status, 'done')
    assert.equal(proposalOf('发票金额按分四舍五入').status, 'merged')
    assert.equal(database.getReviewReadiness(proposalOf('支持按地区配置税率').id).status, 'ready')
    assert.equal(database.getReviewReadiness(proposalOf('导出发票 CSV').id).status, 'blocked')
    assert.equal(database.getReviewReadiness(proposalOf('发票折扣规则').id).builderStop?.reason, 'time_budget')
    assert.equal(database.listAgentRuns().some((run) => run.workItemId === byTitle('退款单关联原发票').id), false)
    // Critical criteria are proved by the base revision's tests re-run under the Builder's code, not by its own tests.
    assert.equal(database.getReviewReadiness(proposalOf('支持按地区配置税率').id).checks.some((check) => check.name === 'node-tests@baseline' && check.conclusion === 'success'), true)
    assert.equal(database.listAgentRuns().every((run) => database.verifyAggregateEventChain('agent_run', run.id)), true)
    assert.deepEqual(database.listActors().filter((actor) => actor.username.startsWith('demo-')).map((actor) => actor.status), ['disabled', 'disabled', 'disabled'], 'nobody can sign in as a demo member')
    // A real member can take the waiting review: everyone is in the default project.
    assert.equal(database.projectRole(reviewer.id, DEFAULT_PROJECT_ID), 'reviewer')
  } finally {
    database.close()
  }

  const second = seed()
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /already has work items; nothing seeded/u)
  console.log('seed demo smoke passed · 5 work items from real runs · merged, awaiting review, blocked, partial, unapproved · demo members disabled · second seed is a no-op')
} finally {
  rmSync(root, { recursive: true, force: true })
}
