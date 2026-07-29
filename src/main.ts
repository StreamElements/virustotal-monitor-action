import { stat } from 'node:fs/promises'

import * as core from '@actions/core'
import * as glob from '@actions/glob'

import { ActionConfig, parseConfig } from './config'
import { Logger } from './logging'
import { ManifestIndex, emptyManifestIndex, fetchManifests } from './manifests'
import { runPrune } from './prune'
import { PruneResult, UploadResult } from './types'
import { formatBytes, runUpload } from './upload'
import { MonitorClient } from './vt-client'

const logger: Logger = {
  debug: message => core.debug(message),
  info: message => core.info(message),
  warning: message => core.warning(message)
}

export async function run(): Promise<void> {
  const config = parseConfig(name => core.getInput(name))
  core.setSecret(config.apiKey)

  const client = new MonitorClient({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    logger
  })

  if (config.dryRun) {
    core.info('Running in dry-run mode — no uploads and no deletions will be performed.')
  }

  let uploadResult: UploadResult | undefined
  let pruneResult: PruneResult | undefined

  if (config.mode === 'upload' || config.mode === 'upload-and-prune') {
    const files = await resolveFiles(config.filePatterns)
    core.info(`Uploading ${files.length} file(s) to ${config.remoteDir}`)
    uploadResult = await runUpload(client, {
      files,
      remoteDir: config.remoteDir,
      dryRun: config.dryRun,
      logger
    })
  }

  if (config.mode === 'prune' || config.mode === 'upload-and-prune') {
    const manifests = await loadManifests(config)
    pruneResult = await runPrune(client, {
      prefixes: config.managedPrefixes,
      quotaBytes: config.quotaBytes,
      highWatermark: config.highWatermark,
      targetWatermark: config.targetWatermark,
      keepVersions: config.keepVersions,
      manifests,
      pinnedVersions: config.pinnedVersions,
      dryRun: config.dryRun,
      usageSource: config.usageSource,
      logger
    })
  }

  setOutputs(uploadResult, pruneResult)
  try {
    await writeSummary(config, uploadResult, pruneResult)
  } catch (error) {
    // Outside a real runner there is no step summary file; that must not fail the run.
    core.debug(`Could not write the job summary: ${(error as Error).message}`)
  }

  if (pruneResult && pruneResult.errors.length > 0) {
    throw new Error(`${pruneResult.errors.length} item(s) failed to delete:\n${pruneResult.errors.join('\n')}`)
  }
}

async function loadManifests(config: ActionConfig): Promise<ManifestIndex> {
  if (config.manifestUrls.length > 0) {
    core.info(`Reading ${config.manifestUrls.length} channel manifest(s) to determine what is still live`)
    return fetchManifests(config.manifestUrls, { logger })
  }

  // Deleting without knowing what the channels point at is the one mistake we cannot undo.
  if (!config.dryRun) {
    throw new Error(
      'manifest-urls is empty, so live releases cannot be identified. Pass the channel manifest URLs ' +
        '(qa/beta/latest/stable), or run with dry-run: true to preview the policy.'
    )
  }
  core.warning('No manifest-urls configured — dry-run cannot verify which releases are still live.')
  return emptyManifestIndex
}

/** Expands the `files` globs, failing loudly when a pattern matches nothing. */
async function resolveFiles(patterns: string[]): Promise<string[]> {
  const resolved: string[] = []
  const seen = new Set<string>()

  for (const pattern of patterns) {
    const globber = await glob.create(pattern, { matchDirectories: false })
    const matches = await globber.glob()
    const files: string[] = []
    for (const match of matches) {
      const stats = await stat(match)
      if (stats.isFile()) files.push(match)
    }
    if (files.length === 0) {
      throw new Error(`No files matched "${pattern}"`)
    }
    for (const file of files) {
      if (!seen.has(file)) {
        seen.add(file)
        resolved.push(file)
      }
    }
  }

  return resolved
}

