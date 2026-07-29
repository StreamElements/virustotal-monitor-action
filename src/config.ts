import { joinPath, normalizePath } from './paths'
import { DEFAULT_API_URL } from './vt-client'

export type Mode = 'upload' | 'prune' | 'upload-and-prune'

export interface ActionConfig {
  apiKey: string
  apiUrl: string
  mode: Mode
  filePatterns: string[]
  remoteDir: string
  managedPrefixes: string[]
  quotaBytes: number
  highWatermark: number
  targetWatermark: number
  keepVersions: number
  manifestUrls: string[]
  pinnedVersions: string[]
  dryRun: boolean
  onError: 'fail' | 'warn'
  usageSource: 'walk' | 'statistics'
}

export type InputReader = (name: string) => string

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4
}

/** Accepts raw byte counts and human sizes (`1GB`, `1 GiB`, `512mb`). */
export function parseSize(raw: string, name: string): number {
  const match = /^\s*([\d.]+)\s*([a-z]*)\s*$/i.exec(raw)
  if (!match) throw new Error(`${name} is not a valid size: "${raw}"`)
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive size: "${raw}"`)
  const unit = match[2].toLowerCase()
  if (unit.length === 0) return Math.round(value)
  const multiplier = SIZE_UNITS[unit]
  if (!multiplier) throw new Error(`${name} has an unknown unit: "${raw}"`)
  return Math.round(value * multiplier)
}

/** Accepts fractions (`0.8`) and percentages (`80`, `80%`). */
export function parseWatermark(raw: string, name: string): number {
  const trimmed = raw.trim().replace(/%$/, '')
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`)
  const fraction = value > 1 ? value / 100 : value
  if (fraction > 1) throw new Error(`${name} must not exceed 100%, got "${raw}"`)
  return fraction
}

function parseList(raw: string): string[] {
  return raw
    .split(/[\r\n]+/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
}

function parseBoolean(raw: string, name: string, fallback: boolean): boolean {
  const value = raw.trim().toLowerCase()
  if (value.length === 0) return fallback
  if (['true', 'yes', '1', 'on'].includes(value)) return true
  if (['false', 'no', '0', 'off'].includes(value)) return false
  throw new Error(`${name} must be true or false, got "${raw}"`)
}

function withDefault(raw: string, fallback: string): string {
  return raw.trim().length > 0 ? raw.trim() : fallback
}

export function parseConfig(getInput: InputReader): ActionConfig {
  const apiKey = getInput('api-key').trim()
  if (!apiKey) throw new Error('api-key is required')

  const mode = withDefault(getInput('mode'), 'upload') as Mode
  if (!['upload', 'prune', 'upload-and-prune'].includes(mode)) {
    throw new Error(`mode must be one of upload, prune, upload-and-prune — got "${mode}"`)
  }

  const pathPrefix = normalizePath(withDefault(getInput('path-prefix'), '/obs-streamelements/windows'))
  const version = getInput('version').trim()
  const explicitRemoteDir = getInput('remote-dir').trim()
  const remoteDir = explicitRemoteDir
    ? normalizePath(explicitRemoteDir)
    : version
      ? joinPath(pathPrefix, version)
      : ''

  const filePatterns = parseList(getInput('files'))
  const uploads = mode === 'upload' || mode === 'upload-and-prune'
  if (uploads) {
    if (filePatterns.length === 0) throw new Error(`files is required for mode "${mode}"`)
    if (!remoteDir) throw new Error(`version (or remote-dir) is required for mode "${mode}"`)
  }

  const managedPrefixesInput = parseList(getInput('managed-prefixes'))
  const managedPrefixes = (managedPrefixesInput.length > 0 ? managedPrefixesInput : [pathPrefix]).map(normalizePath)

  const highWatermark = parseWatermark(withDefault(getInput('high-watermark'), '0.8'), 'high-watermark')
  const targetWatermark = parseWatermark(withDefault(getInput('target-watermark'), '0.6'), 'target-watermark')
  if (targetWatermark >= highWatermark) {
    throw new Error(
      `target-watermark (${targetWatermark}) must be below high-watermark (${highWatermark}), ` +
        'otherwise pruning could never bring usage back under the threshold'
    )
  }

  const keepVersions = Number(withDefault(getInput('keep-versions'), '10'))
  if (!Number.isInteger(keepVersions) || keepVersions < 0) {
    throw new Error(`keep-versions must be a non-negative integer, got "${getInput('keep-versions')}"`)
  }

  const usageSource = withDefault(getInput('usage-source'), 'walk')
  if (usageSource !== 'walk' && usageSource !== 'statistics') {
    throw new Error(`usage-source must be walk or statistics, got "${usageSource}"`)
  }

  const onError = withDefault(getInput('on-error'), 'fail')
  if (onError !== 'fail' && onError !== 'warn') {
    throw new Error(`on-error must be fail or warn, got "${onError}"`)
  }

  return {
    apiKey,
    apiUrl: withDefault(getInput('api-url'), DEFAULT_API_URL),
    mode,
    filePatterns,
    remoteDir,
    managedPrefixes,
    quotaBytes: parseSize(withDefault(getInput('quota-bytes'), '1073741824'), 'quota-bytes'),
    highWatermark,
    targetWatermark,
    keepVersions,
    manifestUrls: parseList(getInput('manifest-urls')),
    pinnedVersions: parseList(getInput('pin-versions')),
    dryRun: parseBoolean(getInput('dry-run'), 'dry-run', false),
    onError,
    usageSource
  }
}
