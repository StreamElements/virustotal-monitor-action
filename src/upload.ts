import { stat } from 'node:fs/promises'

import { sha256File } from './hash'
import { Logger, silentLogger } from './logging'
import { basename, joinPath, normalizePath } from './paths'
import { MonitorItem, UploadPlanEntry, UploadResult } from './types'
import { MonitorApiError, MonitorClient } from './vt-client'

export interface UploadOptions {
  /** Local paths of the artifacts to upload. */
  files: string[]
  /** Monitor folder they belong in, e.g. `/obs-streamelements/windows/20260729000746`. */
  remoteDir: string
  dryRun: boolean
  logger?: Logger
}

/**
 * Works out, per file, whether it is new, changed, or already in Monitor byte-for-byte.
 * Re-running a release therefore uploads nothing rather than duplicating items.
 */
export async function planUpload(client: MonitorClient, options: UploadOptions): Promise<UploadPlanEntry[]> {
  const logger = options.logger ?? silentLogger
  const remoteDir = normalizePath(options.remoteDir)
  const existing = await listExisting(client, remoteDir, logger)

  const plan: UploadPlanEntry[] = []
  for (const localPath of options.files) {
    const stats = await stat(localPath)
    if (!stats.isFile()) {
      throw new Error(`Not a file: ${localPath}`)
    }
    const remotePath = joinPath(remoteDir, basename(localPath))
    const sha256 = await sha256File(localPath)
    const match = existing.get(remotePath)

    if (!match) {
      plan.push({ localPath, remotePath, size: stats.size, sha256, action: 'create' })
    } else if (match.sha256 && match.sha256.toLowerCase() === sha256) {
      plan.push({ localPath, remotePath, size: stats.size, sha256, action: 'skip', existingItemId: match.id })
    } else {
      plan.push({ localPath, remotePath, size: stats.size, sha256, action: 'overwrite', existingItemId: match.id })
    }
  }
  return plan
}

export async function runUpload(client: MonitorClient, options: UploadOptions): Promise<UploadResult> {
  const logger = options.logger ?? silentLogger
  const plan = await planUpload(client, options)

  const uploaded: UploadPlanEntry[] = []
  const skipped: UploadPlanEntry[] = []
  let bytesUploaded = 0

  for (const entry of plan) {
    if (entry.action === 'skip') {
      logger.info(`Skipping ${entry.remotePath} — already in Monitor with sha256 ${entry.sha256}`)
      skipped.push(entry)
      continue
    }

    const verb = entry.action === 'overwrite' ? 'Overwriting' : 'Uploading'
    if (options.dryRun) {
      logger.info(`[dry-run] ${verb} ${entry.remotePath} (${formatBytes(entry.size)})`)
      uploaded.push(entry)
      bytesUploaded += entry.size
      continue
    }

    logger.info(`${verb} ${entry.remotePath} (${formatBytes(entry.size)})`)
    const id = await client.uploadFile({
      localPath: entry.localPath,
      remotePath: entry.remotePath,
      size: entry.size,
      existingItemId: entry.action === 'overwrite' ? entry.existingItemId : undefined
    })
    logger.info(`Uploaded ${entry.remotePath} as ${id}`)
    uploaded.push(entry)
    bytesUploaded += entry.size
  }

  return { uploaded, skipped, bytesUploaded }
}

async function listExisting(
  client: MonitorClient,
  remoteDir: string,
  logger: Logger
): Promise<Map<string, MonitorItem>> {
  const byPath = new Map<string, MonitorItem>()
  try {
    for (const item of await client.listFolder(remoteDir)) {
      if (item.itemType === 'file') byPath.set(item.path, item)
    }
  } catch (error) {
    // A first-ever upload for this version has no folder yet; Monitor answers 404.
    if (error instanceof MonitorApiError && error.statusCode === 404) {
      logger.debug(`${remoteDir} does not exist yet — treating as empty`)
      return byPath
    }
    throw error
  }
  return byPath
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(2)} ${units[unit]}`
}
