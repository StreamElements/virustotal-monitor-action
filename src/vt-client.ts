import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { request } from 'undici'

import { formatBytes } from './format'
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

/** A full listing page runs to a few kilobytes; enough to diagnose, bounded enough to read. */
export const DEFAULT_BODY_LOG_LIMIT = 8192

export class MonitorApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code?: string,
    /**
     * Overrides the status-based retry decision. A 429 is normally worth retrying, but not when
     * we have established it means Monitor storage is full — no amount of waiting frees space.
     */
    readonly retryable?: boolean
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
  /** Characters of response body to log in verbose mode before truncating. */
  bodyLogLimit?: number
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
  private readonly bodyLogLimit: number
  private quotaDiagnosis?: { healthy: boolean; summary: string }
  private diagnosingQuotas = false

  constructor(options: MonitorClientOptions) {
    this.apiKey = options.apiKey
    this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')
    this.maxRetries = options.maxRetries ?? 4
    this.retryBaseMs = options.retryBaseMs ?? 1000
    this.rateLimitBackoffMs = options.rateLimitBackoffMs ?? 60_000
    this.bodyLogLimit = options.bodyLogLimit ?? DEFAULT_BODY_LOG_LIMIT
    this.logger = options.logger ?? silentLogger
    this.requestFn = options.requestFn ?? request
    this.sleepFn = options.sleepFn ?? defaultSleep
    this.rateLimiter = options.rateLimiter
  }

  /**
   * Usage VirusTotal reports for this key. Used to seed the rate limiter so the daily and
   * monthly budgets account for requests made outside this run.
   */
  async getApiQuotas(): Promise<{
    dailyUsed?: number
    dailyAllowed?: number
    monthlyUsed?: number
    monthlyAllowed?: number
  }> {
    return this.fetchQuotas()
  }

  private async fetchQuotas(retries?: number): Promise<{
    dailyUsed?: number
    dailyAllowed?: number
    monthlyUsed?: number
    monthlyAllowed?: number
  }> {
    type Quota = { used?: number; allowed?: number }
    const payload = await this.json<{
      data?: { api_requests_daily?: Quota; api_requests_monthly?: Quota }
    }>('GET', `/users/${encodeURIComponent(this.apiKey)}/overall_quotas`, retries)

    return {
      dailyUsed: payload.data?.api_requests_daily?.used,
      dailyAllowed: payload.data?.api_requests_daily?.allowed,
      monthlyUsed: payload.data?.api_requests_monthly?.used,
      monthlyAllowed: payload.data?.api_requests_monthly?.allowed
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

    let listed = 0
    while (queue.length > 0) {
      const folder = queue.shift() as string
      listed++
      // Monitor has no recursive listing, so this is one request per folder — and at the default
      // rate limit that is ~15s each. Report progress at info level or the job looks stalled.
      this.logger.info(
        `Listing ${asFolderPath(folder)} — folder ${listed}` +
          `${queue.length > 0 ? ` of ${listed + queue.length} known so far` : ''}, ${collected.length} item(s) found`
      )
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

  /**
   * Reads the key's request quotas to decide whether a QuotaExceededError is really about
   * requests. Asked at most once per run, and never from inside itself.
   *
   * `healthy` means daily and monthly both have headroom, so the 429 is not explained by them.
   * The per-minute quota is not reported by this endpoint, which is why the caller only asks
   * after a full minute has already been waited out.
   */
  private async diagnoseQuotas(): Promise<{ healthy: boolean; summary: string } | undefined> {
    if (this.quotaDiagnosis !== undefined) return this.quotaDiagnosis
    if (this.diagnosingQuotas) return undefined

    this.diagnosingQuotas = true
    try {
      // Single attempt: this is a diagnostic, and retrying it would multiply the very wait it
      // exists to avoid. A 429 here is itself an answer — the request quotas are not healthy.
      const quotas = await this.fetchQuotas(0)
      const daily = describeQuota('daily', quotas.dailyUsed, quotas.dailyAllowed)
      const monthly = describeQuota('monthly', quotas.monthlyUsed, quotas.monthlyAllowed)
      // Unknown figures are not evidence of headroom, so an unreadable quota stays inconclusive.
      const healthy = daily.hasHeadroom === true && monthly.hasHeadroom === true
      this.quotaDiagnosis = { healthy, summary: `${daily.text}, ${monthly.text}` }
    } catch (error) {
      this.logger.debug(`Could not read quotas to explain the 429: ${(error as Error).message}`)
      this.quotaDiagnosis = { healthy: false, summary: 'quota usage unavailable' }
    } finally {
      this.diagnosingQuotas = false
    }
    return this.quotaDiagnosis
  }

  /**
   * Strips the API key out of anything about to be logged or thrown. The key appears in the
   * path of /users/{key}/overall_quotas, so a plain URL is enough to leak it. `core.setSecret`
   * would mask it on a runner, but a credential should not be written out and then masked.
   */
  private redact(text: string): string {
    if (!this.apiKey) return text
    return text.split(this.apiKey).join('***').split(encodeURIComponent(this.apiKey)).join('***')
  }

  /**
   * Response body for the debug log, redacted and bounded. A listing page runs to several
   * kilobytes and a user object can echo the key back, so neither raw nor unbounded will do.
   */
  private previewBody(text: string): string {
    if (text.length === 0) return '(empty)'
    const safe = this.redact(text).replace(/\r?\n/g, ' ')
    if (safe.length <= this.bodyLogLimit) return safe
    return `${safe.slice(0, this.bodyLogLimit)}… (${safe.length - this.bodyLogLimit} more character(s) omitted)`
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

  private json<T>(method: 'GET' | 'DELETE' | 'POST', pathAndQuery: string, retries?: number): Promise<T> {
    return this.send<T>({ method, url: `${this.apiUrl}${pathAndQuery}`, retries })
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
    /** Overrides the client's retry budget. 0 means a single attempt. */
    retries?: number
  }): Promise<T> {
    const maxRetries = options.retries ?? this.maxRetries
    let lastError: Error | undefined
    let retryDelayMs: number | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = retryDelayMs ?? this.retryBaseMs * 2 ** (attempt - 1)
        this.logger.debug(
          `Retry ${attempt}/${maxRetries} for ${options.method} ${this.redact(options.url)} in ${delay}ms`
        )
        await this.sleepFn(delay)
      }
      retryDelayMs = undefined

      // A retry costs quota just like the first attempt, so it is paced too.
      if (this.rateLimiter) await this.rateLimiter.acquire()

      const url = options.resolveUrl ? await options.resolveUrl() : options.url
      const startedAt = Date.now()
      const safeUrl = this.redact(url)
      const attemptOf = attempt > 0 ? ` (attempt ${attempt + 1} of ${maxRetries + 1})` : ''
      const bodySize = options.headers?.['content-length']
      this.logger.debug(
        `→ ${options.method} ${safeUrl}${bodySize ? ` [${formatBytes(Number(bodySize))} body]` : ''}${attemptOf}`
      )

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
        this.logger.debug(
          `← ${response.statusCode} in ${Date.now() - startedAt}ms, ${text.length} byte(s) of body`
        )
        // Response headers only. Request headers carry x-apikey and are never logged.
        this.logger.debug(`  headers: ${formatHeaders(response.headers)}`)
        this.logger.debug(`  body: ${this.previewBody(text)}`)

        if (response.statusCode >= 200 && response.statusCode < 300) {
          return (text.length > 0 ? JSON.parse(text) : {}) as T
        }

        const error = toApiError(response.statusCode, text, options.method, safeUrl)
        if (!RETRYABLE_STATUS.has(response.statusCode) || attempt === maxRetries) {
          throw error
        }

        // QuotaExceededError is overloaded: the docs say it covers the minute/daily/monthly
        // request quotas *and* running out of Monitor disk space or file count. Waiting clears
        // the first and does nothing for the second, so once a full window has already been
        // waited out, ask whether the request quotas are actually spent before waiting again.
        if (response.statusCode === 429 && error.code === 'QuotaExceededError' && attempt >= 1) {
          const quotas = await this.diagnoseQuotas()
          if (quotas && quotas.healthy) {
            throw new MonitorApiError(
              `VirusTotal refused the ${options.what ?? `${options.method} request`} with ` +
                `QuotaExceededError after waiting a full rate-limit window. Request quotas are not ` +
                `exhausted (${quotas.summary}), so this is most likely Monitor storage: the account ` +
                'is out of disk space or out of files. Run the prune step to free space, and check ' +
                'that quota-bytes matches the real Monitor limit. If instead the key allows fewer ' +
                'requests per minute than rate-limit-per-minute, lower that input.',
              response.statusCode,
              error.code,
              false
            )
          }
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
              `Waiting ${Math.round(retryDelayMs / 1000)}s before attempt ${attempt + 2} of ${maxRetries + 1}. ` +
              'If this recurs, lower rate-limit-per-minute to match the key.'
          )
        } else {
          retryDelayMs = parseRetryAfter(response.headers)
          this.logger.warning(`${error.message} — retrying`)
        }
        lastError = error
      } catch (caught) {
        if (caught instanceof MonitorApiError) {
          const retryable = caught.retryable ?? RETRYABLE_STATUS.has(caught.statusCode)
          if (!retryable || attempt === maxRetries) throw caught
          lastError = caught
          continue
        }
        // Network-level failure (reset socket, DNS, timeout): worth another attempt.
        const error = caught instanceof Error ? caught : new Error(String(caught))
        if (attempt === maxRetries) throw error
        this.logger.warning(`${options.method} ${safeUrl} failed: ${this.redact(error.message)} — retrying`)
        lastError = error
      }
    }

    throw lastError ?? new Error(`${options.method} ${this.redact(options.url)} failed`)
  }
}

/** `hasHeadroom` is undefined when VirusTotal did not report the figure — unknown is not healthy. */
function describeQuota(
  label: string,
  used: number | undefined,
  allowed: number | undefined
): { hasHeadroom: boolean | undefined; text: string } {
  if (typeof used !== 'number' || typeof allowed !== 'number' || allowed <= 0) {
    return { hasHeadroom: undefined, text: `${label} unknown` }
  }
  return { hasHeadroom: used < allowed, text: `${label} ${used}/${allowed}` }
}

/**
 * Renders response headers for the debug log. Only ever called with *response* headers —
 * request headers carry the API key and must not reach the log.
 */
export function formatHeaders(headers: Record<string, string | string[] | undefined> | undefined): string {
  if (!headers) return '(none)'
  const rendered = Object.keys(headers)
    .sort()
    // A cookie is of no diagnostic use here and is the one response header worth not printing.
    .filter(name => name.toLowerCase() !== 'set-cookie')
    .map(name => {
      const value = headers[name]
      return `${name}=${Array.isArray(value) ? value.join(',') : value}`
    })
  return rendered.length > 0 ? rendered.join(' ') : '(none)'
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
