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
