import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import {
  DIRECT_UPLOAD_LIMIT_BYTES,
  MonitorApiError,
  MonitorClient,
  formatHeaders,
  parseRetryAfter
} from '../src/vt-client'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function fakeTransport(
  responses: Array<{ statusCode: number; payload?: unknown; raw?: string; headers?: Record<string, string> }>
) {
  const calls: Call[] = []
  let index = 0

  const requestFn = (async (url: string, options: Record<string, unknown>) => {
    const body = options.body as Readable | undefined
    let bodyText: string | undefined
    if (body) {
      const chunks: Buffer[] = []
      for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer))
      bodyText = Buffer.concat(chunks).toString('utf8')
    }
    calls.push({
      url,
      method: options.method as string,
      headers: options.headers as Record<string, string>,
      body: bodyText
    })

    const response = responses[Math.min(index, responses.length - 1)]
    index++
    const text = response.raw ?? JSON.stringify(response.payload ?? {})
    return { statusCode: response.statusCode, headers: response.headers ?? {}, body: { text: async () => text } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  return { calls, requestFn }
}

function client(requestFn: unknown): MonitorClient {
  return new MonitorClient({
    apiKey: 'test-key',
    apiUrl: 'https://vt.test/api/v3',
    requestFn: requestFn as never,
    sleepFn: async () => undefined,
    retryBaseMs: 0
  })
}

const item = (path: string, extra: Record<string, unknown> = {}) => ({
  id: `id:${path}`,
  type: 'monitor_item',
  attributes: { path, item_type: 'file', size: 10, sha256: 'abc', creation_date: 1, ...extra }
})

describe('listFolder', () => {
  it('sends the path filter and follows the cursor until it is exhausted', async () => {
    const { calls, requestFn } = fakeTransport([
      { statusCode: 200, payload: { data: [item('/a/one.exe')], meta: { cursor: 'CURSOR1' } } },
      { statusCode: 200, payload: { data: [item('/a/two.exe')] } }
    ])

    const items = await client(requestFn).listFolder('/a')

    expect(items.map(i => i.path)).toEqual(['/a/one.exe', '/a/two.exe'])
    expect(calls).toHaveLength(2)
    expect(decodeURIComponent(calls[0].url)).toContain('filter=path:/a/')
    expect(calls[0].headers['x-apikey']).toBe('test-key')
    expect(decodeURIComponent(calls[1].url)).toContain('cursor=CURSOR1')
  })

  it('classifies folders and files', async () => {
    const { requestFn } = fakeTransport([
      {
        statusCode: 200,
        payload: {
          data: [item('/a/20260729000746', { item_type: 'folder' }), item('/a/loose.exe')]
        }
      }
    ])

    const items = await client(requestFn).listFolder('/a')
    expect(items.map(i => i.itemType)).toEqual(['folder', 'file'])
  })
})

describe('walk', () => {
  it('descends into sub-folders', async () => {
    const { calls, requestFn } = fakeTransport([
      { statusCode: 200, payload: { data: [item('/root/v1', { item_type: 'folder' })] } },
      { statusCode: 200, payload: { data: [item('/root/v1/setup.exe')] } },
      { statusCode: 200, payload: { data: [] } }
    ])

    const items = await client(requestFn).walk('/root')

    expect(items.map(i => i.path)).toEqual(['/root/v1', '/root/v1/setup.exe'])
    expect(calls).toHaveLength(2)
  })
})

describe('error handling', () => {
  it('retries throttling and server errors, then succeeds', async () => {
    const { calls, requestFn } = fakeTransport([
      { statusCode: 429, payload: { error: { code: 'QuotaExceededError', message: 'slow down' } } },
      { statusCode: 503, raw: '<html>gateway</html>' },
      { statusCode: 200, payload: { data: [] } }
    ])

    await expect(client(requestFn).listFolder('/a')).resolves.toEqual([])
    expect(calls).toHaveLength(3)
  })

  it('does not retry a client error and surfaces the VirusTotal error code', async () => {
    const { calls, requestFn } = fakeTransport([
      { statusCode: 404, payload: { error: { code: 'NotFoundError', message: 'no such folder' } } }
    ])

    await expect(client(requestFn).listFolder('/missing')).rejects.toThrow(/NotFoundError.*no such folder/)
    await expect(client(requestFn).listFolder('/missing')).rejects.toBeInstanceOf(MonitorApiError)
    expect(calls).toHaveLength(2) // one call per attempt above, no retries
  })

  it('gives up after the retry budget', async () => {
    const { calls, requestFn } = fakeTransport([{ statusCode: 500, payload: { error: { message: 'boom' } } }])
    await expect(client(requestFn).listFolder('/a')).rejects.toThrow(/HTTP 500/)
    expect(calls).toHaveLength(5) // initial attempt + 4 retries
  })
})

describe('uploadFile', () => {
  let localPath: string

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-upload-'))
    localPath = join(dir, 'obs-streamelements-setup-20260729000746.exe')
    await writeFile(localPath, 'binary-content')
  })

  it('posts multipart with the target path for a new item', async () => {
    const { calls, requestFn } = fakeTransport([{ statusCode: 200, payload: { data: { id: 'new-id' } } }])

    const id = await client(requestFn).uploadFile({
      localPath,
      remotePath: '/obs-streamelements/windows/20260729000746/setup.exe',
      size: 14
    })

    expect(id).toBe('new-id')
    expect(calls[0].url).toBe('https://vt.test/api/v3/monitor/items')
    expect(calls[0].headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(calls[0].body).toContain('name="path"')
    expect(calls[0].body).toContain('/obs-streamelements/windows/20260729000746/setup.exe')
    expect(calls[0].body).toContain('filename="setup.exe"')
    expect(calls[0].body).toContain('binary-content')
  })

  it('sends the item id instead of a path when overwriting', async () => {
    const { calls, requestFn } = fakeTransport([{ statusCode: 200, payload: { data: { id: 'same-id' } } }])

    await client(requestFn).uploadFile({
      localPath,
      remotePath: '/a/setup.exe',
      size: 14,
      existingItemId: 'same-id'
    })

    expect(calls[0].body).toContain('name="item"')
    expect(calls[0].body).toContain('same-id')
    expect(calls[0].body).not.toContain('name="path"')
  })

  it('requests a dedicated upload URL for files at or above the 32 MB limit', async () => {
    const { calls, requestFn } = fakeTransport([
      { statusCode: 200, payload: { data: 'http://www.virustotal.com/_ah/upload/TOKEN/' } },
      { statusCode: 200, payload: { data: { id: 'big-id' } } }
    ])

    const id = await client(requestFn).uploadFile({
      localPath,
      remotePath: '/a/big.exe',
      size: DIRECT_UPLOAD_LIMIT_BYTES
    })

    expect(id).toBe('big-id')
    expect(calls[0].url).toBe('https://vt.test/api/v3/monitor/items/upload_url')
    // Upgraded to https so the key and the binary never travel in the clear.
    expect(calls[1].url).toBe('https://www.virustotal.com/_ah/upload/TOKEN/')
  })
})

