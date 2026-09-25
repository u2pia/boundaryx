// The runner kills the Builder at APERTURE_RUN_DEADLINE (epoch ms), and a killed run throws away every change the
// agent made. A wrapper around an agent CLI cannot ask the CLI to wrap up, so it stops the CLI itself shortly before
// that moment and hands over the worktree as it is, marked as partial.

/** Milliseconds the wrapped CLI may run, or undefined when the runner set no deadline. */
export function cliTimeoutMs(now = Date.now()) {
  const deadline = Number(process.env.APERTURE_RUN_DEADLINE)
  if (!(deadline > now)) return undefined
  const budgetMs = deadline - now
  // Enough to write the summary, exit, and let the runner collect the output before it would kill this process.
  return Math.max(1, budgetMs - Math.min(30_000, Math.floor(budgetMs * 0.1)))
}

/** True when a spawnSync result ended because `cliTimeoutMs` ran out. */
export function stoppedAtDeadline(result) {
  return result.error?.code === 'ETIMEDOUT'
}

/** The protocol message for a change the Builder did not finish; the runner records `stopped` and review requires an acknowledgement. */
export function partialMessage(engine, detail) {
  return JSON.stringify({ type: 'message', summary: `Stopped at the time budget: ${engine} was stopped before it finished, so the change is partial: review it against every acceptance criterion.${detail ? ` ${detail}` : ''}`.slice(0, 1000), stopped: 'time_budget' })
}
