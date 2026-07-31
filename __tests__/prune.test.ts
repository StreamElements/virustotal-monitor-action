import { ManifestIndex } from '../src/manifests'
import { buildPruneGroups, decideRetention, runPrune, sortOldestFirst } from '../src/prune'
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

describe('buildPruneGroups', () => {
  it('groups files and the version folder under one entry per version', () => {
    const groups = buildPruneGroups(itemsFor(['20260101000001']), [PREFIX])

    expect(groups).toHaveLength(1)
    expect(groups[0].path).toBe(`${PREFIX}/20260101000001`)
    expect(groups[0].files).toHaveLength(1)
    expect(groups[0].folders.map(f => f.path)).toEqual([`${PREFIX}/20260101000001`])
    expect(groups[0].sizeBytes).toBe(200)
    expect(groups[0].creationDate).toBe(1000)
  })

  it('ignores items outside the managed prefixes', () => {
    const items: MonitorItem[] = [
      ...itemsFor(['20260101000001']),
      { id: 'other', path: '/somewhere/else/x.exe', itemType: 'file', size: 999 }
    ]

    const groups = buildPruneGroups(items, [PREFIX])
    expect(groups).toHaveLength(1)
    expect(groups[0].sizeBytes).toBe(200)
  })

  it('treats a loose file in the prefix root as its own prunable entry', () => {
    // It occupies quota like anything else, so prune has to be able to reach it.
    const items: MonitorItem[] = [
      ...itemsFor(['20260101000001']),
      { id: 'loose', path: `${PREFIX}/README.txt`, itemType: 'file', size: 5, creationDate: 900 }
    ]

    const groups = buildPruneGroups(items, [PREFIX])
    const loose = groups.find(group => group.name === 'README.txt')

    expect(loose).toBeDefined()
    expect(loose?.versionLike).toBe(false)
    expect(loose?.path).toBe(`${PREFIX}/README.txt`)
    expect(loose?.sizeBytes).toBe(5)
  })

  it('groups a folder that does not follow the version convention with its contents', () => {
    const items: MonitorItem[] = [
      { id: 'f:scratch', path: `${PREFIX}/scratch`, itemType: 'folder', size: 0, creationDate: 900 },
      { id: 'a', path: `${PREFIX}/scratch/one.exe`, itemType: 'file', size: 70, creationDate: 900 },
      { id: 'b', path: `${PREFIX}/scratch/nested/two.exe`, itemType: 'file', size: 30, creationDate: 901 }
    ]

    const groups = buildPruneGroups(items, [PREFIX])

    expect(groups).toHaveLength(1)
    expect(groups[0].name).toBe('scratch')
    expect(groups[0].versionLike).toBe(false)
    expect(groups[0].files).toHaveLength(2)
    expect(groups[0].sizeBytes).toBe(100)
    expect(groups[0].folders.map(f => f.id)).toEqual(['f:scratch'])
  })
})

describe('sortOldestFirst', () => {
  it('orders by version, oldest first', () => {
    const groups = buildPruneGroups(itemsFor([...VERSIONS].reverse()), [PREFIX])
    expect(sortOldestFirst(groups).map(g => g.name)).toEqual(VERSIONS)
  })

  it('puts entries that are not versions ahead of every release', () => {
    // They are not part of the release history, so they should go before the oldest release
    // rather than sorting alphabetically among them.
    const items: MonitorItem[] = [
      ...itemsFor(VERSIONS.slice(0, 2)),
      { id: 'loose', path: `${PREFIX}/README.txt`, itemType: 'file', size: 5, creationDate: 5000 },
      { id: 'junk', path: `${PREFIX}/scratch/x.exe`, itemType: 'file', size: 5, creationDate: 4000 }
    ]

    const ordered = sortOldestFirst(buildPruneGroups(items, [PREFIX])).map(g => g.name)

    // Non-versions first, by creation date; releases after, by version.
    expect(ordered).toEqual(['scratch', 'README.txt', '20260101000001', '20260102000002'])
  })
})