describe('uploads that get rate limited', () => {
  let localPath: string

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-429-'))
    localPath = join(dir, 'setup.exe')
    await writeFile(localPath, 'installer')
  })

  function uploader(responses: Parameters<typeof fakeTransport>[0], slept: number[] = []) {
    const transport = fakeTransport(responses)
    const client = new MonitorClient({
      apiKey: 'test-key',
      apiUrl: 'https://vt.test/api/v3',
      requestFn: transport.requestFn as never,
      sleepFn: async ms => {
        slept.push(ms)
      }
    })
    return { ...transport, client, slept }
  }

  it('re-sends a small upload after waiting out the 429', async () => {
    const { calls, client, slept } = uploader([
      { statusCode: 429, headers: { 'retry-after': '20' }, payload: { error: { message: 'slow down' } } },
      { statusCode: 200, payload: { data: { id: 'after-retry' } } }
    ])

    const id = await client.uploadFile({ localPath, remotePath: '/a/setup.exe', size: 9 })

    expect(id).toBe('after-retry')
    expect(slept).toEqual([20_000])
    expect(calls).toHaveLength(2)
    // The body is rebuilt for the retry rather than being a consumed stream.
    expect(calls[1].body).toContain('installer')
  })

  it('fetches a fresh upload URL for every large-file attempt', async () => {
    // Upload URLs are single-use, so retrying against the first one would fail on the URL.
    const { calls, client } = uploader([
      { statusCode: 200, payload: { data: 'https://vt.test/_ah/upload/FIRST/' } },
      { statusCode: 429, payload: { error: { message: 'slow down' } } },
      { statusCode: 200, payload: { data: 'https://vt.test/_ah/upload/SECOND/' } },
      { statusCode: 200, payload: { data: { id: 'big-id' } } }
    ])

    const id = await client.uploadFile({
      localPath,
      remotePath: '/a/big.exe',
      size: DIRECT_UPLOAD_LIMIT_BYTES
    })

    expect(id).toBe('big-id')
    expect(calls.map(call => call.url)).toEqual([
      'https://vt.test/api/v3/monitor/items/upload_url',
      'https://vt.test/_ah/upload/FIRST/',
      'https://vt.test/api/v3/monitor/items/upload_url',
      'https://vt.test/_ah/upload/SECOND/'
    ])
  })

  it('stops waiting when a QuotaExceededError is really Monitor storage', async () => {
    // QuotaExceededError covers request quotas *and* running out of Monitor disk or files.
    // Healthy request quotas mean waiting cannot help, so it fails with the real cause.
    const { client, calls, slept } = uploader([
      { statusCode: 429, payload: { error: { code: 'QuotaExceededError', message: 'quota exceeded' } } },
      { statusCode: 429, payload: { error: { code: 'QuotaExceededError', message: 'quota exceeded' } } },
      {
        statusCode: 200,
        payload: {
          data: {
            api_requests_daily: { used: 137, allowed: 500 },
            api_requests_monthly: { used: 4021, allowed: 15500 }
          }
        }
      }
    ])

    await expect(client.uploadFile({ localPath, remotePath: '/a/setup.exe', size: 9 })).rejects.toThrow(
      /most likely Monitor storage.*out of disk space or out of files/s
    )
    // One full window waited (a genuine per-minute overage would have cleared), then it stops
    // instead of burning the remaining three retries re-sending the file.
    expect(slept).toEqual([60_000])
    expect(calls[calls.length - 1].url).toContain('/overall_quotas')
  })

  it('reports the quota figures that led it to blame storage', async () => {
    const { client } = uploader([
      { statusCode: 429, payload: { error: { code: 'QuotaExceededError' } } },
      { statusCode: 429, payload: { error: { code: 'QuotaExceededError' } } },
      {
        statusCode: 200,
        payload: {
          data: {
            api_requests_daily: { used: 137, allowed: 500 },
            api_requests_monthly: { used: 4021, allowed: 15500 }
          }
        }
      }
    ])

    await expect(client.uploadFile({ localPath, remotePath: '/a/setup.exe', size: 9 })).rejects.toThrow(
      /daily 137\/500, monthly 4021\/15500/
    )
  })

  it('keeps waiting when the daily quota really is spent', async () => {
    const { client, slept } = uploader([
      { statusCode: 429, payload: { error: { code: 'QuotaExceededError' } } },
      { statusCode: 429, payload: { error: { code: 'QuotaExceededError' } } },
      {
        statusCode: 200,
        payload: {
          data: {
            api_requests_daily: { used: 500, allowed: 500 },
            api_requests_monthly: { used: 4021, allowed: 15500 }
          }
        }
      },
      { statusCode: 200, payload: { data: { id: 'eventually' } } }
    ])

    await expect(client.uploadFile({ localPath, remotePath: '/a/setup.exe', size: 9 })).resolves.toBe('eventually')
    expect(slept.length).toBeGreaterThan(1)
  })

  it('treats unreadable quotas as inconclusive and keeps retrying', async () => {
    const { client } = uploader([
      { statusCode: 429, payload: { error: { code: 'QuotaExceededError' } } },
      { statusCode: 429, payload: { error: { code: 'QuotaExceededError' } } },
      { statusCode: 403, payload: { error: { code: 'ForbiddenError', message: 'no quota access' } } },
      { statusCode: 200, payload: { data: { id: 'eventually' } } }
    ])

    await expect(client.uploadFile({ localPath, remotePath: '/a/setup.exe', size: 9 })).resolves.toBe('eventually')
  })

  it('does not blame storage for a plain TooManyRequestsError', async () => {
    // That code is unambiguously about request rate, so waiting is the right response.
    const { client } = uploader([
      { statusCode: 429, payload: { error: { code: 'TooManyRequestsError' } } },
      { statusCode: 429, payload: { error: { code: 'TooManyRequestsError' } } },
      { statusCode: 200, payload: { data: { id: 'eventually' } } }
    ])

    await expect(client.uploadFile({ localPath, remotePath: '/a/setup.exe', size: 9 })).resolves.toBe('eventually')
  })

  it('leaves the upload URL alone when the API itself is plain http', async () => {
    // Only reachable in tests; a real api-url is https, where the upgrade above still applies.
    const transport = fakeTransport([
      { statusCode: 200, payload: { data: 'http://127.0.0.1:8080/_ah/upload/TOKEN/' } },
      { statusCode: 200, payload: { data: { id: 'local-id' } } }
    ])
    const local = new MonitorClient({
      apiKey: 'k',
      apiUrl: 'http://127.0.0.1:8080/api/v3',
      requestFn: transport.requestFn as never,
      sleepFn: async () => undefined
    })

    await local.uploadFile({ localPath, remotePath: '/a/big.exe', size: DIRECT_UPLOAD_LIMIT_BYTES })

    expect(transport.calls[1].url).toBe('http://127.0.0.1:8080/_ah/upload/TOKEN/')
  })

  it('gives up with the rate-limit error after exhausting retries', async () => {
    // Every response is a 429, including the quota lookup, so the request quotas read as
    // unhealthy and the run keeps treating this as rate limiting.
    const { client, slept } = uploader([{ statusCode: 429, payload: { error: { code: 'QuotaExceededError' } } }])

    await expect(client.uploadFile({ localPath, remotePath: '/a/setup.exe', size: 9 })).rejects.toThrow(
      /HTTP 429.*QuotaExceededError/
    )
    // Four retries, each waiting a full window rather than a doubling millisecond delay. The
    // diagnostic lookup adds none: it is issued with retries disabled.
    expect(slept).toEqual([60_000, 60_000, 60_000, 60_000])
  })
})

