import {
  DAY_MS,
  DEFAULT_RATE_LIMITS,
  MINUTE_MS,
  MONTH_MS,
  RateLimitExceededError,
  RateLimiter
} from '../src/rate-limiter'

/** Virtual clock: `sleep` advances time instead of waiting, so the suite stays instant. */
function clock(start = 1_000_000) {
  let current = start
  const sleeps: number[] = []
  return {
    now: () => current,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      current += ms
    },
    advance: (ms: number) => {
      current += ms
    },
    sleeps
  }
}

const limits = (overrides: Partial<typeof DEFAULT_RATE_LIMITS> = {}) => ({
  ...DEFAULT_RATE_LIMITS,
  ...overrides
})

describe('per-minute pacing', () => {
  it('lets the first burst through without waiting', async () => {
    const time = clock()
    const limiter = new RateLimiter(limits(), time)

    for (let i = 0; i < 4; i++) await limiter.acquire()

    expect(time.sleeps).toEqual([])
    expect(limiter.stats().requests).toBe(4)
  })

  it('holds the fifth request until the first leaves the window', async () => {
    const time = clock()
    const limiter = new RateLimiter(limits(), time)

    for (let i = 0; i < 4; i++) await limiter.acquire()
    time.advance(10_000) // 10s later
    await limiter.acquire()

    // The oldest request was 10s ago, so the window frees up 50s from now.
    expect(time.sleeps).toEqual([MINUTE_MS - 10_000])
    expect(limiter.stats().requests).toBe(5)
  })

  it('sustains exactly the configured rate over a long run', async () => {
    const time = clock()
    const limiter = new RateLimiter(limits({ perMinute: 4 }), time)
    const start = time.now()

    for (let i = 0; i < 20; i++) await limiter.acquire()

    // 20 requests at 4/min: the first 4 are free, the rest pace out over 4 more minutes.
    expect(time.now() - start).toBe(4 * MINUTE_MS)
  })

  it('treats 0 as unlimited', async () => {
    const time = clock()
    const limiter = new RateLimiter(limits({ perMinute: 0, perDay: 0, perMonth: 0 }), time)

    for (let i = 0; i < 100; i++) await limiter.acquire()

    expect(time.sleeps).toEqual([])
  })
})

describe('daily and monthly budgets', () => {
  it('paces against the daily window once it fills', async () => {
    const time = clock()
    const limiter = new RateLimiter(limits({ perMinute: 0, perDay: 3, maxWaitMs: DAY_MS }), time)

    for (let i = 0; i < 3; i++) await limiter.acquire()
    await limiter.acquire()

    expect(time.sleeps).toEqual([DAY_MS])
  })

  it('counts usage VirusTotal reports from earlier runs', async () => {
    const time = clock()
    const limiter = new RateLimiter(limits({ perMinute: 0, perDay: 500 }), time)
    limiter.seed({ day: 498 })

    await limiter.acquire()
    await limiter.acquire()

    expect(limiter.stats().remaining.day).toBe(0)
    await expect(limiter.acquire()).rejects.toThrow(RateLimitExceededError)
  })

  it('fails immediately when the budget was already spent before this run', async () => {
    const time = clock()
    const limiter = new RateLimiter(limits({ perMinute: 0, perDay: 500 }), time)
    limiter.seed({ day: 500 })

    // Waiting cannot help — nothing of ours is in the window to expire.
    await expect(limiter.acquire()).rejects.toThrow(/day quota is already exhausted \(500 of 500/)
    expect(time.sleeps).toEqual([])
  })

  it('ignores a missing or negative seed value', async () => {
    const time = clock()
    const limiter = new RateLimiter(limits({ perMinute: 0, perDay: 2 }), time)
    limiter.seed({ day: undefined, month: -1 })

    await limiter.acquire()
    expect(limiter.stats().remaining.day).toBe(1)
  })

  it('applies the monthly window over a rolling 30 days', async () => {
    const time = clock()
    const limiter = new RateLimiter(limits({ perMinute: 0, perDay: 0, perMonth: 2, maxWaitMs: MONTH_MS }), time)

    await limiter.acquire()
    await limiter.acquire()
    await limiter.acquire()

    expect(time.sleeps).toEqual([MONTH_MS])
  })
})

describe('the wait cap', () => {
  it('refuses to block longer than rate-limit-max-wait', async () => {
    const time = clock()
    const limiter = new RateLimiter(limits({ perMinute: 0, perDay: 1, maxWaitMs: 5 * MINUTE_MS }), time)

    await limiter.acquire()
    await expect(limiter.acquire()).rejects.toThrow(/would require waiting 86400s, beyond the 300s cap/)
  })

  it('waits when the pause fits inside the cap', async () => {
    const time = clock()
    const limiter = new RateLimiter(limits({ perMinute: 2, maxWaitMs: 5 * MINUTE_MS }), time)

    await limiter.acquire()
    await limiter.acquire()
    await limiter.acquire()

    expect(time.sleeps).toEqual([MINUTE_MS])
  })
})

describe('stats', () => {
  it('reports requests made, time waited and headroom left', async () => {
    const time = clock()
    const limiter = new RateLimiter(limits({ perMinute: 2, perDay: 10, perMonth: 100 }), time)

    await limiter.acquire()
    await limiter.acquire()
    await limiter.acquire() // waits a minute

    expect(limiter.stats()).toEqual({
      requests: 3,
      waitedMs: MINUTE_MS,
      // A minute has passed, so the first two requests have aged out of the minute window.
      remaining: { minute: 1, day: 7, month: 97 }
    })
  })
})
