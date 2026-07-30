import { Logger, silentLogger } from './logging'
import { ManifestIndex, emptyManifestIndex } from './manifests'
import { basename, isUnder, joinPath, normalizePath, segmentUnder } from './paths'
import { MonitorItem, PruneResult, RetentionDecision, VersionGroup } from './types'
import { formatBytes, formatDuration } from './format'
import { compareVersions, versionSpellings } from './version'
import { MonitorClient } from './vt-client'

export interface PruneOptions {
  /** Monitor folders whose `<prefix>/<version>/` children are prunable. */
  prefixes: string[]
  quotaBytes: number
  /** Fraction of quota at which pruning starts, e.g. 0.8. */
  highWatermark: number
  /** Fraction of quota to get back down to, e.g. 0.6. */
  targetWatermark: number
  /** Newest versions per prefix that are never deleted. */
  keepVersions: number
  manifests?: ManifestIndex
  pinnedVersions?: string[]
  dryRun: boolean
  /** `walk` sums the live item tree (accurate); `statistics` uses Monitor's daily snapshot. */
  usageSource: 'walk' | 'statistics'
  logger?: Logger
}

/** Buckets a flat item list into `<prefix>/<version>/` groups — the unit we delete. */
export function buildVersionGroups(items: MonitorItem[], prefixes: string[]): VersionGroup[] {
  const normalizedPrefixes = prefixes.map(normalizePath)
  const groups = new Map<string, VersionGroup>()

  for (const item of items) {
    for (const prefix of normalizedPrefixes) {
      const version = segmentUnder(item.path, prefix)
      if (!version) continue

      const key = `${prefix}/${version}`
      let group = groups.get(key)
      if (!group) {
        group = {
          prefix,
          version,
          path: joinPath(prefix, version),
          files: [],
          folders: [],
          sizeBytes: 0,
          creationDate: 0
        }
        groups.set(key, group)
      }

      if (item.itemType === 'folder') {
        group.folders.push(item)
      } else {
        group.files.push(item)
        group.sizeBytes += item.size
        if (item.creationDate && (group.creationDate === 0 || item.creationDate < group.creationDate)) {
          group.creationDate = item.creationDate
        }
      }
      break
    }
  }

  // The version folder itself is a child of the prefix, so `segmentUnder` skips it; pick it up here.
  for (const item of items) {
    if (item.itemType !== 'folder') continue
    const group = [...groups.values()].find(candidate => candidate.path === item.path)
    if (group && !group.folders.some(folder => folder.id === item.id)) {
      group.folders.push(item)
    }
  }

  return [...groups.values()]
}

/** Oldest first — the order in which groups become deletion candidates. */
export function sortOldestFirst(groups: VersionGroup[]): VersionGroup[] {
  return [...groups].sort((a, b) => {
    const byVersion = compareVersions(a.version, b.version)
    if (byVersion !== 0) return byVersion
    return a.creationDate - b.creationDate
  })
}

/**
 * Applies the retention policy: keep whatever a live channel manifest points at, keep the
 * newest `keepVersions` per prefix, keep anything explicitly pinned.
 */
export function decideRetention(
  groups: VersionGroup[],
  options: { keepVersions: number; manifests: ManifestIndex; pinnedVersions: string[] }
): RetentionDecision[] {
  const recent = new Set<string>()
  const byPrefix = new Map<string, VersionGroup[]>()
  for (const group of groups) {
    const list = byPrefix.get(group.prefix) ?? []
    list.push(group)
    byPrefix.set(group.prefix, list)
  }
  if (options.keepVersions > 0) {
    for (const list of byPrefix.values()) {
      for (const group of sortOldestFirst(list).slice(-options.keepVersions)) {
        recent.add(group.path)
      }
    }
  }

  const pinned = new Set(options.pinnedVersions.flatMap(version => versionSpellings(version)))

  return groups.map(group => {
    const tokens = [...versionSpellings(group.version), ...group.files.map(file => basename(file.path))]

    if (options.manifests.references(tokens)) {
      return { group, keep: true, reason: 'manifest' as const }
    }
    if (versionSpellings(group.version).some(spelling => pinned.has(spelling))) {
      return { group, keep: true, reason: 'pinned' as const }
    }
    if (recent.has(group.path)) {
      return { group, keep: true, reason: 'recent' as const }
    }
    return { group, keep: false }
  })
}