describe('deleteItem', () => {
  it('url-encodes the base64 item id', async () => {
    const { calls, requestFn } = fakeTransport([{ statusCode: 200, payload: {} }])
    await client(requestFn).deleteItem('bW9uaXRvcg==/plus+slash')
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toBe('https://vt.test/api/v3/monitor/items/bW9uaXRvcg%3D%3D%2Fplus%2Bslash')
  })
})

describe('rate limiting', () => {
  it('acquires a slot before every request, including each paginated page', async () => {
    const acquire = jest.fn().mockResolvedValue(undefined)
    const { requestFn } = fakeTransport([
      { statusCode: 200, payload: { data: [item('/a/one.exe')], meta: { cursor: 'C' } } },
      { statusCode: 200, payload: { data: [item('/a/two.exe')] } }
    ])

    const paced = new MonitorClient({
      apiKey: 'k',
      apiUrl: 'https://vt.test/api/v3',
      requestFn: requestFn as never,
      sleepFn: async () => undefined,
      retryBaseMs: 0,
      rateLimiter: { acquire }
    })
    await paced.listFolder('/a')

    expect(acquire).toHaveBeenCalledTimes(2)
  })

  it('also paces retries, since a retry spends quota too', async () => {
    const acquire = jest.fn().mockResolvedValue(undefined)
    const { requestFn } = fakeTransport([
      { statusCode: 429, payload: { error: { code: 'QuotaExceededError', message: 'slow down' } } },
      { statusCode: 200, payload: { data: [] } }
    ])

    const paced = new MonitorClient({
      apiKey: 'k',
      apiUrl: 'https://vt.test/api/v3',
      requestFn: requestFn as never,
      sleepFn: async () => undefined,
      retryBaseMs: 0,
      rateLimiter: { acquire }
    })
    await paced.listFolder('/a')

    expect(acquire).toHaveBeenCalledTimes(2)
  })

  it('waits for the Retry-After VirusTotal asks for instead of its own backoff', async () => {
    const slept: number[] = []
    const { requestFn } = fakeTransport([
      { statusCode: 429, headers: { 'retry-after': '42' }, payload: { error: { message: 'slow down' } } },
      { statusCode: 200, payload: { data: [] } }
    ])

    const paced = new MonitorClient({
      apiKey: 'k',
      apiUrl: 'https://vt.test/api/v3',
      requestFn: requestFn as never,
      sleepFn: async ms => {
        slept.push(ms)
      },
      retryBaseMs: 1000
    })
    await paced.listFolder('/a')

    expect(slept).toEqual([42_000])
  })

  it('waits a full window after a 429 with no Retry-After, not a 1s exponential step', async () => {
    const slept: number[] = []
    const { requestFn } = fakeTransport([
      { statusCode: 429, payload: { error: { message: 'slow down' } } },
      { statusCode: 200, payload: { data: [] } }
    ])

    const paced = new MonitorClient({
      apiKey: 'k',
      apiUrl: 'https://vt.test/api/v3',
      requestFn: requestFn as never,
      sleepFn: async ms => {
        slept.push(ms)
      },
      retryBaseMs: 1000
    })
    await paced.listFolder('/a')

    // The smallest VirusTotal window is a minute, so anything shorter cannot clear a 429.
    expect(slept).toEqual([60_000])
  })

  it('still uses exponential backoff for retryable errors that are not rate limits', async () => {
    const slept: number[] = []
    const { requestFn } = fakeTransport([
      { statusCode: 503, raw: 'gateway' },
      { statusCode: 503, raw: 'gateway' },
      { statusCode: 200, payload: { data: [] } }
    ])

    const paced = new MonitorClient({
      apiKey: 'k',
      apiUrl: 'https://vt.test/api/v3',
      requestFn: requestFn as never,
      sleepFn: async ms => {
        slept.push(ms)
      },
      retryBaseMs: 1000
    })
    await paced.listFolder('/a')

    expect(slept).toEqual([1000, 2000])
  })

  it('tells the limiter to hold everything else back after a 429', async () => {
    const penalize = jest.fn()
    const { requestFn } = fakeTransport([
      { statusCode: 429, headers: { 'retry-after': '90' }, payload: { error: { message: 'slow down' } } },
      { statusCode: 200, payload: { data: [] } }
    ])

    const paced = new MonitorClient({
      apiKey: 'k',
      apiUrl: 'https://vt.test/api/v3',
      requestFn: requestFn as never,
      sleepFn: async () => undefined,
      rateLimiter: { acquire: jest.fn().mockResolvedValue(undefined), penalize }
    })
    await paced.listFolder('/a')

    expect(penalize).toHaveBeenCalledWith(90_000)
  })
})

