import type { BudgetDecision, RunBudget, RunUsage } from './contracts'

type LimitCheck = {
  label: string
  value: number
  limit?: number
}

export class RuntimeBudgetGuard {
  evaluate(budget: RunBudget, usage: RunUsage): BudgetDecision {
    const checks: LimitCheck[] = [
      { label: 'tokens', value: usage.inputTokens + usage.outputTokens, limit: budget.maxTokens },
      { label: 'tool calls', value: usage.toolCalls, limit: budget.maxToolCalls },
      { label: 'duration', value: usage.elapsedSeconds, limit: budget.maxDurationSeconds },
      { label: 'cost', value: usage.estimatedCostUsd, limit: budget.maxCostUsd },
    ]
    const exceeded = checks.filter((check) => check.limit !== undefined && check.value > check.limit)
    if (exceeded.length) return { status: 'exceeded', action: 'terminate', reasons: exceeded.map((check) => `${check.label} ${check.value} exceeds ${check.limit}`) }
    const warnings = checks.filter((check) => check.limit !== undefined && check.value / check.limit >= 0.8)
    if (warnings.length) return { status: 'warning', action: 'checkpoint', reasons: warnings.map((check) => `${check.label} reached ${Math.round((check.value / check.limit!) * 100)}%`) }
    return { status: 'within', action: 'continue', reasons: ['all runtime budgets within deterministic limits'] }
  }
}