export async function runPrune(client: MonitorClient, options: PruneOptions): Promise<PruneResult> {
  const logger = options.logger ?? silentLogger
  const manifests = options.manifests ?? emptyManifestIndex
  const prefixes = options.prefixes.map(normalizePath)

  const { items, usageBytes } = await collectUsage(client, options, logger)
  const groups = buildVersionGroups(items, prefixes)
  const ratioBefore = options.quotaBytes > 0 ? usageBytes / options.quotaBytes : 0

  logger.info(
    `Monitor usage: ${formatBytes(usageBytes)} of ${formatBytes(options.quotaBytes)} ` +
      `(${(ratioBefore * 100).toFixed(1)}%), high watermark ${(options.highWatermark * 100).toFixed(0)}%`
  )
  logger.info(`Found ${groups.length} managed version folder(s) under ${prefixes.join(', ')}`)

  const decisions = decideRetention(groups, {
    keepVersions: options.keepVersions,
    manifests,
    pinnedVersions: options.pinnedVersions ?? []
  })
  for (const decision of decisions.filter(d => d.keep)) {
    logger.debug(`Keeping ${decision.group.path} (${decision.reason})`)
  }

  const result: PruneResult = {
    usageBytesBefore: usageBytes,
    usageBytesAfter: usageBytes,
    quotaBytes: options.quotaBytes,
    ratioBefore,
    ratioAfter: ratioBefore,
    triggered: ratioBefore >= options.highWatermark,
    dryRun: options.dryRun,
    deleted: [],
    kept: decisions.filter(decision => decision.keep),
    freedBytes: 0,
    shortfallBytes: 0,
    errors: []
  }

  if (!result.triggered) {
    logger.info(
      `Usage is below the ${(options.highWatermark * 100).toFixed(0)}% high watermark — nothing to prune.`
    )
    return result
  }

  const targetBytes = options.quotaBytes * options.targetWatermark
  const bytesToFree = Math.max(0, usageBytes - targetBytes)
  logger.info(
    `Need to free ${formatBytes(bytesToFree)} to reach the ` +
      `${(options.targetWatermark * 100).toFixed(0)}% target (${formatBytes(targetBytes)})`
  )

  const candidates = sortOldestFirst(decisions.filter(decision => !decision.keep).map(decision => decision.group))

  let freed = 0
  for (const group of candidates) {
    if (freed >= bytesToFree) break

    if (options.dryRun) {
      logger.info(`[dry-run] Would delete ${group.path} (${group.files.length} file(s), ${formatBytes(group.sizeBytes)})`)
      result.deleted.push(group)
      freed += group.sizeBytes
      continue
    }

    logger.info(`Deleting ${group.path} (${group.files.length} file(s), ${formatBytes(group.sizeBytes)})`)
    const deletedGroup = await deleteGroup(client, group, logger, result.errors)
    result.deleted.push(group)
    freed += deletedGroup
  }

  result.freedBytes = freed
  result.usageBytesAfter = usageBytes - freed
  result.ratioAfter = options.quotaBytes > 0 ? result.usageBytesAfter / options.quotaBytes : 0
  result.shortfallBytes = Math.max(0, bytesToFree - freed)

  if (result.shortfallBytes > 0) {
    logger.warning(
      `Could not reach the target watermark: ${formatBytes(result.shortfallBytes)} still over. ` +
        'Everything else is protected by the retention policy (manifest-referenced, pinned, or one of the ' +
        `${options.keepVersions} most recent versions).`
    )
  }

  logger.info(
    `${options.dryRun ? '[dry-run] Would free' : 'Freed'} ${formatBytes(freed)} — ` +
      `usage now ${formatBytes(result.usageBytesAfter)} (${(result.ratioAfter * 100).toFixed(1)}%)`
  )
  return result
}