describe('decideRetention', () => {
  const groups = buildPruneGroups(itemsFor(VERSIONS), [PREFIX])

  it('keeps the newest N versions per prefix', () => {
    const decisions = decideRetention(groups, {
      keepVersions: 2,
      manifests: manifestsMentioning(),
      pinnedVersions: []
    })
    const kept = decisions.filter(d => d.keep).map(d => d.group.name)
    expect(kept).toEqual(['20260104000004', '20260105000005'])
    expect(decisions.filter(d => d.keep).every(d => d.reason === 'recent')).toBe(true)
  })

  it('keeps anything a channel manifest still points at, however old', () => {
    const manifests = manifestsMentioning(
      'package_url=https://cdn/obs-streamelements-setup-20260101000001.exe'
    )
    const decisions = decideRetention(groups, { keepVersions: 0, manifests, pinnedVersions: [] })

    const oldest = decisions.find(d => d.group.name === '20260101000001')
    expect(oldest?.keep).toBe(true)
    expect(oldest?.reason).toBe('manifest')
  })

  it('does not let stray entries occupy the keep-newest-N slots', () => {
    // The whole point of keep-versions is protecting recent releases; junk must not crowd them
    // out and get a real release deleted in its place.
    const items: MonitorItem[] = [
      ...itemsFor(VERSIONS.slice(0, 3)),
      { id: 'j1', path: `${PREFIX}/scratch/x.exe`, itemType: 'file', size: 5, creationDate: 9000 },
      { id: 'j2', path: `${PREFIX}/tmp.bin`, itemType: 'file', size: 5, creationDate: 9001 }
    ]
    const decisions = decideRetention(buildPruneGroups(items, [PREFIX]), {
      keepVersions: 2,
      manifests: manifestsMentioning(),
      pinnedVersions: []
    })

    const kept = decisions.filter(d => d.keep).map(d => d.group.name)
    expect(kept).toEqual(['20260102000002', '20260103000003'])
  })

  it('keeps a stray entry a manifest happens to reference', () => {
    const items: MonitorItem[] = [
      ...itemsFor(VERSIONS.slice(0, 1)),
      { id: 'loose', path: `${PREFIX}/hotfix-installer.exe`, itemType: 'file', size: 5, creationDate: 100 }
    ]
    const decisions = decideRetention(buildPruneGroups(items, [PREFIX]), {
      keepVersions: 0,
      manifests: manifestsMentioning('package_url=https://cdn/hotfix-installer.exe'),
      pinnedVersions: []
    })

    const loose = decisions.find(d => d.group.name === 'hotfix-installer.exe')
    expect(loose?.keep).toBe(true)
    expect(loose?.reason).toBe('manifest')
  })

  it('keeps explicitly pinned versions', () => {
    const decisions = decideRetention(groups, {
      keepVersions: 0,
      manifests: manifestsMentioning(),
      pinnedVersions: ['20260102000002']
    })

    const pinned = decisions.find(d => d.group.name === '20260102000002')
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
    expect(result.deleted.map(g => g.name)).toEqual(['20260101000001', '20260102000002'])
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

    expect(result.deleted.map(g => g.name)).toEqual(['20260102000002', '20260103000003'])
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
    expect(result.deleted.map(g => g.name)).toEqual(['20260101000001', '20260102000002'])
    expect(result.freedBytes).toBe(400)
  })

  it('enumerates from the managed prefixes, never from the Monitor root', async () => {
    // Walking / would descend into these same prefixes, so listing both pays for the managed
    // subtree twice — the most expensive thing a paced run can do.
    const { client } = fakeClient(itemsFor(VERSIONS.slice(0, 3)))

    await runPrune(client, { ...baseOptions, manifests: manifestsMentioning() })

    expect(client.walk).toHaveBeenCalledTimes(1)
    expect(client.walk).toHaveBeenCalledWith(PREFIX)
    expect(client.walk).not.toHaveBeenCalledWith('/')
  })

  it('walks each managed prefix once', async () => {
    const other = '/obs-streamelements/macos'
    const { client } = fakeClient(itemsFor(VERSIONS.slice(0, 3)))

    await runPrune(client, {
      ...baseOptions,
      prefixes: [PREFIX, other],
      manifests: manifestsMentioning()
    })

    expect(client.walk).toHaveBeenCalledTimes(2)
    expect(client.walk).toHaveBeenCalledWith(PREFIX)
    expect(client.walk).toHaveBeenCalledWith(other)
  })

  it('warns when the account holds storage the managed prefixes cannot reach', async () => {
    // Only the prefixes are enumerated now, so storage elsewhere counts against the same quota
    // while being invisible here. One statistics call surfaces the gap.
    const warnings: string[] = []
    const client = {
      walk: jest.fn().mockResolvedValue(itemsFor(VERSIONS.slice(0, 3))),
      deleteItem: jest.fn(),
      getStatistics: jest.fn().mockResolvedValue({ date: 1, storageBytesCount: 900, storageFilesCount: 9 })
    } as unknown as MonitorClient

    await runPrune(client, {
      ...baseOptions,
      manifests: manifestsMentioning(),
      logger: { debug: () => undefined, info: () => undefined, warning: m => warnings.push(m) }
    })

    // 600 B managed of 900 B account-wide: 300 B lives somewhere we cannot prune.
    expect(warnings.join('\n')).toMatch(/900 B stored account-wide, but only 600 B/)
    expect(warnings.join('\n')).toMatch(/300 B counts against the same quota/)
  })

  it('stays quiet when the account-wide figure matches what was enumerated', async () => {
    const warnings: string[] = []
    const client = {
      walk: jest.fn().mockResolvedValue(itemsFor(VERSIONS.slice(0, 3))),
      deleteItem: jest.fn(),
      getStatistics: jest.fn().mockResolvedValue({ date: 1, storageBytesCount: 610, storageFilesCount: 3 })
    } as unknown as MonitorClient

    await runPrune(client, {
      ...baseOptions,
      manifests: manifestsMentioning(),
      logger: { debug: () => undefined, info: () => undefined, warning: m => warnings.push(m) }
    })

    // A daily snapshot will not match to the byte; only a real gap is worth reporting.
    expect(warnings).toEqual([])
  })

  it('carries on when the account-wide cross-check is unavailable', async () => {
    const client = {
      walk: jest.fn().mockResolvedValue(itemsFor(VERSIONS)),
      deleteItem: jest.fn().mockResolvedValue(undefined),
      getStatistics: jest.fn().mockRejectedValue(new Error('no statistics for this account'))
    } as unknown as MonitorClient

    const result = await runPrune(client, { ...baseOptions, manifests: manifestsMentioning() })

    expect(result.usageBytesBefore).toBe(1000)
    expect(result.deleted.map(g => g.name)).toEqual(['20260101000001', '20260102000002'])
  })

  it('triggers on the file ceiling even when bytes are nowhere near the limit', async () => {
    // The exact production trap: a quota-bytes far above reality means the byte ratio never
    // moves, so without a file dimension prune stays asleep while uploads fail with
    // QuotaExceededError.
    const { client, deleteItem } = fakeClient(itemsFor(VERSIONS))
    const result = await runPrune(client, {
      ...baseOptions,
      quotaBytes: 100 * 1024 * 1024 * 1024, // 100 GiB — byte ratio ~0%
      quotaFiles: 5, // but 5 files of 5 allowed
      manifests: manifestsMentioning()
    })

    expect(result.ratioBefore).toBeLessThan(0.01)
    expect(result.fileRatioBefore).toBe(1)
    expect(result.triggered).toBe(true)
    // Down to 60% of 5 files = 3, so two files (two versions) go.
    expect(result.freedFiles).toBe(2)
    expect(result.fileCountAfter).toBe(3)
    expect(deleteItem).toHaveBeenCalledWith('file:20260101000001')
  })

  it('keeps deleting until both dimensions are under target', async () => {
    const { client } = fakeClient(itemsFor(VERSIONS))
    const result = await runPrune(client, {
      ...baseOptions,
      quotaFiles: 5,
      manifests: manifestsMentioning()
    })

    // Bytes alone would stop after 2 versions (400 of 1000 B); files need 2 gone as well, so
    // the binding constraint is whichever is worse — here they agree.
    expect(result.freedBytes).toBe(400)
    expect(result.freedFiles).toBe(2)
    expect(result.fileRatioAfter).toBeCloseTo(0.6)
  })

  it('leaves the file dimension out entirely when quota-files is 0', async () => {
    const { client } = fakeClient(itemsFor(VERSIONS.slice(0, 3)))
    const result = await runPrune(client, { ...baseOptions, manifests: manifestsMentioning() })

    expect(result.quotaFiles).toBe(0)
    expect(result.fileRatioBefore).toBe(0)
    expect(result.fileCountBefore).toBe(3)
    expect(result.triggered).toBe(false)
  })

  it('purges stray entries before touching any release', async () => {
    // 5 x 200 B of releases plus 100 B of junk = 1100 B; freeing 500 B gets under target.
    const items: MonitorItem[] = [
      ...itemsFor(VERSIONS),
      { id: 'f:scratch', path: `${PREFIX}/scratch`, itemType: 'folder', size: 0, creationDate: 900 },
      { id: 'j1', path: `${PREFIX}/scratch/x.exe`, itemType: 'file', size: 60, creationDate: 900 },
      { id: 'j2', path: `${PREFIX}/leftover.bin`, itemType: 'file', size: 40, creationDate: 901 }
    ]
    const { client, deleteItem } = fakeClient(items)

    const result = await runPrune(client, { ...baseOptions, manifests: manifestsMentioning() })

    expect(result.deleted.map(g => g.name)).toEqual([
      'scratch',
      'leftover.bin',
      '20260101000001',
      '20260102000002'
    ])
    expect(result.freedBytes).toBe(500)
    // The stray folder's own item is removed after its contents.
    expect(deleteItem).toHaveBeenCalledWith('j1')
    expect(deleteItem).toHaveBeenCalledWith('f:scratch')
    expect(deleteItem).toHaveBeenCalledWith('j2')
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
    expect(result.deleted.map(g => g.name)).toEqual([
      '20260101000001',
      '20260102000002',
      '20260103000003'
    ])
  })
})
