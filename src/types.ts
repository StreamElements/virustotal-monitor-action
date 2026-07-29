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

/** All files sharing one `<prefix>/<version>/` folder — the unit of pruning. */
export interface VersionGroup {
  prefix: string
  version: string
  path: string
  files: MonitorItem[]
  /** Folder items for this version, deleted after their contents. */
  folders: MonitorItem[]
  sizeBytes: number
  /** Oldest creation_date across the group's files; 0 when Monitor reported none. */
  creationDate: number
}

export type KeepReason = 'manifest' | 'recent' | 'pinned'

export interface RetentionDecision {
  group: VersionGroup
  keep: boolean
  reason?: KeepReason
}

export interface PruneResult {
  usageBytesBefore: number
  usageBytesAfter: number
  quotaBytes: number
  ratioBefore: number
  ratioAfter: number
  triggered: boolean
  dryRun: boolean
  deleted: VersionGroup[]
  kept: RetentionDecision[]
  freedBytes: number
  /** Groups we would still need to delete but could not, because everything left is protected. */
  shortfallBytes: number
  /** Non-fatal delete failures; the caller decides whether they fail the job. */
  errors: string[]
}
