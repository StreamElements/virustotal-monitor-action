/**
 * Version ordering for prune decisions.
 *
 * SE.Live ships two spellings of the same release: the encoded form used in filenames and
 * folder names (`20260729000746` = date + zero-padded build number) and the dotted display
 * form (`26.7.29.746`). Both sort correctly by splitting into numeric/alphabetic runs and
 * comparing numbers as numbers, so `20260729000746` > `20260101000009` and `26.7.29.746` >
 * `26.7.9.746` — which a plain string compare gets wrong.
 */

type Chunk = { num: number } | { text: string }

function chunks(version: string): Chunk[] {
  const parts = version.match(/\d+|\D+/g) ?? []
  return parts.map(part => (/^\d+$/.test(part) ? { num: Number(part) } : { text: part.toLowerCase() }))
}

/** Ascending: negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const left = chunks(a)
  const right = chunks(b)
  const length = Math.max(left.length, right.length)

  for (let i = 0; i < length; i++) {
    const l = left[i]
    const r = right[i]
    if (l === undefined) return -1
    if (r === undefined) return 1

    const lNum = 'num' in l
    const rNum = 'num' in r
    if (lNum && rNum) {
      if (l.num !== r.num) return l.num < r.num ? -1 : 1
      continue
    }
    // Numeric segments sort before alphabetic ones, so `1.0` precedes `1.0-rc`.
    if (lNum !== rNum) return lNum ? -1 : 1
    const lText = (l as { text: string }).text
    const rText = (r as { text: string }).text
    if (lText !== rText) return lText < rText ? -1 : 1
  }
  return 0
}

/**
 * Spellings of a version that might appear in a channel manifest. Manifests reference
 * releases by filename (which embeds the encoded version) but we also match the dotted and
 * separator-swapped forms so a manifest written in any of them still protects the release.
 */
export function versionSpellings(version: string): string[] {
  const spellings = new Set<string>([version])
  spellings.add(version.replace(/_/g, '.'))
  spellings.add(version.replace(/-/g, '.'))
  spellings.add(version.replace(/\./g, '_'))
  spellings.add(version.replace(/\./g, '-'))

  // 20260729000746 -> 20260729.000746, the split the CDN filenames use in some workflows.
  const encoded = /^(\d{8})(\d{6})$/.exec(version)
  if (encoded) {
    spellings.add(`${encoded[1]}.${encoded[2]}`)
    spellings.add(`${encoded[1]}-${encoded[2]}`)
  }
  return [...spellings].filter(spelling => spelling.length > 0)
}
