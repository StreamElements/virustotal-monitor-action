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
| `rate-limit-per-minute` | `4` | Max API requests per minute. `0` disables the window. |
| `rate-limit-per-day` | `500` | Max API requests per day. `0` disables the window. |
| `rate-limit-per-month` | `15500` | Max API requests per rolling 30 days. `0` disables the window. |
| `rate-limit-max-wait` | `300` | Seconds a single request may wait for a slot before the step gives up. |
| `rate-limit-seed-from-api` | `true` | Read the key's current usage from VirusTotal at startup. Costs one request. |
| `verbose` | `false` | Log every API call, status, timing and response headers. |
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
`deleted-versions`, `freed-bytes`, `usage-bytes`, `usage-ratio`, `api-requests`.

Every run also writes a job summary with usage before/after and the exact list of versions
deleted or kept.

## Reading the log

The run opens by stating what it is about to do and under which settings — mode, dry-run,
watermarks, retention, rate limits — so a log read months later explains itself without needing
the workflow file alongside it.

The slow part is enumerating Monitor storage. There is no recursive listing, so it is one
request per folder, and at 4 requests/minute that is ~15s each. Every folder is announced as it
is listed, with a running count, because a paced run with no output is indistinguishable from a
hung one:

```
Fetching 5 channel manifest(s) from the CDN. Whatever they reference is never deleted…
  [1/5] https://cdn.streamelements.com/…/signed/obs-streamelements.manifest
      HTTP 200, 412 bytes, 88ms — currently serving version 20260729000708
Enumerating existing items in VirusTotal Monitor storage to measure usage. Monitor has no
recursive listing, so this is one request per folder and is usually the slowest part of the run.
Listing /obs-streamelements/windows/ — folder 1, 0 item(s) found
Listing /obs-streamelements/windows/20260729000708/ — folder 2 of 6 known so far, 5 item(s) found
Pausing 15s to stay within VirusTotal's rate limit — 4 request(s) per minute. Raise
rate-limit-per-minute if the key allows a higher rate.
Enumerated 23 item(s) — 18 file(s), 5 folder(s) — in 2m 14s
```

Rate-limit pauses over two seconds are announced with which window caused them and what to
change; shorter ones stay in debug so a fast run stays quiet.

### verbose

`verbose: true` logs each request, its status, duration and response headers:

```
→ GET https://www.virustotal.com/api/v3/monitor/items?filter=path%3A%2F&limit=40
← 200 in 412ms, 1183 byte(s) of body
  headers: content-type=application/json x-ratelimit-remaining=17
```

It is equivalent to setting `ACTIONS_STEP_DEBUG`, but per step, so it works without the
repository secret that not everyone can set.

**Request headers are never logged** — they carry `x-apikey`. The one URL that embeds the key is
`/users/{key}/overall_quotas`, and the key is redacted out of it (`/users/***/overall_quotas`) in
both logs and error messages. `core.setSecret` would mask it on a runner anyway, but a credential
should not be written out and then masked; there is a test asserting it never appears.

## Retention policy

A version folder is kept when **any** of these hold:

1. A live channel manifest mentions its version or one of its filenames. Manifests are matched
   as text against every spelling of the version (`20260729000746`, `20260729.000746`,
   `26.7.29.746`, …), so an unfamiliar manifest format still protects the release.

   The five live manifests are one per channel plus the signed pointer:

   ```
   https://cdn.streamelements.com/obs/dist/obs-streamelements/windows/signed/obs-streamelements.manifest
   https://cdn.streamelements.com/obs/dist/obs-streamelements/windows/qa/obs-streamelements.manifest
   https://cdn.streamelements.com/obs/dist/obs-streamelements/windows/beta/obs-streamelements.manifest
   https://cdn.streamelements.com/obs/dist/obs-streamelements/windows/latest/obs-streamelements.manifest
   https://cdn.streamelements.com/obs/dist/obs-streamelements/windows/stable/obs-streamelements.manifest
   ```

   They disagree about installer filenames — `signed/` uses `-<version>.exe` and
   `-<version>-64bit.exe`, qa/beta/latest use `-x86-`/`-x64-`, and stable drops the version from
   the filename entirely (`obs-streamelements-setup.exe?v=20241127000268`). Matching on the
   version rather than the filename is what makes all five work.
2. It is one of the newest `keep-versions` per prefix (default 10).
3. It is listed in `pin-versions`.

Everything else is a candidate. Candidates are deleted oldest-first — version order, not upload
order — until usage is under `target-watermark`. If the policy protects too much to reach the
target, the run reports the shortfall as a warning instead of deleting something protected.

## Rate limiting

VirusTotal enforces three budgets per key and answers with HTTP 429 once one is crossed.
Backing off after a 429 still spends the request, so the action paces itself instead: every call
waits for a slot in all three windows before going out. Retries are paced too — a retry costs
quota exactly like a first attempt — and when VirusTotal sends a `Retry-After`, that wins over
the local backoff curve.

Defaults are the public API allowances: **4/minute, 500/day, 15500/month**. Set any to `0` to
disable that window; raise them if the key allows more (a Monitor-enabled account usually does,
and running a prune at 4/minute is slow — see below).

A CI job is short-lived and starts with no request history, so on their own the daily and monthly
windows could only bound a single run. `rate-limit-seed-from-api` closes that gap: at startup the
action reads the key's current usage from `/users/{key}/overall_quotas` and folds it in, which is
what makes those budgets mean anything across runs. It costs one request, and if the key cannot
read its own quotas the step warns and paces this run only.

