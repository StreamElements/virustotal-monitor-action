import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { DIRECT_UPLOAD_LIMIT_BYTES, MonitorApiError, MonitorClient, parseRetryAfter } from '../src/vt-client'

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

  it('falls back to exponential backoff when no Retry-After is sent', async () => {
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

    expect(slept).toEqual([1000])
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
      monthlyUsed: 4021
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
