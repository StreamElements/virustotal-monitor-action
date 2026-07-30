import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { request } from 'undici'

import { Logger, silentLogger } from './logging'
import { buildMultipart } from './multipart'
import { RateLimiter } from './rate-limiter'
import { asFolderPath, normalizePath } from './paths'
import { MonitorItem, MonitorStatistics } from './types'

export const DEFAULT_API_URL = 'https://www.virustotal.com/api/v3'

/**
 * VirusTotal rejects direct uploads of files >= 32 MB and hands out a dedicated upload URL
 * instead. See https://docs.virustotal.com/reference/monitor-items-create.
 */
export const DIRECT_UPLOAD_LIMIT_BYTES = 32 * 1024 * 1024

/** VirusTotal caps collection pages at 40 items. */
const PAGE_LIMIT = 40

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

export class MonitorApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code?: string
  ) {
    super(message)
    this.name = 'MonitorApiError'
  }
}

type RequestFn = typeof request

export interface MonitorClientOptions {
  apiKey: string
  apiUrl?: string
  maxRetries?: number
  retryBaseMs?: number
  /** Wait after a 429 that carries no Retry-After. Defaults to one full minute window. */
  rateLimitBackoffMs?: number
  logger?: Logger
  /** Paces calls to stay inside VirusTotal's quotas. Omit to send without pacing. */
  rateLimiter?: Pick<RateLimiter, 'acquire'> & Partial<Pick<RateLimiter, 'penalize'>>
  /** Seam for tests; defaults to undici's `request`. */
  requestFn?: RequestFn
  sleepFn?: (ms: number) => Promise<void>
}

