import { stat } from 'node:fs/promises'

import * as core from '@actions/core'
import * as glob from '@actions/glob'

import { ActionConfig, parseConfig } from './config'
import { Logger } from './logging'
import { ManifestIndex, emptyManifestIndex, fetchManifests } from './manifests'
import { runPrune } from './prune'
import { RateLimiter } from './rate-limiter'
import { PruneResult, UploadResult } from './types'
import { formatBytes, formatDuration } from './format'
import { runUpload } from './upload'
import { MonitorClient } from './vt-client'

/**
 * `verbose: true` routes debug output to info so it shows without the repository-level
 * ACTIONS_STEP_DEBUG secret, which not everyone can set.
 */
let verbose = false

const logger: Logger = {
  debug: message => (verbose ? core.info(message) : core.debug(message)),
  info: message => core.info(message),
  warning: message => core.warning(message)
}

export async function run(): Promise<void> {
  const config = parseConfig(name => core.getInput(name))
  core.setSecret(config.apiKey)
  verbose = config.verbose

  describeRun(config)

  const rateLimiter = new RateLimiter(config.rateLimits, { logger })
  const client = new MonitorClient({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    logger,
    rateLimiter
  })

  await seedRateLimiter(client, rateLimiter, config)

  let uploadResult: UploadResult | undefined
  let pruneResult: PruneResult | undefined
  const startedAt = Date.now()

  if (config.mode === 'upload' || config.mode === 'upload-and-prune') {
    core.info('')
    core.info(`== Upload → ${config.remoteDir} ==`)
    const files = await resolveFiles(config.filePatterns)
    core.info(`${files.length} local file(s) matched the configured patterns`)
    uploadResult = await runUpload(client, {
      files,
      remoteDir: config.remoteDir,
      dryRun: config.dryRun,
      logger
    })
  }

  if (config.mode === 'prune' || config.mode === 'upload-and-prune') {
    core.info('')
    core.info('== Prune ==')
    const manifests = await loadManifests(config)
    pruneResult = await runPrune(client, {
      prefixes: config.managedPrefixes,
      quotaBytes: config.quotaBytes,
      quotaFiles: config.quotaFiles,
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

  const rateStats = rateLimiter.stats()
  core.info('')
  core.info('== Done ==')
  core.info(
    `${rateStats.requests} VirusTotal API request(s) in ${formatDuration(Date.now() - startedAt)}` +
      (rateStats.waitedMs > 0 ? `, of which ${formatDuration(rateStats.waitedMs)} was rate-limit waiting` : '')
  )
  const headroom = Object.entries(rateStats.remaining)
    .map(([window, left]) => `${left} per ${window}`)
    .join(', ')
  if (headroom) core.info(`Requests still available: ${headroom}`)
  core.setOutput('api-requests', rateStats.requests)

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

/** States up front what this run will do and under what settings, so the log explains itself. */
function describeRun(config: ActionConfig): void {
  core.info(`VirusTotal Monitor — mode: ${config.mode}${config.dryRun ? ', DRY RUN' : ''}`)

  if (config.dryRun) {
    core.info('Dry run: every decision is logged, nothing is uploaded and nothing is deleted.')
  }
  if (config.mode !== 'prune') {
    core.info(`Uploading into ${config.remoteDir}; identical files already there are skipped.`)
  }
  if (config.mode !== 'upload') {
    core.info(
      `Pruning ${config.managedPrefixes.join(', ')} once usage passes ` +
        `${(config.highWatermark * 100).toFixed(0)}% of ${formatBytes(config.quotaBytes)}` +
        `${config.quotaFiles > 0 ? ` or ${config.quotaFiles} file(s)` : ''}, ` +
        `down to ${(config.targetWatermark * 100).toFixed(0)}%. Keeping the newest ` +
        `${config.keepVersions} version(s) per prefix plus anything a live manifest references.`
    )
    if (config.quotaFiles === 0) {
      core.info(
        'No quota-files set: only the byte ceiling can trigger a prune. VirusTotal also limits ' +
          'the number of files and reports QuotaExceededError for either.'
      )
    }
  }
  core.info(
    `Rate limits: ${describeLimit(config.rateLimits.perMinute, 'minute')}, ` +
      `${describeLimit(config.rateLimits.perDay, 'day')}, ` +
      `${describeLimit(config.rateLimits.perMonth, 'month')}. ` +
      `Failures ${config.onError === 'warn' ? 'warn only' : 'fail the job'}.`
  )
  if (config.rateLimits.perMinute > 0 && config.rateLimits.perMinute <= 10) {
    core.info(
      `At ${config.rateLimits.perMinute} request(s) per minute expect roughly ` +
        `${Math.round(60 / config.rateLimits.perMinute)}s between calls, so listing many folders takes a while.`
    )
  }
  if (!verbose) {
    core.info('Set verbose: true (or ACTIONS_STEP_DEBUG) for per-request logging.')
  }
}

function describeLimit(limit: number, window: string): string {
  return limit > 0 ? `${limit}/${window}` : `${window} unlimited`
}

/**
 * Folds VirusTotal's own usage figures into the limiter. Without this the daily and monthly
 * budgets only bound the current run, since each job starts with an empty history.
 */
async function seedRateLimiter(
  client: MonitorClient,
  rateLimiter: RateLimiter,
  config: ActionConfig
): Promise<void> {
  const tracksLongWindows = config.rateLimits.perDay > 0 || config.rateLimits.perMonth > 0
  if (!config.seedRateLimitFromApi || !tracksLongWindows) return

  try {
    const quotas = await client.getApiQuotas()
    rateLimiter.seed({ day: quotas.dailyUsed, month: quotas.monthlyUsed })
    if (quotas.dailyUsed !== undefined) {
      core.info(
        `VirusTotal reports ${quotas.dailyUsed} API request(s) used today` +
          `${quotas.dailyAllowed !== undefined ? ` of ${quotas.dailyAllowed} allowed` : ''}`
      )
    }
  } catch (error) {
    // Not every key can read its own quotas; fall back to pacing this run only.
    core.warning(
      `Could not read VirusTotal quota usage (${(error as Error).message}). Daily and monthly ` +
        'limits will only account for requests made by this run.'
    )
  }
}

async function loadManifests(config: ActionConfig): Promise<ManifestIndex> {
  if (config.manifestUrls.length > 0) {
    core.info(
      `Fetching ${config.manifestUrls.length} channel manifest(s) from the CDN. Whatever they ` +
        'reference is never deleted, and a manifest that fails to load aborts the prune.'
    )
    const index = await fetchManifests(config.manifestUrls, { logger })
    core.info(`All ${config.manifestUrls.length} manifest(s) read successfully`)
    return index
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
  core.setOutput('usage-files', pruneResult ? pruneResult.fileCountAfter : 0)
  core.setOutput('usage-files-ratio', pruneResult ? pruneResult.fileRatioAfter.toFixed(4) : '0')
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
        pruneResult.quotaFiles > 0
          ? `- Files before: **${pruneResult.fileCountBefore}** of ${pruneResult.quotaFiles} ` +
            `(${(pruneResult.fileRatioBefore * 100).toFixed(1)}%)`
          : `- Files: ${pruneResult.fileCountBefore} (no quota-files limit configured)`,
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
