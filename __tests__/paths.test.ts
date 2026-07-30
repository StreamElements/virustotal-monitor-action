import {
  asFolderPath,
  basename,
  dirname,
  isUnder,
  joinPath,
  looksLikeVersion,
  normalizePath,
  topLevelUnder
} from '../src/paths'

describe('normalizePath', () => {
  it('forces a leading slash, collapses separators and drops the trailing slash', () => {
    expect(normalizePath('obs-streamelements//windows/')).toBe('/obs-streamelements/windows')
    expect(normalizePath('/')).toBe('/')
  })

  it('normalizes Windows separators so the action behaves the same on windows runners', () => {
    expect(normalizePath('\\obs-streamelements\\windows')).toBe('/obs-streamelements/windows')
  })
})

describe('asFolderPath', () => {
  it('always ends with a slash for the path: filter', () => {
    expect(asFolderPath('/a/b')).toBe('/a/b/')
    expect(asFolderPath('/a/b/')).toBe('/a/b/')
    expect(asFolderPath('/')).toBe('/')
  })
})

describe('joinPath / basename / dirname', () => {
  it('joins segments into an absolute monitor path', () => {
    expect(joinPath('/obs-streamelements/windows', '20260729000746', 'setup.exe')).toBe(
      '/obs-streamelements/windows/20260729000746/setup.exe'
    )
  })

  it('extracts names and parents', () => {
    expect(basename('/a/b/c.exe')).toBe('c.exe')
    expect(dirname('/a/b/c.exe')).toBe('/a/b')
    expect(dirname('/c.exe')).toBe('/')
  })
})

describe('isUnder', () => {
  it('matches descendants only, not sibling prefixes', () => {
    expect(isUnder('/a/b/c', '/a/b')).toBe(true)
    expect(isUnder('/a/bc/d', '/a/b')).toBe(false)
    expect(isUnder('/a/b', '/a/b')).toBe(false)
    expect(isUnder('/anything', '/')).toBe(true)
  })
})

describe('topLevelUnder', () => {
  it('returns the version folder for a file inside it, however deep', () => {
    expect(topLevelUnder('/p/w/20260729000746/setup.exe', '/p/w')).toBe('20260729000746')
    expect(topLevelUnder('/p/w/20260729000746/sub/setup.exe', '/p/w')).toBe('20260729000746')
  })

  it('returns the entry itself for a folder or a loose file, so both can be pruned', () => {
    expect(topLevelUnder('/p/w/20260729000746', '/p/w')).toBe('20260729000746')
    expect(topLevelUnder('/p/w/README.txt', '/p/w')).toBe('README.txt')
    expect(topLevelUnder('/p/w/scratch/old.exe', '/p/w')).toBe('scratch')
  })

  it('returns undefined for anything outside the prefix', () => {
    expect(topLevelUnder('/other/x/y.exe', '/p/w')).toBeUndefined()
    expect(topLevelUnder('/p/w', '/p/w')).toBeUndefined()
  })
})

describe('looksLikeVersion', () => {
  it('accepts both spellings a release uses', () => {
    expect(looksLikeVersion('20260729000746')).toBe(true)
    expect(looksLikeVersion('26.7.29.746')).toBe(true)
    expect(looksLikeVersion('20260729_000746')).toBe(true)
  })

  it('rejects names that are not versions', () => {
    expect(looksLikeVersion('README.txt')).toBe(false)
    expect(looksLikeVersion('scratch')).toBe(false)
    expect(looksLikeVersion('20260729000746-backup')).toBe(false)
    expect(looksLikeVersion('obs-streamelements-setup.exe')).toBe(false)
    expect(looksLikeVersion('')).toBe(false)
  })
})
