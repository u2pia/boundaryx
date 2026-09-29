export type LoginProtectionOptions = {
  maxAccountFailures?: number
  maxSourceFailures?: number
  windowMs?: number
  blockMs?: number
  maxEntries?: number
}

type LoginAttempt = { failures: number; windowStartedAt: number; blockedUntil: number }

export class LoginThrottle {
  private readonly attempts = new Map<string, LoginAttempt>()
  readonly maxAccountFailures: number
  readonly maxSourceFailures: number
  private readonly windowMs: number
  private readonly blockMs: number
  private readonly maxEntries: number

  constructor(options: LoginProtectionOptions = {}) {
    this.maxAccountFailures = Math.max(1, Math.floor(options.maxAccountFailures ?? 5))
    this.maxSourceFailures = Math.max(1, Math.floor(options.maxSourceFailures ?? 50))
    this.windowMs = Math.max(1, Math.floor(options.windowMs ?? 15 * 60 * 1000))
    this.blockMs = Math.max(1, Math.floor(options.blockMs ?? 15 * 60 * 1000))
    this.maxEntries = Math.max(100, Math.floor(options.maxEntries ?? 5_000))
  }

  isBlocked(key: string, now = Date.now()) {
    const attempt = this.current(key, now)
    return Boolean(attempt && attempt.blockedUntil > now)
  }

  recordFailure(key: string, maximumFailures: number, now = Date.now()) {
    const attempt = this.current(key, now) ?? { failures: 0, windowStartedAt: now, blockedUntil: 0 }
    attempt.failures += 1
    if (attempt.failures >= maximumFailures) attempt.blockedUntil = now + this.blockMs
    this.attempts.delete(key)
    this.attempts.set(key, attempt)
    this.enforceLimit(now)
    return attempt.blockedUntil > now
  }

  clear(key: string) {
    this.attempts.delete(key)
  }

  private current(key: string, now: number) {
    const attempt = this.attempts.get(key)
    if (!attempt) return undefined
    if (attempt.blockedUntil <= now && now - attempt.windowStartedAt >= this.windowMs) {
      this.attempts.delete(key)
      return undefined
    }
    return attempt
  }

  private enforceLimit(now: number) {
    for (const [key, attempt] of this.attempts) {
      if (attempt.blockedUntil <= now && now - attempt.windowStartedAt >= this.windowMs) this.attempts.delete(key)
    }
    while (this.attempts.size > this.maxEntries) this.attempts.delete(this.attempts.keys().next().value as string)
  }
}
