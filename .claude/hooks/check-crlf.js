/**
 * PostToolUse hook: flags CRLF written into a tracked text file.
 *
 * .gitattributes requires LF. CRLF matters here beyond tidiness: dist/index.js.map embeds the
 * source text, so a CRLF source file produces a bundle a few KB larger than the one CI builds on
 * Linux, and the dist-freshness check fails on a bundle that is otherwise byte-identical. That
 * has cost a red CI run more than once.
 *
 * Reads the hook payload on stdin (no jq in this environment; node is already a dependency).
 */
const fs = require('node:fs')

const WATCHED = /\.(ts|js|mjs|cjs|json|ya?ml|md)$/i

function main(payload) {
  const file = payload?.tool_input?.file_path ?? payload?.tool_response?.filePath
  if (!file || !WATCHED.test(file)) return
  // dist/ is generated; ncc decides its line endings, not us.
  if (file.replace(/\\/g, '/').includes('/dist/')) return

  let text
  try {
    text = fs.readFileSync(file, 'latin1')
  } catch {
    return // deleted, renamed, or not readable — nothing to say
  }
  if (!text.includes('\r')) return

  process.stdout.write(
    JSON.stringify({
      systemMessage: `${file} was written with CRLF line endings — this repo requires LF.`,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `${file} now contains CRLF line endings. This repository requires LF (.gitattributes ` +
          'enforces eol=lf) because dist/index.js.map embeds source text, so CRLF produces a ' +
          'bundle that fails CI\'s dist-freshness check while being otherwise identical. ' +
          'Rewrite the file with LF newlines. Note that Python\'s default text mode on Windows ' +
          'writes CRLF — pass newline="" when editing files with it.'
      }
    })
  )
}

let stdin = ''
process.stdin.on('data', chunk => (stdin += chunk))
process.stdin.on('end', () => {
  try {
    main(JSON.parse(stdin || '{}'))
  } catch {
    // A hook must never break the session over its own failure.
  }
})
