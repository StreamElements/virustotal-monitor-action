import { request } from 'undici'

import { Logger, silentLogger } from './logging'

/**
 * The live channel manifests (`obs-streamelements.{qa,beta,latest,stable}.manifest`) are the
 * source of truth for "still in use". They are INI-ish text whose `package_url` lines embed
 * the release filename, e.g.
 *
 *   package_url_64=https://cdn.streamelements.com/.../obs-streamelements-setup-20260729000746-64bit.exe
 *
 * Rather than parse a format that has changed shape before, we keep the raw text and ask
 * whether it mentions a candidate release at all. Matching too eagerly only means keeping a
 * release longer than necessary; matching too narrowly would delete a live installer.
 */
export interface ManifestIndex {
  readonly sources: string[]
  /** True when any manifest mentions any of the given spellings/filenames. */
  references: (tokens: string[]) => boolean
}

export const emptyManifestIndex: ManifestIndex = {
  sources: [],
  references: () => false
}

export interface FetchManifestsOptions {
  logger?: Logger
  requestFn?: typeof request
  timeoutMs?: number
}

/**
 * Fetches every manifest URL. Any failure throws: pruning with an incomplete picture of
 * what is live is exactly how a released installer gets deleted.
 */
export async function fetchManifests(urls: string[], options: FetchManifestsOptions = {}): Promise<ManifestIndex> {
  const logger = options.logger ?? silentLogger
  const requestFn = options.requestFn ?? request
  if (urls.length === 0) return emptyManifestIndex

  const texts: string[] = []
  for (const [index, url] of urls.entries()) {
    // These are CDN fetches, not VirusTotal calls, so they are not rate limited and should be
    // quick. Numbering them makes it obvious when the slow part is what comes after.
    logger.info(`  [${index + 1}/${urls.length}] ${url}`)
    const startedAt = Date.now()
    const response = await requestFn(url, {
      method: 'GET',
      headers: { 'user-agent': 'streamelements-virustotal-monitor-action' },
      headersTimeout: options.timeoutMs ?? 30_000,
      maxRedirections: 3
    })
    const text = await response.body.text()
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Failed to fetch manifest ${url}: HTTP ${response.statusCode} ${text.slice(0, 200)}`)
    }

    const version = /^\s*version_number\s*=\s*(\S+)/im.exec(text)?.[1]
    logger.info(
      `      HTTP ${response.statusCode}, ${text.length} bytes, ${Date.now() - startedAt}ms` +
        `${version ? ` — currently serving version ${version}` : ''}`
    )
    texts.push(text.toLowerCase())
  }

  return {
    sources: [...urls],
    references(tokens: string[]): boolean {
      return tokens.some(token => {
        const needle = token.trim().toLowerCase()
        if (needle.length === 0) return false
        return texts.some(text => text.includes(needle))
      })
    }
  }
}
