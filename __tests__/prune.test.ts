import { ManifestIndex } from '../src/manifests'
import { buildVersionGroups, decideRetention, runPrune, sortOldestFirst } from '../src/prune'
import { MonitorItem } from '../src/types'
import { MonitorClient } from '../src/vt-client'

const PREFIX = '/obs-streamelements/windows'
const VERSIONS = ['20260101000001', '20260102000002', '20260103000003', '20260104000004', '20260105000005']

/** One 200-byte installer plus its version folder, per version. */
function itemsFor(versions: string[], size = 200): MonitorItem[] {
  return versions.flatMap((version, index) => [
    {
      id: `folder:${version}`,
      path: `${PREFIX}/${version}`,
      itemType: 'folder' as const,
      size: 0,
      creationDate: 1000 + index
    },
    {
      id: `file:${version}`,
      path: `${PREFIX}/${version}/obs-streamelements-setup-${version}.exe`,
      itemType: 'file' as const,
      size,
      sha256: `sha-${version}`,
      creationDate: 1000 + index
    }
  ])
}

function manifestsMentioning(...needles: string[]): ManifestIndex {
  return {
    sources: ['https://cdn.test/obs-streamelements.latest.manifest'],
    references: tokens => tokens.some(token => needles.some(needle => needle.includes(token)))
  }
}

function fakeClient(items: MonitorItem[]): { client: MonitorClient; deleteItem: jest.Mock } {
  const deleteItem = jest.fn().mockResolvedValue(undefined)
  const client = {
    walk: jest.fn().mockResolvedValue(items),
    deleteItem
  } as unknown as MonitorClient
  return { client, deleteItem }
}

const baseOptions = {
  prefixes: [PREFIX],
  quotaBytes: 1000,
  highWatermark: 0.8,
  targetWatermark: 0.6,
  keepVersions: 0,
  pinnedVersions: [],
  dryRun: false,
  usageSource: 'walk' as const
}

describe('buildVersionGroups', () => {
  it('groups files and the version folder under one entry per version', () => {
    const groups = buildVersionGroups(itemsFor(['20260101000001']), [PREFIX])

    expect(groups).toHaveLength(1)
    expect(groups[0].path).toBe(`${PREFIX}/20260101000001`)
    expect(groups[0].files).toHaveLength(1)
    expect(groups[0].folders.map(f => f.path)).toEqual([`${PREFIX}/20260101000001`])
    expect(groups[0].sizeBytes).toBe(200)
    expect(groups[0].creationDate).toBe(1000)
  })

  it('ignores items outside the managed prefixes and loose files in the prefix root', () => {
    const items: MonitorItem[] = [
      ...itemsFor(['20260101000001']),
      { id: 'other', path: '/somewhere/else/x.exe', itemType: 'file', size: 999 },
      { id: 'loose', path: `${PREFIX}/README.txt`, itemType: 'file', size: 5 }
    ]

    const groups = buildVersionGroups(items, [PREFIX])
    expect(groups).toHaveLength(1)
    expect(groups[0].sizeBytes).toBe(200)
  })
})

describe('sortOldestFirst', () => {
  it('orders by version, oldest first', () => {
    const groups = buildVersionGroups(itemsFor([...VERSIONS].reverse()), [PREFIX])
    expect(sortOldestFirst(groups).map(g => g.version)).toEqual(VERSIONS)
  })
})

describe('decideRetention', () => {
  const groups = buildVersionGroups(itemsFor(VERSIONS), [PREFIX])

  it('keeps the newest N versions per prefix', () => {
    const decisions = decideRetention(groups, {
      keepVersions: 2,
      manifests: manifestsMentioning(),
      pinnedVersions: []
    })
    const kept = decisions.filter(d => d.keep).map(d => d.group.version)
    expect(kept).toEqual(['20260104000004', '20260105000005'])
    expect(decisions.filter(d => d.keep).every(d => d.reason === 'recent')).toBe(true)
  })

  it('keeps anything a channel manifest still points at, however old', () => {
    const manifests = manifestsMentioning(
      'package_url=https://cdn/obs-streamelements-setup-20260101000001.exe'
    )
    const decisions = decideRetention(groups, { keepVersions: 0, manifests, pinnedVersions: [] })

    const oldest = decisions.find(d => d.group.version === '20260101000001')
    expect(oldest?.keep).toBe(true)
    expect(oldest?.reason).toBe('manifest')
  })

  it('keeps explicitly pinned versions', () => {
    const decisions = decideRetention(groups, {
      keepVersions: 0,
      manifests: manifestsMentioning(),
      pinnedVersions: ['20260102000002']
    })

    const pinned = decisions.find(d => d.group.version === '20260102000002')
    expect(pinned?.keep).toBe(true)
    expect(pinned?.reason).toBe('pinned')
  })
})

