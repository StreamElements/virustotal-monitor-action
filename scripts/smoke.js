/**
 * End-to-end smoke test: runs the built dist/index.js as a real child process against a fake
 * VirusTotal Monitor API, asserting on its outputs, exit codes and the requests it made.
 *
 * This exists because `npm run build` succeeding is not evidence that the bundle works. Bumping
 * to @actions/core 3 (ESM-only) once produced a bundle where ncc silently stubbed out
 * @actions/core and still exited 0 -- typecheck, unit tests and the "dist/ is up to date" check
 * all passed, and only running the bundle revealed it. Keep this in CI after the build step.
 *
 * Usage: node scripts/smoke.js   (requires `npm run build` first)
 */
const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

const ACTION = path.join(__dirname, '..', 'dist', 'index.js')
const PREFIX = '/obs-streamelements/windows'
const VERSIONS = ['20260101000001', '20260102000002', '20260103000003', '20260104000004', '20260105000005']

if (!fs.existsSync(ACTION)) {
  console.error(`${ACTION} not found — run "npm run build" first.`)
  process.exit(1)
}

// Five 200-byte versions = 1000 B, matching the 1000 B quota used below so the watermarks land
// on round numbers. Note there are deliberately no items for the intermediate folders: a real
// Monitor root listing may not expose them, and usage must still be measured correctly.
const state = { items: [], deleted: [], uploads: [], quotaReads: 0 }
for (const [i, version] of VERSIONS.entries()) {
  state.items.push({
    id: `folder:${version}`,
    type: 'monitor_item',
    attributes: { path: `${PREFIX}/${version}`, item_type: 'folder', size: 0, creation_date: 1000 + i }
  })
  state.items.push({
    id: `file:${version}`,
    type: 'monitor_item',
    attributes: {
      path: `${PREFIX}/${version}/obs-streamelements-setup-${version}.exe`,
      item_type: 'file',
      size: 200,
      sha256: `sha-${version}`,
      creation_date: 1000 + i
    }
  })
}

// Shaped like the live stable manifest: the version appears in version_number and the ?v=
// query, never in the filename.
const MANIFEST = `[obs-browser]
version_number=20260102000002
package_url=https://cdn.test/obs-streamelements-setup.exe?v=20260102000002
`

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (code, payload) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  if (url.pathname === '/manifest') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end(MANIFEST)
  }

  if (req.method === 'GET' && /^\/api\/v3\/users\/[^/]+\/overall_quotas$/.test(url.pathname)) {
    state.quotaReads++
    return send(200, {
      data: {
        api_requests_daily: { allowed: 500, used: 137 },
        api_requests_monthly: { allowed: 15500, used: 4021 }
      }
    })
  }

  if (req.method === 'GET' && url.pathname === '/api/v3/monitor/items') {
    const folder = (url.searchParams.get('filter') || '').replace(/^path:/, '')
    return send(200, {
      data: state.items.filter(item => {
        const itemPath = item.attributes.path
        if (!itemPath.startsWith(folder)) return false
        const rest = itemPath.slice(folder.length)
        return rest.length > 0 && !rest.includes('/')
      })
    })
  }

  if (req.method === 'POST' && url.pathname === '/api/v3/monitor/items') {
    let bytes = 0
    req.on('data', chunk => (bytes += chunk.length))
    req.on('end', () => {
      state.uploads.push({ bytes, contentLength: Number(req.headers['content-length']) })
      send(200, { data: { type: 'monitor_item', id: `uploaded-${state.uploads.length}` } })
    })
    return
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/v3/monitor/items/')) {
    state.deleted.push(decodeURIComponent(url.pathname.split('/').pop()))
    return send(200, {})
  }

  send(404, { error: { code: 'NotFoundError', message: `no route for ${req.method} ${url.pathname}` } })
})

/** Parses the heredoc format the runner uses for $GITHUB_OUTPUT. */
function parseOutputs(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const outputs = {}
  for (let i = 0; i < lines.length; i++) {
    const match = /^([\w-]+)<<(\S+)$/.exec(lines[i])
    if (!match) continue
    const [, name, delimiter] = match
    const values = []
    let j = i + 1
    for (; j < lines.length && lines[j] !== delimiter; j++) values.push(lines[j])
    outputs[name] = values.join('\n')
    i = j
  }
  return outputs
}

function runAction(inputs) {
  const outputFile = path.join(os.tmpdir(), `gh-output-${crypto.randomBytes(8).toString('hex')}.txt`)
  fs.writeFileSync(outputFile, '')
  const env = { ...process.env, GITHUB_OUTPUT: outputFile }
  for (const [key, value] of Object.entries(inputs)) env[`INPUT_${key.toUpperCase()}`] = value

  // Async on purpose: the fake server runs in this process, so a synchronous spawn would block
  // the event loop and deadlock waiting for a response it can never send.
  return new Promise(resolve => {
    execFile(process.execPath, [ACTION], { env }, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? (error.code ?? 1) : 0,
        stdout: `${stdout}${stderr}`,
        outputs: parseOutputs(outputFile)
      })
    })
  })
}

