import { stat } from 'node:fs/promises'

import { formatBytes } from './format'
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

    // Hashing is what makes a re-run idempotent: identical bytes are never uploaded twice.
    logger.debug(`Hashing ${localPath} (${formatBytes(stats.size)}) to compare against Monitor`)
    const sha256 = await sha256File(localPath)
    logger.debug(`  sha256 ${sha256}`)
    const match = existing.get(remotePath)

    if (!match) {
      logger.debug(`  ${remotePath} is not in Monitor yet — will upload`)
      plan.push({ localPath, remotePath, size: stats.size, sha256, action: 'create' })
    } else if (match.sha256 && match.sha256.toLowerCase() === sha256) {
      logger.debug(`  ${remotePath} already holds these exact bytes — will skip`)
      plan.push({ localPath, remotePath, size: stats.size, sha256, action: 'skip', existingItemId: match.id })
    } else {
      logger.debug(
        `  ${remotePath} exists with a different sha256 (${match.sha256 ?? 'unknown'}) — ` +
          'will overwrite that item in place rather than create a second copy'
      )
      plan.push({ localPath, remotePath, size: stats.size, sha256, action: 'overwrite', existingItemId: match.id })
    }
  }

  const counts = plan.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.action] = (acc[entry.action] ?? 0) + 1
    return acc
  }, {})
  logger.info(
    `Plan: ${counts.create ?? 0} to upload, ${counts.overwrite ?? 0} to overwrite, ${counts.skip ?? 0} unchanged`
  )
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
  logger.info(`Checking what ${remoteDir} already holds, so a re-run does not duplicate items`)
  try {
    for (const item of await client.listFolder(remoteDir)) {
      if (item.itemType === 'file') byPath.set(item.path, item)
    }
    logger.info(`  ${byPath.size} file(s) already present`)
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

