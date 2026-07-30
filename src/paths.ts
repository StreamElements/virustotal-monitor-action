/**
 * Monitor paths are always POSIX-style and absolute, so we normalize them here instead
 * of using `node:path` (which would produce backslashes when the action runs on Windows).
 */

/** `obs-streamelements//windows/` -> `/obs-streamelements/windows` (no trailing slash). */
export function normalizePath(input: string): string {
  const collapsed = input.replace(/\\/g, '/').replace(/\/+/g, '/')
  const withLeading = collapsed.startsWith('/') ? collapsed : `/${collapsed}`
  if (withLeading.length > 1 && withLeading.endsWith('/')) {
    return withLeading.slice(0, -1)
  }
  return withLeading
}

/** Directory form used by the `filter=path:` query parameter — always ends with `/`. */
export function asFolderPath(input: string): string {
  const normalized = normalizePath(input)
  return normalized.endsWith('/') ? normalized : `${normalized}/`
}

export function joinPath(...segments: string[]): string {
  const joined = segments
    .map(segment => segment.replace(/\\/g, '/'))
    .filter(segment => segment.length > 0)
    .join('/')
  return normalizePath(joined)
}

export function basename(input: string): string {
  const normalized = normalizePath(input)
  const index = normalized.lastIndexOf('/')
  return index === -1 ? normalized : normalized.slice(index + 1)
}

export function dirname(input: string): string {
  const normalized = normalizePath(input)
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

/** True when `child` sits anywhere below `parent`. */
export function isUnder(child: string, parent: string): boolean {
  const normalizedParent = normalizePath(parent)
  if (normalizedParent === '/') return true
  return normalizePath(child).startsWith(`${normalizedParent}/`)
}

/**
 * The first path segment below `prefix`, whether or not anything lives beneath it.
 *
 * `/p/w/20260729000746/setup.exe` and `/p/w/20260729000746` both yield `20260729000746`, and a
 * loose `/p/w/README.txt` yields `README.txt`. Everything directly under a managed prefix is a
 * prune candidate, not only paths that follow the version convention — an unrecognised folder
 * still consumes the storage quota.
 */
export function topLevelUnder(child: string, prefix: string): string | undefined {
  if (!isUnder(child, prefix)) return undefined
  const normalizedPrefix = normalizePath(prefix)
  const rest = normalizePath(child).slice(normalizedPrefix === '/' ? 1 : normalizedPrefix.length + 1)
  const [segment] = rest.split('/')
  return segment || undefined
}

/**
 * Whether a name looks like a release version: digits, optionally separated. Matches both
 * spellings SE.Live uses — `20260729000746` and `26.7.29.746` — and nothing else.
 *
 * This decides ordering, not eligibility. Names that are not versions are purged first, since
 * they are not part of the release history that the keep-newest-N rule exists to protect.
 */
export function looksLikeVersion(name: string): boolean {
  return /^\d+([._-]\d+)*$/.test(name)
}