let failures = 0
const check = (label, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition ? '' : `  -- got: ${detail}`}`)
  if (!condition) failures++
}

async function main(port) {
  const api = `http://127.0.0.1:${port}/api/v3`
  const manifestUrl = `http://127.0.0.1:${port}/manifest`
  const artifact = path.join(os.tmpdir(), 'obs-streamelements-setup-20260729000746.exe')
  fs.writeFileSync(artifact, Buffer.alloc(4096, 7))
  // Rate limiting off for the functional checks: the 4/min default is correct for production but
  // would pace this suite out to several minutes. It gets its own checks at the end.
  const common = {
    'api-key': 'fake-key',
    'api-url': api,
    'rate-limit-per-minute': '0',
    'rate-limit-per-day': '0',
    'rate-limit-per-month': '0'
  }

  console.log('--- the bundle loads and runs at all ---')
  let run = await runAction({ ...common, mode: 'upload', files: artifact, version: '20260729000746' })
  check('exit 0', run.exitCode === 0, `${run.exitCode}: ${run.stdout.slice(0, 400)}`)
  check('no module resolution failure', !/Cannot find module/.test(run.stdout), run.stdout.slice(0, 400))

  console.log('--- upload ---')
  check('uploaded one file', run.outputs['uploaded-count'] === '1', run.outputs['uploaded-count'])
  check(
    'declared content-length matched the streamed body',
    state.uploads.length === 1 && state.uploads[0].bytes === state.uploads[0].contentLength,
    JSON.stringify(state.uploads)
  )

  console.log('--- re-running the same release uploads nothing ---')
  state.items.push({
    id: 'file:new',
    type: 'monitor_item',
    attributes: {
      path: `${PREFIX}/20260729000746/obs-streamelements-setup-20260729000746.exe`,
      item_type: 'file',
      size: 4096,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'),
      creation_date: 2000
    }
  })
  run = await runAction({ ...common, mode: 'upload', files: artifact, version: '20260729000746' })
  check('nothing re-uploaded', state.uploads.length === 1, JSON.stringify(state.uploads))
  check('reported as skipped', run.outputs['skipped-count'] === '1', run.outputs['skipped-count'])
  state.items = state.items.filter(item => item.id !== 'file:new')

  const pruneInputs = {
    ...common,
    mode: 'prune',
    'quota-bytes': '1000',
    'high-watermark': '80',
    'target-watermark': '60',
    'keep-versions': '1',
    'manifest-urls': manifestUrl
  }

  console.log('--- prune, dry run ---')
  run = await runAction({ ...pruneInputs, 'dry-run': 'true' })
  check('deleted nothing', state.deleted.length === 0, JSON.stringify(state.deleted))
  check(
    'planned the oldest unprotected versions',
    run.outputs['deleted-versions'] === JSON.stringify([`${PREFIX}/20260101000001`, `${PREFIX}/20260103000003`]),
    run.outputs['deleted-versions']
  )

  console.log('--- prune, for real ---')
  run = await runAction(pruneInputs)
  check(
    'deleted the two oldest unprotected versions and their folders',
    JSON.stringify(state.deleted) ===
      JSON.stringify([
        'file:20260101000001',
        'folder:20260101000001',
        'file:20260103000003',
        'folder:20260103000003'
      ]),
    JSON.stringify(state.deleted)
  )
  check('the manifest-referenced version survived', !state.deleted.includes('file:20260102000002'), '')
  check('reported usage after pruning', run.outputs['usage-ratio'] === '0.6000', run.outputs['usage-ratio'])

  console.log('--- prune refuses to delete without manifest URLs ---')
  run = await runAction({ ...common, mode: 'prune', 'quota-bytes': '1000' })
  check('exited non-zero', run.exitCode !== 0, run.exitCode)
  check('explained why', /manifest-urls is empty/.test(run.stdout), run.stdout.slice(0, 300))

  console.log('--- on-error: warn downgrades a failure ---')
  run = await runAction({ ...common, mode: 'prune', 'quota-bytes': '1000', 'on-error': 'warn' })
  check('exit 0', run.exitCode === 0, run.exitCode)
  check('warned instead of failing', /::warning::/.test(run.stdout), run.stdout.slice(0, 300))

  console.log('--- rate limiting: seeds from the API and reports request count ---')
  state.quotaReads = 0
  run = await runAction({
    ...common,
    ...pruneInputs,
    'rate-limit-per-minute': '0',
    'rate-limit-per-day': '500',
    'rate-limit-per-month': '15500',
    'dry-run': 'true'
  })
  check('read the key quota once', state.quotaReads === 1, state.quotaReads)
  check(
    'logged the usage VirusTotal reported',
    /137 API request\(s\) used today of 500 allowed/.test(run.stdout),
    run.stdout.slice(0, 400)
  )
  check('reported how many requests it made', Number(run.outputs['api-requests']) > 0, run.outputs['api-requests'])

  console.log('--- rate limiting: an exhausted budget fails fast, it does not hang ---')
  const startedAt = Date.now()
  run = await runAction({
    ...common,
    ...pruneInputs,
    'rate-limit-per-day': '1',
    'rate-limit-seed-from-api': 'false',
    'dry-run': 'true'
  })
  check('exited non-zero', run.exitCode !== 0, run.exitCode)
  check(
    'explained the wait would exceed the cap',
    /would require waiting 86400s, beyond the 300s cap/.test(run.stdout),
    run.stdout.slice(0, 400)
  )
  check('returned promptly rather than blocking', Date.now() - startedAt < 30_000, `${Date.now() - startedAt}ms`)
}

server.listen(0, '127.0.0.1', async () => {
  try {
    await main(server.address().port)
  } catch (error) {
    console.error(error)
    failures++
  }
  server.close()
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
})
