# virustotal-monitor-action

GitHub Action that manages our [VirusTotal Monitor](https://docs.virustotal.com/reference/monitor)
assets: it uploads signed release binaries so AV vendors see them before users do, and prunes
old versions before the account hits its storage quota.

Implements [CORE-440](https://linear.app/streamelements/issue/CORE-440).

- **Upload** — idempotent. Re-running a release compares sha256 and uploads nothing when the
  bytes already match; a changed file overwrites the existing item instead of duplicating it.
- **Prune** — usage-driven. Nothing happens until usage crosses the high watermark; then the
  oldest versions are deleted until usage is back under the target watermark.
- **Never deletes what is live** — anything referenced by a channel manifest, anything pinned,
  and the newest N versions per prefix are always kept. If a manifest cannot be fetched, the
  step fails rather than guessing.
- **Dry run** — `dry-run: true` logs the full plan and changes nothing.

## Layout in Monitor

```
/obs-streamelements/windows/<version_encoded>/obs-streamelements-setup-<version_encoded>.exe
/obs-streamelements/windows/<version_encoded>/obs-streamelements-setup-<version_encoded>-64bit.exe
```

One folder per version is what makes pruning safe to reason about: retention decisions are made
per version folder, and a folder is deleted as a unit. Only the user-facing installers go to
Monitor — not the plugin, installer, uninstaller or probe binaries. macOS `.pkg` files are out
of scope; set `path-prefix: /obs-streamelements/macos` if that ever changes.

## Usage

### Upload on release

See [`examples/release-upload.yml`](examples/release-upload.yml).

```yaml
- name: Upload signed installers to VirusTotal Monitor
  if: env.is_workflow_automation != 'true' && github.ref == 'refs/heads/master'
  uses: StreamElements/virustotal-monitor-action@v1
  with:
    api-key: ${{ secrets.VT_MONITOR_API_KEY }}   # whatever your repo calls the secret
    mode: upload
    version: ${{ needs.version.outputs.version_encoded }}
    files: |
      ${{ github.workspace }}/signed/obs-streamelements-setup-${{ needs.version.outputs.version_encoded }}.exe
      ${{ github.workspace }}/signed/obs-streamelements-setup-${{ needs.version.outputs.version_encoded }}-64bit.exe
```

### Prune on a schedule

See [`examples/prune-scheduled.yml`](examples/prune-scheduled.yml). Use `on-error: warn` there:
storage housekeeping must never take a release down with it.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `api-key` | *required* | VirusTotal API key with Monitor privileges. Always passed in — see below. |
| `mode` | `upload` | `upload`, `prune`, or `upload-and-prune`. |
| `files` | | Newline-separated files or globs to upload. Required for upload modes; a pattern matching nothing is an error. |
| `version` | | Version folder name under `path-prefix`, e.g. `20260729000746`. |
| `path-prefix` | `/obs-streamelements/windows` | Folder holding one sub-folder per version. |
| `remote-dir` | | Explicit upload folder. Overrides `path-prefix` + `version`. |
| `managed-prefixes` | `path-prefix` | Newline-separated prefixes prune may delete from. Everything else is untouchable. |
| `quota-bytes` | `1073741824` (1 GiB) | Storage quota. Accepts `1GB`, `1GiB`, `512mb` or a raw byte count. |
| `high-watermark` | `0.8` | Usage fraction (`0.8`) or percentage (`80`) at which pruning starts. |
| `target-watermark` | `0.6` | Usage to prune back down to. Must be below `high-watermark`. |
| `keep-versions` | `10` | Newest versions per prefix that are never deleted, regardless of channel. |
| `manifest-urls` | | Newline-separated channel manifest URLs. Required to prune for real. |
| `pin-versions` | | Extra versions to protect. |
| `usage-source` | `walk` | `walk` sums the live item tree; `statistics` uses Monitor's daily snapshot (cheaper, up to a day stale). |
| `dry-run` | `false` | Log the plan, change nothing. |
| `on-error` | `fail` | `fail` for uploads, `warn` for prune. |
| `api-url` | VirusTotal v3 | Override only for testing. |

### The API key

`api-key` is a required input with no default. The action never reads an environment variable
for it and assumes nothing about what the secret is called — the examples use
`secrets.VT_MONITOR_API_KEY`, but any name works, and the same action can serve repos that name
it differently. The value is passed to `core.setSecret` on startup, so it is masked in logs even
if an error message would otherwise echo it.

## Outputs

`uploaded-count`, `skipped-count`, `uploaded-paths`, `prune-triggered`, `deleted-count`,
`deleted-versions`, `freed-bytes`, `usage-bytes`, `usage-ratio`.

Every run also writes a job summary with usage before/after and the exact list of versions
deleted or kept.

## Retention policy

A version folder is kept when **any** of these hold:

1. A live channel manifest (`qa`, `beta`, `latest`, `stable`) mentions its version or one of its
   filenames. Manifests are matched as text against every spelling of the version
   (`20260729000746`, `20260729.000746`, `26.7.29.746`, …), so an unfamiliar manifest format
   still protects the release.
2. It is one of the newest `keep-versions` per prefix (default 10).
3. It is listed in `pin-versions`.

Everything else is a candidate. Candidates are deleted oldest-first — version order, not upload
order — until usage is under `target-watermark`. If the policy protects too much to reach the
target, the run reports the shortfall as a warning instead of deleting something protected.

## Runbook

### Check current usage

Run the prune workflow manually with **dry-run** ticked. The job summary shows usage against the
quota, whether the high watermark was crossed, and what would be deleted. Nothing is modified.

Locally, with a Monitor-enabled API key:

```bash
git clone https://github.com/StreamElements/virustotal-monitor-action && cd virustotal-monitor-action
npm ci && npm run build

INPUT_API-KEY="$VT_MONITOR_API_KEY" \
INPUT_MODE=prune \
INPUT_DRY-RUN=true \
INPUT_MANAGED-PREFIXES=/obs-streamelements/windows \
INPUT_MANIFEST-URLS="https://cdn.streamelements.com/.../obs-streamelements.latest.manifest" \
node dist/index.js
```

`INPUT_<NAME>` maps to the `<name>` input, uppercased. Add `ACTIONS_STEP_DEBUG=true` for
per-request logging.

### Prune manually

Same command without `INPUT_DRY-RUN`, or run the workflow with dry-run unticked. To free more
than the policy would on its own, lower `target-watermark` for that run; to protect a release
the manifests do not mention yet, add it to `pin-versions`.

### Validate a policy change before it deletes anything

1. Run with `dry-run: true` and the new thresholds.
2. Check the summary: every live release should appear as kept with reason `manifest`.
3. Only then re-run without dry-run.

### When it fails

- **`manifest-urls is empty`** — prune refuses to delete when it cannot tell what is live. Pass
  the manifest URLs, or use dry-run.
- **`Failed to fetch manifest … HTTP 5xx`** — the CDN was unreachable. Nothing was deleted;
  re-run later.
- **Shortfall warning** — everything left is protected. Lower `keep-versions`, or accept it and
  raise the quota with VirusTotal.
- **HTTP 429** — the client retries with backoff four times; a persistent 429 means the key's
  quota is exhausted.

## Notes on the VirusTotal API

Verified against the current docs while implementing:

- `GET /monitor/items?filter=path:/folder/` — lists direct children; paginate via `meta.cursor`.
  There is no recursive listing, so the action walks the tree.
- `POST /monitor/items` — multipart upload with a `path` field, or an `item` field to overwrite
  an existing item in place. **Files ≥ 32 MB must go to a URL from
  `GET /monitor/items/upload_url`** — our installers always do.
- `DELETE /monitor/items/{id}` — the id is base64 of `vtmonitor-v1://{owner_id}{path}`, so it is
  URL-encoded before use.
- `GET /monitor/statistics` — `storage_bytes_count` is the only usage figure VirusTotal exposes,
  and it is a daily snapshot. **The API does not expose the storage limit**, which is why
  `quota-bytes` is an input (1 GiB on our account).

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build   # regenerates dist/ — commit it, CI fails if it is stale
```

`dist/` is the bundle GitHub actually runs (`ncc`, node20 runtime). Source lives in `src/`,
tests in `__tests__/`.