function setOutputs(uploadResult: UploadResult | undefined, pruneResult: PruneResult | undefined): void {
  core.setOutput('uploaded-count', uploadResult ? uploadResult.uploaded.length : 0)
  core.setOutput('skipped-count', uploadResult ? uploadResult.skipped.length : 0)
  core.setOutput('uploaded-paths', JSON.stringify(uploadResult ? uploadResult.uploaded.map(e => e.remotePath) : []))

  core.setOutput('prune-triggered', pruneResult ? pruneResult.triggered : false)
  core.setOutput('deleted-count', pruneResult ? pruneResult.deleted.length : 0)
  core.setOutput('deleted-versions', JSON.stringify(pruneResult ? pruneResult.deleted.map(g => g.path) : []))
  core.setOutput('freed-bytes', pruneResult ? pruneResult.freedBytes : 0)
  core.setOutput('usage-bytes', pruneResult ? pruneResult.usageBytesAfter : 0)
  core.setOutput('usage-ratio', pruneResult ? pruneResult.ratioAfter.toFixed(4) : '0')
}

async function writeSummary(
  config: ActionConfig,
  uploadResult: UploadResult | undefined,
  pruneResult: PruneResult | undefined
): Promise<void> {
  const summary = core.summary.addHeading(`VirusTotal Monitor${config.dryRun ? ' (dry run)' : ''}`, 2)

  if (uploadResult) {
    summary.addHeading('Upload', 3)
    if (uploadResult.uploaded.length === 0 && uploadResult.skipped.length === 0) {
      summary.addRaw('No files to upload.\n', true)
    } else {
      summary.addTable([
        [
          { data: 'Path', header: true },
          { data: 'Size', header: true },
          { data: 'Action', header: true }
        ],
        ...[...uploadResult.uploaded, ...uploadResult.skipped].map(entry => [
          entry.remotePath,
          formatBytes(entry.size),
          entry.action
        ])
      ])
    }
  }

  if (pruneResult) {
    summary.addHeading('Storage', 3)
    summary.addRaw(
      [
        `- Usage before: **${formatBytes(pruneResult.usageBytesBefore)}** of ` +
          `${formatBytes(pruneResult.quotaBytes)} (${(pruneResult.ratioBefore * 100).toFixed(1)}%)`,
        `- High watermark: ${(config.highWatermark * 100).toFixed(0)}% · target ` +
          `${(config.targetWatermark * 100).toFixed(0)}% · keep ${config.keepVersions} version(s) per prefix`,
        `- Prune triggered: **${pruneResult.triggered ? 'yes' : 'no'}**`,
        `- ${pruneResult.dryRun ? 'Would free' : 'Freed'}: **${formatBytes(pruneResult.freedBytes)}** ` +
          `→ ${formatBytes(pruneResult.usageBytesAfter)} (${(pruneResult.ratioAfter * 100).toFixed(1)}%)`
      ].join('\n') + '\n',
      true
    )

    if (pruneResult.deleted.length > 0) {
      summary.addHeading(pruneResult.dryRun ? 'Would delete' : 'Deleted', 3)
      summary.addTable([
        [
          { data: 'Version folder', header: true },
          { data: 'Files', header: true },
          { data: 'Size', header: true }
        ],
        ...pruneResult.deleted.map(group => [
          group.path,
          String(group.files.length),
          formatBytes(group.sizeBytes)
        ])
      ])
    }

    if (pruneResult.shortfallBytes > 0) {
      summary.addRaw(
        `\n> Still **${formatBytes(pruneResult.shortfallBytes)}** above target — everything else is protected.\n`,
        true
      )
    }
  }

  await summary.write()
}

async function main(): Promise<void> {
  const onError = core.getInput('on-error').trim().toLowerCase() || 'fail'
  try {
    await run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (onError === 'warn') {
      core.warning(`VirusTotal Monitor step failed (on-error: warn): ${message}`)
      return
    }
    core.setFailed(message)
  }
}

void main()
