import { asFolderPath, basename, dirname, isUnder, joinPath, normalizePath, segmentUnder } from '../src/paths'

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

describe('segmentUnder', () => {
  it('returns the version folder for a file inside it', () => {
    expect(segmentUnder('/p/w/20260729000746/setup.exe', '/p/w')).toBe('20260729000746')
    expect(segmentUnder('/p/w/20260729000746/sub/setup.exe', '/p/w')).toBe('20260729000746')
  })

  it('returns undefined for the version folder itself and for loose files', () => {
    expect(segmentUnder('/p/w/20260729000746', '/p/w')).toBeUndefined()
    expect(segmentUnder('/p/w/README.txt', '/p/w')).toBeUndefined()
    expect(segmentUnder('/other/x/y.exe', '/p/w')).toBeUndefined()
  })
})