describe('verbose logging', () => {
  function capturing() {
    const debug: string[] = []
    const info: string[] = []
    return { debug: (m: string) => debug.push(m), info: (m: string) => info.push(m), warning: () => undefined, lines: { debug, info } }
  }

  it('logs the request, the response and its headers at debug level', async () => {
    const log = capturing()
    const { requestFn } = fakeTransport([
      {
        statusCode: 200,
        headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '17' },
        payload: { data: [] }
      }
    ])

    await new MonitorClient({
      apiKey: 'test-key',
      apiUrl: 'https://vt.test/api/v3',
      requestFn: requestFn as never,
      logger: log
    }).listFolder('/a')

    const debugged = log.lines.debug.join('\n')
    expect(debugged).toMatch(/→ GET https:\/\/vt\.test\/api\/v3\/monitor\/items\?/)
    expect(debugged).toMatch(/← 200 in \d+ms, \d+ byte\(s\) of body/)
    expect(debugged).toContain('headers: content-type=application/json x-ratelimit-remaining=17')
  })

  it('logs the response body', async () => {
    const log = capturing()
    const { requestFn } = fakeTransport([{ statusCode: 200, payload: { data: [item('/a/one.exe')] } }])

    await new MonitorClient({
      apiKey: 'k',
      apiUrl: 'https://vt.test/api/v3',
      requestFn: requestFn as never,
      logger: log
    }).listFolder('/a')

    const body = log.lines.debug.find(line => line.startsWith('  body:'))
    expect(body).toContain('"path":"/a/one.exe"')
  })

  it('truncates a large body rather than flooding the log', async () => {
    const log = capturing()
    const { requestFn } = fakeTransport([
      { statusCode: 200, raw: JSON.stringify({ data: [], note: 'x'.repeat(500) }) }
    ])

    await new MonitorClient({
      apiKey: 'k',
      apiUrl: 'https://vt.test/api/v3',
      requestFn: requestFn as never,
      logger: log,
      bodyLogLimit: 100
    }).listFolder('/a')

    const body = log.lines.debug.find(line => line.startsWith('  body:')) as string
    expect(body).toMatch(/… \(\d+ more character\(s\) omitted\)$/)
    expect(body.length).toBeLessThan(200)
  })

  it('collapses newlines and marks an empty body', async () => {
    const log = capturing()
    const { requestFn } = fakeTransport([{ statusCode: 200, raw: '' }])

    await new MonitorClient({
      apiKey: 'k',
      apiUrl: 'https://vt.test/api/v3',
      requestFn: requestFn as never,
      logger: log
    }).deleteItem('id')

    expect(log.lines.debug).toContain('  body: (empty)')
  })

  it('redacts the key from a body that echoes it back', async () => {
    // A VirusTotal user object can carry the key, so a raw body dump would leak it.
    const log = capturing()
    const { requestFn } = fakeTransport([
      { statusCode: 200, raw: JSON.stringify({ data: { id: 'super-secret-key' } }) }
    ])

    await new MonitorClient({
      apiKey: 'super-secret-key',
      apiUrl: 'https://vt.test/api/v3',
      requestFn: requestFn as never,
      logger: log
    }).getApiQuotas()

    const logged = [...log.lines.debug, ...log.lines.info].join('\n')
    expect(logged).toContain('"id":"***"')
    expect(logged).not.toContain('super-secret-key')
  })

  it('redacts the api key from the quota URL, which carries it in the path', async () => {
    const log = capturing()
    const { requestFn } = fakeTransport([{ statusCode: 200, payload: { data: {} } }])

    await new MonitorClient({
      apiKey: 'super-secret-key',
      apiUrl: 'https://vt.test/api/v3',
      requestFn: requestFn as never,
      logger: log
    }).getApiQuotas()

    const logged = [...log.lines.debug, ...log.lines.info].join('\n')
    expect(logged).not.toContain('super-secret-key')
    expect(logged).toContain('/users/***/overall_quotas')
  })

  it('keeps the key out of error messages too, which surface in job output', async () => {
    const log = capturing()
    const { requestFn } = fakeTransport([
      { statusCode: 404, payload: { error: { code: 'NotFoundError', message: 'nope' } } }
    ])

    const client = new MonitorClient({
      apiKey: 'super-secret-key',
      apiUrl: 'https://vt.test/api/v3',
      requestFn: requestFn as never,
      logger: log
    })

    await expect(client.getApiQuotas()).rejects.toThrow(/\/users\/\*\*\*\/overall_quotas/)
    await expect(client.getApiQuotas()).rejects.not.toThrow(/super-secret-key/)
  })

  it('reports progress per folder while walking, so a paced run does not look stalled', async () => {
    const log = capturing()
    const { requestFn } = fakeTransport([
      { statusCode: 200, payload: { data: [item('/root/v1', { item_type: 'folder' })] } },
      { statusCode: 200, payload: { data: [item('/root/v1/setup.exe')] } },
      { statusCode: 200, payload: { data: [] } }
    ])

    await new MonitorClient({
      apiKey: 'k',
      apiUrl: 'https://vt.test/api/v3',
      requestFn: requestFn as never,
      logger: log
    }).walk('/root')

    expect(log.lines.info).toEqual([
      expect.stringContaining('Listing /root/ — folder 1'),
      expect.stringContaining('Listing /root/v1/ — folder 2')
    ])
  })

  it('announces the upload body size rather than dumping the body', async () => {
    const log = capturing()
    const dir = await mkdtemp(join(tmpdir(), 'vt-log-'))
    const file = join(dir, 'setup.exe')
    await writeFile(file, 'installer')
    const { requestFn } = fakeTransport([{ statusCode: 200, payload: { data: { id: 'x' } } }])

    await new MonitorClient({
      apiKey: 'k',
      apiUrl: 'https://vt.test/api/v3',
      requestFn: requestFn as never,
      logger: log
    }).uploadFile({ localPath: file, remotePath: '/a/setup.exe', size: 9 })

    expect(log.lines.debug.join('\n')).toMatch(/→ POST \S+ \[\d+ B body\]/)
    expect(log.lines.debug.join('\n')).not.toContain('installer')
  })
})

