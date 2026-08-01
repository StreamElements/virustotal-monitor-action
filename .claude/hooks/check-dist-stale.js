/**
 * Stop hook: warns when the source changed but the committed bundle did not.
 *
 * The action runs straight from dist/, so a source change without `npm run build` ships stale
 * behaviour — and CI's dist-freshness check fails the push. This catches it before the commit
 * rather than after the red run.
 *
 * Heuristic: source is dirty in the working tree while dist/ is not. It cannot detect a stale
 * bundle that was already committed; only `npm run build` proves that.
 */
const { execFileSync } = require('node:child_process')

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd()

function status(paths) {
  try {
    return execFileSync('git', ['status', '--porcelain', '--', ...paths], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return '' // not a repo, or git unavailable — stay quiet
  }
}

const sourceChanged = status(['src', 'action.yml'])
const bundleChanged = status(['dist'])

if (sourceChanged && !bundleChanged) {
  // Porcelain lines are "XY path"; the output was trimmed, so the leading status column may
  // already be gone. Strip whatever status prefix is left rather than a fixed width.
  const files = sourceChanged
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\S{1,2}\s+/, ''))
    .join(', ')
  process.stdout.write(
    JSON.stringify({
      systemMessage:
        `Source changed (${files}) but dist/ was not rebuilt. Run "npm run build" and commit ` +
        'dist/ — the action runs from the bundle and CI fails on a stale one.'
    })
  )
}
