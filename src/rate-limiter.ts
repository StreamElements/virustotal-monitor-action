import { Logger, silentLogger } from './logging'

/**
 * Client-side rate limiting for the VirusTotal API.
 *
 * VirusTotal enforces three budgets on a key — per minute, per day, per month — and answers
 * with HTTP 429 once one is crossed. Backing off after the fact still burns the request, so we
 * pace ourselves instead: `acquire()` blocks until making a call would stay inside every window.
 *
 * The honest caveat is that a CI run is short-lived and starts with an empty history, so the
 * day and month windows can only bound *this run* on their own. `seed()` fixes that by folding
 * in the usage VirusTotal itself reports for the key, which is what makes those two budgets
 * meaningful across runs.
 */

export const MINUTE_MS = 60_000
export const DAY_MS = 24 * 60 * MINUTE_MS
/** VirusTotal's monthly budget is a calendar month; a rolling 30 days is the safe approximation. */
export const MONTH_MS = 30 * DAY_MS

export interface RateLimitConfig {
  /** Requests per minute. 0 disables this window. */
  perMinute: number
  perDay: number
  perMonth: number
  /** Longest a single acquire may block before giving up. Prevents a job hanging for hours. */
  maxWaitMs: number
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  perMinute: 4,
  perDay: 500,
  perMonth: 15500,
  maxWaitMs: 5 * MINUTE_MS
}

export interface RateLimiterDeps {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  logger?: Logger
}

export class RateLimitExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RateLimitExceededError'
  }
}

interface Window {
  name: 'minute' | 'day' | 'month'
  spanMs: number
  limit: number
  /** Requests already spent before this run, per VirusTotal. Never applies to the minute window. */
  spent: number
}

export class RateLimiter {
  private readonly windows: Window[]
  private readonly maxWaitMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly logger: Logger
  /** Timestamps of requests made by this run, oldest first. */
  private history: number[] = []
  private waitedMs = 0

  constructor(config: RateLimitConfig, deps: RateLimiterDeps = {}) {
    const windows: Window[] = [
      { name: 'minute', spanMs: MINUTE_MS, limit: config.perMinute, spent: 0 },
      { name: 'day', spanMs: DAY_MS, limit: config.perDay, spent: 0 },
      { name: 'month', spanMs: MONTH_MS, limit: config.perMonth, spent: 0 }
    ]
    this.windows = windows.filter(window => window.limit > 0)
    this.maxWaitMs = config.maxWaitMs
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.logger = deps.logger ?? silentLogger
  }

  /** Folds in usage VirusTotal reports for the key, so day/month budgets survive across runs. */
  seed(used: { day?: number; month?: number }): void {
    for (const window of this.windows) {
      const value = window.name === 'day' ? used.day : window.name === 'month' ? used.month : undefined
      if (typeof value === 'number' && value >= 0) window.spent = value
    }
  }

  /** Blocks until a request may be made, then records it. */
  async acquire(): Promise<void> {
    for (;;) {
      const now = this.now()
      this.forget(now)

      const blocked = this.windows.filter(window => this.used(window, now) >= window.limit)
      if (blocked.length === 0) {
        this.history.push(now)
        return
      }

      let waitMs = 0
      for (const window of blocked) {
        const oldest = this.history.find(timestamp => timestamp > now - window.spanMs)
        if (oldest === undefined) {
          // Nothing of ours is in the window, so only VirusTotal's own count can be holding us
          // back — waiting cannot help within this job.
          throw new RateLimitExceededError(
            `VirusTotal's ${window.name} quota is already exhausted (${window.spent} of ${window.limit} ` +
              'used before this run). Wait for the quota to reset, or raise ' +
              `rate-limit-per-${window.name}.`
          )
        }
        waitMs = Math.max(waitMs, oldest + window.spanMs - now)
      }

      if (waitMs > this.maxWaitMs) {
        throw new RateLimitExceededError(
          `Rate limiting would require waiting ${Math.round(waitMs / 1000)}s, beyond the ` +
            `${Math.round(this.maxWaitMs / 1000)}s cap. Raise rate-limit-per-minute if the key allows ` +
            'a higher rate, or rate-limit-max-wait to allow a longer pause.'
        )
      }

      this.logger.debug(
        `Rate limit reached (${blocked.map(w => w.name).join(', ')}) — waiting ${Math.round(waitMs / 1000)}s`
      )
      this.waitedMs += waitMs
      await this.sleep(waitMs)
    }
  }

  /** Requests made by this run, and how long it spent waiting on the limiter. */
  stats(): { requests: number; waitedMs: number; remaining: Record<string, number> } {
    const now = this.now()
    const remaining: Record<string, number> = {}
    for (const window of this.windows) {
      remaining[window.name] = Math.max(0, window.limit - this.used(window, now))
    }
    return { requests: this.history.length, waitedMs: this.waitedMs, remaining }
  }

  private used(window: Window, now: number): number {
    const cutoff = now - window.spanMs
    let count = 0
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i] <= cutoff) break
      count++
    }
    return count + window.spent
  }

  /** Drops history older than the widest window so a long run does not grow unboundedly. */
  private forget(now: number): void {
    const widest = this.windows.reduce((max, window) => Math.max(max, window.spanMs), 0)
    const cutoff = now - widest
    let drop = 0
    while (drop < this.history.length && this.history[drop] <= cutoff) drop++
    if (drop > 0) this.history = this.history.slice(drop)
  }
}