describe('formatHeaders', () => {
  it('sorts headers and joins array values', () => {
    expect(formatHeaders({ b: '2', a: '1', c: ['x', 'y'] })).toBe('a=1 b=2 c=x,y')
  })

  it('omits cookies and copes with nothing at all', () => {
    expect(formatHeaders({ 'set-cookie': 'session=abc', 'content-type': 'text/plain' })).toBe(
      'content-type=text/plain'
    )
    expect(formatHeaders({})).toBe('(none)')
    expect(formatHeaders(undefined)).toBe('(none)')
  })
})

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-07-30T12:00:00Z')

  it('reads a delay in seconds', () => {
    expect(parseRetryAfter({ 'retry-after': '30' }, now)).toBe(30_000)
  })

  it('reads an HTTP date', () => {
    expect(parseRetryAfter({ 'retry-after': 'Thu, 30 Jul 2026 12:00:45 GMT' }, now)).toBe(45_000)
  })

  it('caps an absurd value so a bad header cannot stall the job', () => {
    expect(parseRetryAfter({ 'retry-after': '99999' }, now)).toBe(5 * 60_000)
  })

  it('ignores missing, unparseable and past values', () => {
    expect(parseRetryAfter(undefined, now)).toBeUndefined()
    expect(parseRetryAfter({}, now)).toBeUndefined()
    expect(parseRetryAfter({ 'retry-after': 'soon' }, now)).toBeUndefined()
    expect(parseRetryAfter({ 'retry-after': '0' }, now)).toBeUndefined()
    expect(parseRetryAfter({ 'retry-after': 'Thu, 30 Jul 2026 11:59:00 GMT' }, now)).toBeUndefined()
  })
})

