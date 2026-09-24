import assert from 'node:assert/strict'
import { RuntimeBudgetGuard } from '../src/adapters/runtime-budget.ts'

const guard = new RuntimeBudgetGuard()
const budget = { maxTokens: 80_000, maxDurationSeconds: 1_800, maxToolCalls: 100, maxCostUsd: 8 }

assert.deepEqual(guard.evaluate(budget, { inputTokens: 20_000, outputTokens: 4_000, toolCalls: 20, elapsedSeconds: 300, estimatedCostUsd: 2.1 }), {
  status: 'within',
  action: 'continue',
  reasons: ['all runtime budgets within deterministic limits'],
})

const warning = guard.evaluate(budget, { inputTokens: 58_000, outputTokens: 7_000, toolCalls: 70, elapsedSeconds: 900, estimatedCostUsd: 5.4 })
assert.equal(warning.status, 'warning')
assert.equal(warning.action, 'checkpoint')
assert.ok(warning.reasons.some((reason) => reason.includes('tokens reached 81%')))

const exceeded = guard.evaluate(budget, { inputTokens: 72_000, outputTokens: 10_000, toolCalls: 101, elapsedSeconds: 1_900, estimatedCostUsd: 8.2 })
assert.equal(exceeded.status, 'exceeded')
assert.equal(exceeded.action, 'terminate')
assert.equal(exceeded.reasons.length, 4)

console.log('runtime budget guard smoke tests passed')