interface RawMonitorItem {
  id?: string
  type?: string
  attributes?: {
    path?: string
    item_type?: string
    size?: number
    sha256?: string
    creation_date?: number
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseItem(raw: RawMonitorItem): MonitorItem | undefined {
  const path = raw.attributes?.path
  if (!raw.id || !path) return undefined
  const declaredType = raw.attributes?.item_type
  const itemType: MonitorItem['itemType'] =
    declaredType === 'folder' || (declaredType === undefined && path.endsWith('/')) ? 'folder' : 'file'
  return {
    id: raw.id,
    path: normalizePath(path),
    itemType,
    size: typeof raw.attributes?.size === 'number' ? raw.attributes.size : 0,
    sha256: raw.attributes?.sha256,
    creationDate: raw.attributes?.creation_date
  }
}

export class MonitorClient {
  private readonly apiKey: string
  private readonly apiUrl: string
  private readonly maxRetries: number
  private readonly retryBaseMs: number
  private readonly logger: Logger
  private readonly requestFn: RequestFn
  private readonly sleepFn: (ms: number) => Promise<void>
  private readonly rateLimiter?: Pick<RateLimiter, 'acquire'> & Partial<Pick<RateLimiter, 'penalize'>>
  private readonly rateLimitBackoffMs: number

  constructor(options: MonitorClientOptions) {
    this.apiKey = options.apiKey
    this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')
    this.maxRetries = options.maxRetries ?? 4
    this.retryBaseMs = options.retryBaseMs ?? 1000
    this.rateLimitBackoffMs = options.rateLimitBackoffMs ?? 60_000
    this.logger = options.logger ?? silentLogger
    this.requestFn = options.requestFn ?? request
    this.sleepFn = options.sleepFn ?? defaultSleep
    this.rateLimiter = options.rateLimiter
  }

  /**
   * Usage VirusTotal reports for this key. Used to seed the rate limiter so the daily and
   * monthly budgets account for requests made outside this run.
   */
  async getApiQuotas(): Promise<{ dailyUsed?: number; monthlyUsed?: number; dailyAllowed?: number }> {
    type Quota = { used?: number; allowed?: number }
    const payload = await this.json<{
      data?: { api_requests_daily?: Quota; api_requests_monthly?: Quota }
    }>('GET', `/users/${encodeURIComponent(this.apiKey)}/overall_quotas`)

    return {
      dailyUsed: payload.data?.api_requests_daily?.used,
      dailyAllowed: payload.data?.api_requests_daily?.allowed,
      monthlyUsed: payload.data?.api_requests_monthly?.used
    }
  }

  /** Direct children of a Monitor folder (files and sub-folders). */
  async listFolder(folderPath: string): Promise<MonitorItem[]> {
    const items: MonitorItem[] = []
    let cursor: string | undefined

    do {
      const query = new URLSearchParams({
        filter: `path:${asFolderPath(folderPath)}`,
        limit: String(PAGE_LIMIT)
      })
      if (cursor) query.set('cursor', cursor)

      const payload = await this.json<{ data?: RawMonitorItem[]; meta?: { cursor?: string } }>(
        'GET',
        `/monitor/items?${query.toString()}`
      )
      for (const raw of payload.data ?? []) {
        const item = parseItem(raw)
        if (item) items.push(item)
      }
      cursor = payload.meta?.cursor
    } while (cursor)

    return items
  }

  /**
   * Every item at or below `rootPath`. Monitor has no recursive listing, so we walk the
   * folder tree breadth-first; the release layout is only two levels deep.
   */
  async walk(rootPath: string): Promise<MonitorItem[]> {
    const seen = new Set<string>()
    const collected: MonitorItem[] = []
    const queue = [normalizePath(rootPath)]
    const visitedFolders = new Set<string>(queue)

    while (queue.length > 0) {
      const folder = queue.shift() as string
      this.logger.debug(`Listing ${asFolderPath(folder)}`)
      for (const item of await this.listFolder(folder)) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        collected.push(item)
        if (item.itemType === 'folder' && !visitedFolders.has(item.path)) {
          visitedFolders.add(item.path)
          queue.push(item.path)
        }
      }
    }

    return collected
  }

  async deleteItem(id: string): Promise<void> {
    await this.json('DELETE', `/monitor/items/${encodeURIComponent(id)}`)
  }

  /** Most recent daily storage snapshot, or undefined when Monitor has no statistics yet. */
  async getStatistics(): Promise<MonitorStatistics | undefined> {
    const payload = await this.json<{
      data?: { attributes?: { date?: number; storage_bytes_count?: number; storage_files_count?: number } }[]
    }>('GET', '/monitor/statistics')

    const rows = (payload.data ?? [])
      .map(row => ({
        date: row.attributes?.date ?? 0,
        storageBytesCount: row.attributes?.storage_bytes_count ?? 0,
        storageFilesCount: row.attributes?.storage_files_count ?? 0
      }))
      .sort((a, b) => b.date - a.date)

    return rows[0]
  }

  async getUploadUrl(): Promise<string> {
    const payload = await this.json<{ data?: string }>('GET', '/monitor/items/upload_url')
    if (!payload.data) {
      throw new MonitorApiError('VirusTotal returned an empty upload URL', 0)
    }
    // The documented sample URL is http://; never send an API key or binary in the clear.
    // The exception is an api-url that is itself plain http, which only happens when pointing
    // at a local server in tests — forcing https there would make the path untestable.
    return this.apiUrl.startsWith('https://')
      ? payload.data.replace(/^http:\/\//i, 'https://')
      : payload.data
  }

  /**
   * Uploads a file to `remotePath`. Passing `existingItemId` overwrites that item in place,
   * which is how re-running a release stays idempotent instead of creating a second copy.
   * Returns the Monitor item id.
   */
  async uploadFile(params: {
    localPath: string
    remotePath: string
    size: number
    existingItemId?: string
  }): Promise<string> {
    const remotePath = normalizePath(params.remotePath)
    const filename = remotePath.slice(remotePath.lastIndexOf('/') + 1)

    const fields: Record<string, string> = params.existingItemId
      ? { item: params.existingItemId }
      : { path: remotePath }

    const body = buildMultipart(fields, {
      field: 'file',
      filename,
      contentType: 'application/octet-stream',
      size: params.size,
      createStream: () => createReadStream(params.localPath)
    })

    // Upload URLs handed out for large files are single-use and temporary, so every attempt
    // needs its own — retrying against the previous one fails on a URL, not on the upload.
    const large = params.size >= DIRECT_UPLOAD_LIMIT_BYTES

    const payload = await this.send<{ data?: { id?: string } }>({
      method: 'POST',
      url: `${this.apiUrl}/monitor/items`,
      resolveUrl: large ? () => this.getUploadUrl() : undefined,
      headers: {
        'content-type': body.contentType,
        'content-length': String(body.contentLength)
      },
      createBody: () => body.createStream(),
      // Large uploads keep the socket busy long before the response headers arrive.
      headersTimeoutMs: 15 * 60 * 1000,
      what: `upload of ${remotePath}`
    })

    const id = payload.data?.id
    if (!id) {
      throw new MonitorApiError(`Upload of ${remotePath} returned no item id`, 0)
    }
    return id
  }

  private json<T>(method: 'GET' | 'DELETE' | 'POST', pathAndQuery: string): Promise<T> {
    return this.send<T>({ method, url: `${this.apiUrl}${pathAndQuery}` })
  }

  private async send<T>(options: {
    method: 'GET' | 'DELETE' | 'POST'
    url: string
    /** Produces a fresh URL per attempt, for single-use endpoints like the large-file upload URL. */
    resolveUrl?: () => Promise<string>
    headers?: Record<string, string>
    createBody?: () => Readable
    headersTimeoutMs?: number
    /** Human description used in rate-limit messages, e.g. "upload of /a/setup.exe". */
    what?: string
  }): Promise<T> {
    let lastError: Error | undefined
    let retryDelayMs: number | undefined

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = retryDelayMs ?? this.retryBaseMs * 2 ** (attempt - 1)
        this.logger.debug(`Retry ${attempt}/${this.maxRetries} for ${options.method} ${options.url} in ${delay}ms`)
        await this.sleepFn(delay)
      }
      retryDelayMs = undefined

      // A retry costs quota just like the first attempt, so it is paced too.
      if (this.rateLimiter) await this.rateLimiter.acquire()

      const url = options.resolveUrl ? await options.resolveUrl() : options.url

      try {
        const response = await this.requestFn(url, {
          method: options.method,
          headers: {
            'x-apikey': this.apiKey,
            accept: 'application/json',
            'user-agent': 'streamelements-virustotal-monitor-action',
            ...options.headers
          },
          body: options.createBody ? options.createBody() : undefined,
          maxRedirections: 0,
          headersTimeout: options.headersTimeoutMs ?? 60_000
        })

        const text = await response.body.text()
        if (response.statusCode >= 200 && response.statusCode < 300) {
          return (text.length > 0 ? JSON.parse(text) : {}) as T
        }

        const error = toApiError(response.statusCode, text, options.method, url)
        if (!RETRYABLE_STATUS.has(response.statusCode) || attempt === this.maxRetries) {
          throw error
        }

        if (response.statusCode === 429) {
          // Our pacing was too optimistic for this key. Exponential backoff from a 1s base is
          // the wrong shape here: the smallest VirusTotal window is a minute, so 1s/2s/4s/8s
          // just burns the retry budget — and for a large upload, re-sends the whole file each
          // time. Wait what VirusTotal asks for, or a full window if it does not say.
          retryDelayMs = parseRetryAfter(response.headers) ?? this.rateLimitBackoffMs
          this.rateLimiter?.penalize?.(retryDelayMs)
          this.logger.warning(
            `VirusTotal rate-limited the ${options.what ?? `${options.method} request`} (HTTP 429). ` +
              `Waiting ${Math.round(retryDelayMs / 1000)}s before attempt ${attempt + 2} of ${this.maxRetries + 1}. ` +
              'If this recurs, lower rate-limit-per-minute to match the key.'
          )
        } else {
          retryDelayMs = parseRetryAfter(response.headers)
          this.logger.warning(`${error.message} — retrying`)
        }
        lastError = error
      } catch (caught) {
        if (caught instanceof MonitorApiError) {
          if (!RETRYABLE_STATUS.has(caught.statusCode) || attempt === this.maxRetries) throw caught
          lastError = caught
          continue
        }
        // Network-level failure (reset socket, DNS, timeout): worth another attempt.
        const error = caught instanceof Error ? caught : new Error(String(caught))
        if (attempt === this.maxRetries) throw error
        this.logger.warning(`${options.method} ${url} failed: ${error.message} — retrying`)
        lastError = error
      }
    }

    throw lastError ?? new Error(`${options.method} ${options.url} failed`)
  }
}

/** `Retry-After` is either a delay in seconds or an HTTP date. Capped so a bad value can't stall a job. */
export function parseRetryAfter(
  headers: Record<string, string | string[] | undefined> | undefined,
  now: number = Date.now()
): number | undefined {
  const raw = headers?.['retry-after']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) return undefined

  const seconds = Number(value)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  return Math.min(ms, 5 * 60_000)
}

function toApiError(statusCode: number, text: string, method: string, url: string): MonitorApiError {
  let code: string | undefined
  let detail = text.slice(0, 500)
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
    if (parsed.error) {
      code = parsed.error.code
      detail = parsed.error.message ?? detail
    }
  } catch {
    // Non-JSON error body (e.g. an HTML gateway page) — keep the raw text.
  }
  const suffix = code ? ` (${code})` : ''
  return new MonitorApiError(`${method} ${url} failed with HTTP ${statusCode}${suffix}: ${detail}`, statusCode, code)
}
