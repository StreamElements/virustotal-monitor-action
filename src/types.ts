/** A file or folder stored in VirusTotal Monitor. */
export interface MonitorItem {
  /** Monitor item id — base64 of `vtmonitor-v1://{owner_id}{path}`. Needed for DELETE/overwrite. */
  id: string
  /** Absolute path inside Monitor, e.g. `/obs-streamelements/windows/20260729000746/setup.exe`. */
  path: string
  itemType: 'file' | 'folder'
  size: number
  sha256?: string
  /** Unix seconds. */
  creationDate?: number
}

/** Newest daily row of `GET /monitor/statistics`. */
export interface MonitorStatistics {
  date: number
  storageBytesCount: number
  storageFilesCount: number
}

export interface UploadPlanEntry {
  localPath: string
  remotePath: string
  size: number
  sha256: string
  /** `create` = new item, `overwrite` = same path different content, `skip` = identical content already there. */
  action: 'create' | 'overwrite' | 'skip'
  /** Set for `overwrite` — the Monitor item being replaced. */
  existingItemId?: string
}

export interface UploadResult {
  uploaded: UploadPlanEntry[]
  skipped: UploadPlanEntry[]
  bytesUploaded: number
}

/**
 * One top-level entry under a managed prefix, with everything beneath it — the unit of pruning.
 *
 * Usually that is a `<prefix>/<version>/` release folder, but it is equally a stray folder or a
 * loose file. Anything sitting in managed storage counts against the quota, so anything there
 * is a candidate; the retention filters, not the path shape, decide what survives.
 */
export interface PruneGroup {
  prefix: string
  /** The entry's own name: a version, a stray folder name, or a filename. */
  name: string
  path: string
  /** Whether `name` reads as a release version. Non-versions are purged first. */
  versionLike: boolean
  files: MonitorItem[]
  /** Folder items for this entry, deleted after their contents. */
  folders: MonitorItem[]
  sizeBytes: number
  /** Oldest creation_date across the group's files; 0 when Monitor reported none. */
  creationDate: number
}

export type KeepReason = 'manifest' | 'recent' | 'pinned'

export interface RetentionDecision {
  group: PruneGroup
  keep: boolean
  reason?: KeepReason
}

export interface PruneResult {
  usageBytesBefore: number
  usageBytesAfter: number
  quotaBytes: number
  ratioBefore: number
  ratioAfter: number
  /** File-count dimension of the quota. `quotaFiles` is 0 when the limit is not configured. */
  fileCountBefore: number
  fileCountAfter: number
  quotaFiles: number
  fileRatioBefore: number
  fileRatioAfter: number
  freedFiles: number
  triggered: boolean
  dryRun: boolean
  deleted: PruneGroup[]
  kept: RetentionDecision[]
  freedBytes: number
  /** Groups we would still need to delete but could not, because everything left is protected. */
  shortfallBytes: number
  /** Non-fatal delete failures; the caller decides whether they fail the job. */
  errors: string[]
}