/** Deletes a version's files (then its folders) and returns the bytes actually freed. */
async function deleteGroup(
  client: MonitorClient,
  group: VersionGroup,
  logger: Logger,
  errors: string[]
): Promise<number> {
  let freed = 0
  for (const file of group.files) {
    try {
      await client.deleteItem(file.id)
      freed += file.size
      logger.debug(`Deleted ${file.path}`)
    } catch (error) {
      const message = `Failed to delete ${file.path}: ${(error as Error).message}`
      logger.warning(message)
      errors.push(message)
    }
  }

  // Deepest first so a parent is only removed once its children are gone.
  const folders = [...group.folders].sort((a, b) => b.path.length - a.path.length)
  for (const folder of folders) {
    try {
      await client.deleteItem(folder.id)
      logger.debug(`Deleted folder ${folder.path}`)
    } catch (error) {
      // An empty folder left behind costs nothing; don't fail the job over it.
      logger.warning(`Failed to delete folder ${folder.path}: ${(error as Error).message}`)
    }
  }
  return freed
}

async function collectUsage(
  client: MonitorClient,
  options: PruneOptions,
  logger: Logger
): Promise<{ items: MonitorItem[]; usageBytes: number }> {
  if (options.usageSource === 'statistics') {
    const stats = await client.getStatistics()
    if (!stats) {
      throw new Error('Monitor returned no statistics; use usage-source: walk to measure storage directly.')
    }
    logger.info(
      `Storage from /monitor/statistics: ${formatBytes(stats.storageBytesCount)} across ` +
        `${stats.storageFilesCount} file(s), as of ${new Date(stats.date * 1000).toISOString()}`
    )
    const items = dedupe((await Promise.all(options.prefixes.map(prefix => client.walk(prefix)))).flat())
    return { items, usageBytes: stats.storageBytesCount }
  }

  // The quota is account-wide, so usage is measured from the Monitor root even though only
  // items under the managed prefixes are prunable. The managed prefixes are then walked
  // directly and merged in: a root listing that does not expose the intermediate folders
  // would otherwise report zero usage and silently disable pruning.
  logger.info(
    'Enumerating existing items in VirusTotal Monitor storage to measure usage. Monitor has no ' +
      'recursive listing, so this is one request per folder and is usually the slowest part of the run.'
  )
  const startedAt = Date.now()

  logger.info('Walking the Monitor root (/) for account-wide usage')
  const fromRoot = await client.walk('/')

  logger.info(`Walking the managed prefix(es): ${options.prefixes.join(', ')}`)
  const fromPrefixes = (await Promise.all(options.prefixes.map(prefix => client.walk(prefix)))).flat()
  const items = dedupe([...fromRoot, ...fromPrefixes])

  const fileCount = items.filter(item => item.itemType === 'file').length
  logger.info(
    `Enumerated ${items.length} item(s) — ${fileCount} file(s), ` +
      `${items.length - fileCount} folder(s) — in ${formatDuration(Date.now() - startedAt)}`
  )

  const usageBytes = items
    .filter(item => item.itemType === 'file')
    .reduce((total, item) => total + item.size, 0)

  const unmanaged = items
    .filter(item => item.itemType === 'file')
    .filter(item => !options.prefixes.some(prefix => isUnder(item.path, prefix)))
    .reduce((total, item) => total + item.size, 0)
  if (unmanaged > 0) {
    logger.info(`${formatBytes(unmanaged)} sits outside the managed prefixes and will never be pruned.`)
  }

  return { items, usageBytes }
}

function dedupe(items: MonitorItem[]): MonitorItem[] {
  const byId = new Map<string, MonitorItem>()
  for (const item of items) byId.set(item.id, item)
  return [...byId.values()]
}