describe('runPrune', () => {
  it('does nothing while usage is below the high watermark', async () => {
    // 3 x 200 B = 600 B of a 1000 B quota = 60%.
    const { client, deleteItem } = fakeClient(itemsFor(VERSIONS.slice(0, 3)))
    const result = await runPrune(client, { ...baseOptions, manifests: manifestsMentioning() })

    expect(result.triggered).toBe(false)
    expect(result.usageBytesBefore).toBe(600)
    expect(deleteItem).not.toHaveBeenCalled()
    expect(result.deleted).toEqual([])
  })

  it('deletes oldest first until usage is back under the target watermark', async () => {
    // 5 x 200 B = 1000 B = 100%; target 60% means freeing 400 B, i.e. the two oldest.
    const { client, deleteItem } = fakeClient(itemsFor(VERSIONS))
    const result = await runPrune(client, { ...baseOptions, manifests: manifestsMentioning() })

    expect(result.triggered).toBe(true)
    expect(result.deleted.map(g => g.version)).toEqual(['20260101000001', '20260102000002'])
    expect(result.freedBytes).toBe(400)
    expect(result.usageBytesAfter).toBe(600)
    expect(result.ratioAfter).toBeCloseTo(0.6)
    expect(result.shortfallBytes).toBe(0)
    // Two files plus their two folders.
    expect(deleteItem).toHaveBeenCalledTimes(4)
    expect(deleteItem).toHaveBeenCalledWith('file:20260101000001')
    expect(deleteItem).toHaveBeenCalledWith('folder:20260101000001')
    expect(deleteItem).not.toHaveBeenCalledWith('file:20260103000003')
  })

  it('never deletes a version a channel manifest still points at', async () => {
    const { client, deleteItem } = fakeClient(itemsFor(VERSIONS))
    const manifests = manifestsMentioning(
      'package_url=https://cdn/obs-streamelements-setup-20260101000001.exe'
    )

    const result = await runPrune(client, { ...baseOptions, manifests })

    expect(result.deleted.map(g => g.version)).toEqual(['20260102000002', '20260103000003'])
    expect(deleteItem).not.toHaveBeenCalledWith('file:20260101000001')
  })

  it('reports a shortfall instead of deleting protected versions', async () => {
    const { client, deleteItem } = fakeClient(itemsFor(VERSIONS))
    const result = await runPrune(client, {
      ...baseOptions,
      keepVersions: 5,
      manifests: manifestsMentioning()
    })

    expect(result.triggered).toBe(true)
    expect(result.deleted).toEqual([])
    expect(result.shortfallBytes).toBe(400)
    expect(deleteItem).not.toHaveBeenCalled()
  })

  it('deletes nothing in dry-run but reports the same plan', async () => {
    const { client, deleteItem } = fakeClient(itemsFor(VERSIONS))
    const result = await runPrune(client, {
      ...baseOptions,
      dryRun: true,
      manifests: manifestsMentioning()
    })

    expect(deleteItem).not.toHaveBeenCalled()
    expect(result.deleted.map(g => g.version)).toEqual(['20260101000001', '20260102000002'])
    expect(result.freedBytes).toBe(400)
  })

  it('counts storage outside the managed prefixes towards usage but never prunes it', async () => {
    const items: MonitorItem[] = [
      ...itemsFor(VERSIONS.slice(0, 3)),
      { id: 'other', path: '/legacy/big.exe', itemType: 'file', size: 300 }
    ]
    const { client, deleteItem } = fakeClient(items)

    const result = await runPrune(client, { ...baseOptions, manifests: manifestsMentioning() })

    expect(result.usageBytesBefore).toBe(900)
    expect(result.triggered).toBe(true)
    // Needs 300 B freed; only the two oldest managed versions are eligible.
    expect(result.deleted.map(g => g.version)).toEqual(['20260101000001', '20260102000002'])
    expect(deleteItem).not.toHaveBeenCalledWith('other')
  })

  it('still sees managed versions when the root listing omits the intermediate folders', async () => {
    const items = itemsFor(VERSIONS)
    const deleteItem = jest.fn().mockResolvedValue(undefined)
    const client = {
      walk: jest.fn(async (path: string) => (path === '/' ? [] : items)),
      deleteItem
    } as unknown as MonitorClient

    const result = await runPrune(client, { ...baseOptions, manifests: manifestsMentioning() })

    expect(result.usageBytesBefore).toBe(1000)
    expect(result.deleted.map(g => g.version)).toEqual(['20260101000001', '20260102000002'])
  })

  it('records a delete failure and keeps going until the target is met', async () => {
    const { client, deleteItem } = fakeClient(itemsFor(VERSIONS))
    deleteItem.mockImplementation(async (id: string) => {
      if (id === 'file:20260101000001') throw new Error('VirusTotal said no')
    })

    const result = await runPrune(client, { ...baseOptions, manifests: manifestsMentioning() })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/VirusTotal said no/)
    // The failed file still occupies its 200 B, so a third version goes to reach the target.
    expect(result.freedBytes).toBe(400)
    expect(result.deleted.map(g => g.version)).toEqual([
      '20260101000001',
      '20260102000002',
      '20260103000003'
    ])
  })
})