### When a 429 arrives anyway

Pacing is a prediction, and a 429 means it was wrong — the key's real limits are tighter than the
configured ones. Three things then happen:

1. **The wait matches the window.** Exponential backoff from a one-second base is the wrong shape
   for a rate limit: `1s, 2s, 4s, 8s` exhausts four retries in fifteen seconds without the
   smallest VirusTotal window having elapsed. A 429 instead waits what `Retry-After` asks for, or
   a full minute if the header is absent. Other retryable errors keep the exponential curve.
2. **The rest of the run slows down.** The 429 is fed back into the limiter, which holds every
   later call for the same period rather than letting them march into the same wall.
3. **Uploads are re-sent correctly.** The multipart body is rebuilt per attempt, so a retry sends
   the whole file rather than an already-consumed stream. For files ≥ 32 MB, each attempt fetches
   its **own** upload URL — those are single-use, so retrying against the previous one fails on a
   dead URL rather than on the upload.

A 429 that survives all retries fails the step with the VirusTotal error code intact. For a
release that matters: `on-error: fail` on the upload step means a rate-limited release is loud
rather than silently missing from Monitor.

**Two ways a run can stop on rate limits, both loud rather than hanging:**

- The wait needed exceeds `rate-limit-max-wait` (default 300s) — e.g. the daily budget is full and
  the next slot is hours away.
- VirusTotal already reported the budget as spent before the run started, so waiting cannot help.

For prune jobs, pair this with `on-error: warn` so a rate-limit stop never fails the release.

**Roughly what a run costs**, which is what to size the limits against:

| Run | Requests |
| --- | --- |
| Upload, 2 installers | 1 folder listing + 1 per file, + 1 for seeding = ~4 |
| Prune, 10 versions, nothing to delete | seeding + root walk + prefix walk + 1 per version folder = ~13 |
| Prune that deletes 3 versions | the above + 2 per version deleted (file + folder) = ~19 |

At the default 4/minute the first four are immediate and everything after paces at one per 15
seconds, so a ~19-request prune takes about four minutes of wall clock. That is fine on a
schedule, and it is the reason the upload step is worth keeping separate from the prune step.

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
- **HTTP 429** — should be rare now that calls are paced; it means the key's real limits are
  lower than the configured ones. The client honours `Retry-After` and retries four times, but
  lower `rate-limit-per-minute` to match reality rather than relying on retries.
- **`Rate limiting would require waiting …`** or **`quota is already exhausted`** — the run hit a
  configured budget. Raise the limit if the key allows more, wait for the reset, or let the
  scheduled run pick it up tomorrow (prune should use `on-error: warn`, so it will not fail the
  job).

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

## Releasing

Workflows reference `@v1`, which is a **moving tag** pointing at the newest 1.x release. Cutting
a release means creating the version tag *and* moving `v1` — forget the second step and every
consumer stays on the old code while the release notes claim otherwise.

```bash
npm run all                      # typecheck, test, build, smoke — dist/ must be committed
git tag -a v1.2.3 -m "v1.2.3 — what changed"
git tag -fa v1 -m "Moving tag: latest v1.x release (currently v1.2.3)"
git push origin v1.2.3
git push --force origin v1       # the moving tag has to be force-pushed
gh release create v1.2.3 --title "v1.2.3 — …" --latest --notes-file notes.md
```

Breaking changes to inputs or behaviour get a new major (`v2` plus a new moving tag), leaving
`v1` where it is so existing workflows keep working.

### Why this repository is public

`obs-streamelements-core` is public, and **a public repository cannot consume a private or
internal action** — GitHub reports it as:

```
Unable to resolve action `streamelements/virustotal-monitor-action`, not found
```

which reads like a bad tag or a casing mistake and is neither. Sharing an internal repo's actions
with the organization (`actions/permissions/access` → `organization`) extends access to *private
and internal* repos only; public consumers stay locked out. Since the upload step has to run in
the public release repo, this repository is public. Keep it that way, or the release pipeline
breaks the next time the tag is bumped.

Nothing here is sensitive: the API key is always an input, and the paths and manifest URLs are
already visible in the public workflow that calls it.

## Development

```bash
npm ci
npm run typecheck
npm test          # unit tests, no network
npm run build     # regenerates dist/ — commit it, CI fails if it is stale
npm run smoke     # runs the built bundle against a fake VirusTotal API
npm run all       # all four, in order
```

`dist/` is the bundle GitHub actually runs (`ncc`, node20 runtime). Source lives in `src/`,
tests in `__tests__/`.

**Run `npm run smoke` after any dependency change.** A green `npm run build` does not mean the
bundle works: `ncc` can silently stub a dependency out and still exit 0, producing a bundle that
passes typecheck, unit tests and the dist-freshness check but dies with `Cannot find module` on
the runner. The smoke test executes `dist/index.js` for real and is the only check that catches
this — it runs in CI directly after the build.

Two constraints on dependencies, both recorded in `package.json` under `//overrides`:

- **Stay on the CJS `@actions/core` 1.x line.** 3.x and `@actions/glob` 0.7 are ESM-only, which
  is exactly what ncc stubs out.
- **`undici` is force-resolved to `^6.28.0`** via `overrides`, including the copy
  `@actions/http-client` pulls in — everything up to 6.26.0 carries the HTTP smuggling and
  response-poisoning advisories. `brace-expansion` is overridden for the same reason in jest's
  dependency chain. `npm audit` should report zero.
