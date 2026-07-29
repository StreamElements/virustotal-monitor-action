import { parseConfig, parseSize, parseWatermark } from '../src/config'

function reader(values: Record<string, string>) {
  return (name: string): string => values[name] ?? ''
}

const base = {
  'api-key': 'secret',
  mode: 'upload',
  files: 'build/setup.exe',
  version: '20260729000746'
}

describe('parseSize', () => {
  it('parses raw byte counts and human sizes', () => {
    expect(parseSize('1073741824', 'quota-bytes')).toBe(1073741824)
    expect(parseSize('1GiB', 'quota-bytes')).toBe(1073741824)
    expect(parseSize('1 GB', 'quota-bytes')).toBe(1000000000)
    expect(parseSize('512mb', 'quota-bytes')).toBe(512000000)
  })

  it('rejects nonsense', () => {
    expect(() => parseSize('0', 'quota-bytes')).toThrow(/positive/)
    expect(() => parseSize('1PB', 'quota-bytes')).toThrow(/unknown unit/)
    expect(() => parseSize('lots', 'quota-bytes')).toThrow(/not a valid size/)
  })
})

describe('parseWatermark', () => {
  it('accepts fractions and percentages', () => {
    expect(parseWatermark('0.8', 'high-watermark')).toBeCloseTo(0.8)
    expect(parseWatermark('80', 'high-watermark')).toBeCloseTo(0.8)
    expect(parseWatermark('80%', 'high-watermark')).toBeCloseTo(0.8)
  })

  it('rejects values above 100%', () => {
    expect(() => parseWatermark('120', 'high-watermark')).toThrow(/must not exceed/)
  })
})

describe('parseConfig', () => {
  it('builds the remote dir from path-prefix and version', () => {
    const config = parseConfig(reader(base))
    expect(config.remoteDir).toBe('/obs-streamelements/windows/20260729000746')
    expect(config.managedPrefixes).toEqual(['/obs-streamelements/windows'])
    expect(config.quotaBytes).toBe(1073741824)
    expect(config.keepVersions).toBe(10)
    expect(config.dryRun).toBe(false)
  })

  it('lets remote-dir override path-prefix and version', () => {
    const config = parseConfig(reader({ ...base, 'remote-dir': '/custom/place/' }))
    expect(config.remoteDir).toBe('/custom/place')
  })

  it('splits newline lists and ignores comments and blanks', () => {
    const config = parseConfig(
      reader({
        ...base,
        'manifest-urls': 'https://a/x.manifest\n\n# a comment\nhttps://a/y.manifest\n'
      })
    )
    expect(config.manifestUrls).toEqual(['https://a/x.manifest', 'https://a/y.manifest'])
  })

  it('requires an api key', () => {
    expect(() => parseConfig(reader({ ...base, 'api-key': '' }))).toThrow(/api-key is required/)
  })

  it('never falls back to an environment variable for the key', () => {
    // The key is a parameter, not a convention: no secret name is assumed anywhere.
    const restore = { ...process.env }
    process.env.VT_MONITOR_API_KEY = 'from-the-environment'
    process.env.VIRUSTOTAL_API_KEY = 'from-the-environment'
    try {
      expect(() => parseConfig(reader({ ...base, 'api-key': '' }))).toThrow(/api-key is required/)
    } finally {
      process.env = restore
    }
  })

  it('requires files and a version for upload modes', () => {
    expect(() => parseConfig(reader({ ...base, files: '' }))).toThrow(/files is required/)
    expect(() => parseConfig(reader({ ...base, version: '' }))).toThrow(/version \(or remote-dir\) is required/)
  })

  it('does not require upload inputs for prune-only runs', () => {
    const config = parseConfig(reader({ 'api-key': 'secret', mode: 'prune' }))
    expect(config.mode).toBe('prune')
    expect(config.filePatterns).toEqual([])
  })

  it('rejects a target watermark that is not below the high watermark', () => {
    expect(() =>
      parseConfig(reader({ ...base, 'high-watermark': '0.6', 'target-watermark': '0.8' }))
    ).toThrow(/must be below high-watermark/)
  })

  it('rejects unknown modes and error policies', () => {
    expect(() => parseConfig(reader({ ...base, mode: 'delete-everything' }))).toThrow(/mode must be one of/)
    expect(() => parseConfig(reader({ ...base, 'on-error': 'shrug' }))).toThrow(/on-error must be/)
  })
})
