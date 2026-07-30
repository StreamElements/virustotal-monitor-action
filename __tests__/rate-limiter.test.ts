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

describe('the 429 penalty', () => {
  it('holds every later call for the penalty, even with headroom left', async () => {
    const time = clock()
    const limiter = new RateLimiter(limits({ perMinute: 100 }), time)

    await limiter.acquire()
    limiter.penalize(45_000)
    await limiter.acquire()

    expect(time.sleeps).toEqual([45_000])
  })

  it('keeps the longest penalty rather than letting a later one shorten it', async () => {
    const time = clock()
    const limiter = new RateLimiter(limits({ perMinute: 100 }), time)

    limiter.penalize(90_000)
    limiter.penalize(10_000)
    await limiter.acquire()

    expect(time.sleeps).toEqual([90_000])
  })

  it('serves calls normally again once the penalty has passed', async () => {
    const time = clock()
    const limiter = new RateLimiter(limits({ perMinute: 100 }), time)

    limiter.penalize(30_000)
    await limiter.acquire() // waits out the penalty
    await limiter.acquire() // free again

    expect(time.sleeps).toEqual([30_000])
  })

  it('refuses a penalty longer than the wait cap instead of stalling the job', async () => {
    const time = clock()
    const limiter = new RateLimiter(limits({ perMinute: 100, maxWaitMs: 60_000 }), time)

    limiter.penalize(10 * MINUTE_MS)

    await expect(limiter.acquire()).rejects.toThrow(
      /VirusTotal returned 429 and asked to wait 600s, beyond the 60s cap/
    )
  })

  it('counts penalty time as time waited', async () => {
    const time = clock()
    const limiter = new RateLimiter(limits({ perMinute: 100 }), time)

    limiter.penalize(20_000)
    await limiter.acquire()

    expect(limiter.stats().waitedMs).toBe(20_000)
  })
})

describe('how waits are reported', () => {
  function capturing() {
    const debug: string[] = []
    const info: string[] = []
    return { debug: (m: string) => debug.push(m), info: (m: string) => info.push(m), warning: () => undefined, lines: { debug, info } }
  }

  it('announces a noticeable pause at info level, with the reason and the fix', async () => {
    const time = clock()
    const logger = capturing()
    const limiter = new RateLimiter(limits({ perMinute: 1 }), { ...time, logger })

    await limiter.acquire()
    await limiter.acquire()

    expect(logger.lines.info).toHaveLength(1)
    expect(logger.lines.info[0]).toContain('Pausing 60s to stay within VirusTotal')
    expect(logger.lines.info[0]).toContain('1 request(s) per minute')
    expect(logger.lines.info[0]).toContain('Raise rate-limit-per-minute')
  })

  it('mentions quota already spent before the run, which is otherwise baffling', async () => {
    const time = clock()
    const logger = capturing()
    const limiter = new RateLimiter(limits({ perMinute: 0, perDay: 3, maxWaitMs: DAY_MS }), { ...time, logger })
    limiter.seed({ day: 2 })

    await limiter.acquire()
    await limiter.acquire()

    expect(logger.lines.info[0]).toContain('2 of them already used before this run')
  })

  it('keeps a sub-second pause in debug so a fast run stays quiet', async () => {
    const time = clock()
    const logger = capturing()
    const limiter = new RateLimiter(limits({ perMinute: 100 }), { ...time, logger })

    limiter.penalize(500)
    await limiter.acquire()

    expect(logger.lines.info).toEqual([])
    expect(logger.lines.debug).toHaveLength(1)
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
