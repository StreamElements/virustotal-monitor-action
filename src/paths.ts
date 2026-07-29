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
 * The first path segment below `prefix`, i.e. the version folder name.
 * Returns undefined for files sitting directly in the prefix — those are never pruned.
 */
export function segmentUnder(child: string, prefix: string): string | undefined {
  if (!isUnder(child, prefix)) return undefined
  const normalizedPrefix = normalizePath(prefix)
  const rest = normalizePath(child).slice(normalizedPrefix === '/' ? 1 : normalizedPrefix.length + 1)
  const [segment, ...tail] = rest.split('/')
  if (!segment || tail.length === 0) return undefined
  return segment
}
