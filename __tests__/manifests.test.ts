import { fetchManifests } from '../src/manifests'

const MANIFEST = `
[obs-browser]
version_number=26.7.29.746
package_url=https://cdn.streamelements.com/obs/dist/obs-streamelements/windows/signed/obs-streamelements-setup-20260729000746.exe
package_url_64=https://cdn.streamelements.com/obs/dist/obs-streamelements/windows/signed/obs-streamelements-setup-20260729000746-64bit.exe
force_install=false
`

function transport(responses: Array<{ statusCode: number; text: string }>) {
  const urls: string[] = []
  let index = 0
  const requestFn = (async (url: string) => {
    urls.push(url)
    const response = responses[Math.min(index, responses.length - 1)]
    index++
    return { statusCode: response.statusCode, headers: {}, body: { text: async () => response.text } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any
  return { urls, requestFn }
}

describe('fetchManifests', () => {
  it('reports a release as referenced by filename or by version', async () => {
    const { urls, requestFn } = transport([{ statusCode: 200, text: MANIFEST }])
    const index = await fetchManifests(['https://cdn.test/obs-streamelements.latest.manifest'], { requestFn })

    expect(urls).toEqual(['https://cdn.test/obs-streamelements.latest.manifest'])
    expect(index.references(['obs-streamelements-setup-20260729000746.exe'])).toBe(true)
    expect(index.references(['20260729000746'])).toBe(true)
    expect(index.references(['26.7.29.746'])).toBe(true)
    expect(index.references(['20250101000001'])).toBe(false)
  })

  it('ignores case, since manifests are hand-edited', async () => {
    const { requestFn } = transport([{ statusCode: 200, text: MANIFEST.toUpperCase() }])
    const index = await fetchManifests(['https://cdn.test/x.manifest'], { requestFn })
    expect(index.references(['obs-streamelements-setup-20260729000746.exe'])).toBe(true)
  })

  it('ignores empty tokens rather than matching everything', async () => {
    const { requestFn } = transport([{ statusCode: 200, text: MANIFEST }])
    const index = await fetchManifests(['https://cdn.test/x.manifest'], { requestFn })
    expect(index.references(['', '   '])).toBe(false)
  })

  it('throws when a manifest cannot be fetched, so pruning never runs half-blind', async () => {
    const { requestFn } = transport([{ statusCode: 503, text: 'upstream down' }])
    await expect(fetchManifests(['https://cdn.test/x.manifest'], { requestFn })).rejects.toThrow(
      /Failed to fetch manifest .*HTTP 503/
    )
  })

  it('returns an index that protects nothing when no URLs are configured', async () => {
    const index = await fetchManifests([])
    expect(index.sources).toEqual([])
    expect(index.references(['anything'])).toBe(false)
  })
})

/**
 * Shapes taken verbatim from the five live channel manifests. They disagree about filenames --
 * signed/ uses `-<version>.exe` and `-<version>-64bit.exe`, qa/beta/latest use `-x86-` and
 * `-x64-`, and stable drops the version from the filename entirely -- so protection has to key
 * off the version, which every one of them carries in `version_number`.
 */
describe('the live channel manifest formats', () => {
  const SIGNED = `
[obs-browser]
version_number=20260729000708
package_url=https://cdn.streamelements.com/obs/dist/obs-streamelements/windows/signed/obs-streamelements-setup-20260729000708.exe
package_url_64=https://cdn.streamelements.com/obs/dist/obs-streamelements/windows/signed/obs-streamelements-setup-20260729000708-64bit.exe
`

  const QA = `
[obs-browser]
package_url=https://cdn.streamelements.com/obs/dist/obs-streamelements/windows/signed/obs-streamelements-setup-20260205000549.exe?ts=13414786816424
package_url_32=https://cdn.streamelements.com/obs/dist/obs-streamelements/windows/signed/obs-streamelements-setup-x86-20260205000549.exe?ts=13414786816424
package_url_64=https://cdn.streamelements.com/obs/dist/obs-streamelements/windows/signed/obs-streamelements-setup-x64-20260205000549.exe?ts=13414786816424
version_number=20260205000549
`

  const STABLE = `
[obs-browser]
version_number=20241127000268
package_url=https://cdn.streamelements.com/obs/dist/obs-streamelements/windows/stable/obs-streamelements-setup.exe?v=20241127000268
package_url_64=https://cdn.streamelements.com/obs/dist/obs-streamelements/windows/stable/obs-streamelements-setup-x64.exe?v=20241127000268
[[[BEGIN_RELEASE_NOTES]]]
<html><body>Release notes for 26.11.27</body></html>
[[[END_RELEASE_NOTES]]]
`

  async function indexOf(...texts: string[]) {
    const { requestFn } = transport(texts.map(text => ({ statusCode: 200, text })))
    return fetchManifests(
      texts.map((_, i) => `https://cdn.test/${i}.manifest`),
      { requestFn }
    )
  }

  it('protects every live release across all five manifests', async () => {
    const index = await indexOf(SIGNED, QA, QA, QA, STABLE)

    expect(index.references(['20260729000708'])).toBe(true) // signed
    expect(index.references(['20260205000549'])).toBe(true) // qa / beta / latest
    expect(index.references(['20241127000268'])).toBe(true) // stable
    expect(index.references(['20260101000001'])).toBe(false) // long superseded
  })

  it('protects stable even though its filenames carry no version', async () => {
    const index = await indexOf(STABLE)

    // The name our Monitor copy would have — absent from the manifest.
    expect(index.references(['obs-streamelements-setup-20241127000268.exe'])).toBe(false)
    // The version itself is present twice, in version_number and the ?v= query.
    expect(index.references(['obs-streamelements-setup-20241127000268.exe', '20241127000268'])).toBe(true)
  })

  it('is unaffected by the byte order mark the signed manifest starts with', async () => {
    const index = await indexOf(`﻿${SIGNED}`)
    expect(index.references(['20260729000708'])).toBe(true)
  })
})