describe('getApiQuotas', () => {
  it('reads the daily and monthly usage VirusTotal reports for the key', async () => {
    const { calls, requestFn } = fakeTransport([
      {
        statusCode: 200,
        payload: {
          data: {
            api_requests_daily: { allowed: 500, used: 137 },
            api_requests_monthly: { allowed: 15500, used: 4021 }
          }
        }
      }
    ])

    await expect(client(requestFn).getApiQuotas()).resolves.toEqual({
      dailyUsed: 137,
      dailyAllowed: 500,
      monthlyUsed: 4021,
      monthlyAllowed: 15500
    })
    expect(calls[0].url).toBe('https://vt.test/api/v3/users/test-key/overall_quotas')
  })
})

describe('getStatistics', () => {
  it('returns the most recent daily snapshot', async () => {
    const { requestFn } = fakeTransport([
      {
        statusCode: 200,
        payload: {
          data: [
            { attributes: { date: 100, storage_bytes_count: 10, storage_files_count: 1 } },
            { attributes: { date: 200, storage_bytes_count: 20, storage_files_count: 2 } }
          ]
        }
      }
    ])

    await expect(client(requestFn).getStatistics()).resolves.toEqual({
      date: 200,
      storageBytesCount: 20,
      storageFilesCount: 2
    })
  })
})
