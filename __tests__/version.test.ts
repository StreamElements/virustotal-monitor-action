import { compareVersions, versionSpellings } from '../src/version'

describe('compareVersions', () => {
  it('orders encoded SE.Live versions by date then build number', () => {
    expect(compareVersions('20260101000009', '20260729000746')).toBeLessThan(0)
    expect(compareVersions('20260729000746', '20260729000745')).toBeGreaterThan(0)
    expect(compareVersions('20260729000746', '20260729000746')).toBe(0)
  })

  it('compares dotted versions numerically, not lexically', () => {
    expect(compareVersions('26.7.9.746', '26.7.29.746')).toBeLessThan(0)
    expect(compareVersions('26.10.1.1', '26.9.1.1')).toBeGreaterThan(0)
  })

  it('treats a shorter version as older when it is a prefix of a longer one', () => {
    expect(compareVersions('1.2', '1.2.1')).toBeLessThan(0)
  })

  it('treats a suffixed version as newer than the bare one', () => {
    expect(compareVersions('1.0-rc', '1.0')).toBeGreaterThan(0)
  })

  it('sorts a list oldest first', () => {
    const sorted = ['20260729000746', '20250101000001', '20260101000500'].sort(compareVersions)
    expect(sorted).toEqual(['20250101000001', '20260101000500', '20260729000746'])
  })
})

describe('versionSpellings', () => {
  it('includes the separator variants a manifest might use', () => {
    expect(versionSpellings('26.7.29.746')).toEqual(
      expect.arrayContaining(['26.7.29.746', '26_7_29_746', '26-7-29-746'])
    )
  })

  it('splits the encoded date/build form', () => {
    expect(versionSpellings('20260729000746')).toEqual(
      expect.arrayContaining(['20260729000746', '20260729.000746', '20260729-000746'])
    )
  })
})
