import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'

/**
 * Minimal streaming multipart/form-data encoder.
 *
 * We hand-roll this rather than using `FormData` because the installers are hundreds of
 * megabytes: this keeps the file on disk and streams it, and it lets us send an exact
 * Content-Length (VirusTotal's upload endpoint rejects chunked bodies).
 */

export interface MultipartFile {
  field: string
  filename: string
  contentType: string
  size: number
  createStream: () => Readable
}

export interface MultipartBody {
  contentType: string
  contentLength: number
  /** Called once per attempt — a retried request needs a fresh stream. */
  createStream: () => Readable
}

/** Header values cannot carry quotes or newlines; browsers escape them the same way. */
function escapeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, ' ').replace(/"/g, '%22')
}

export function buildMultipart(fields: Record<string, string>, file: MultipartFile): MultipartBody {
  const boundary = `----vtmonitor${randomBytes(16).toString('hex')}`

  const fieldParts = Object.entries(fields)
    .map(
      ([name, value]) =>
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${escapeHeaderValue(name)}"\r\n\r\n` +
        `${value}\r\n`
    )
    .join('')

  const filePart =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${escapeHeaderValue(file.field)}"; ` +
    `filename="${escapeHeaderValue(file.filename)}"\r\n` +
    `Content-Type: ${escapeHeaderValue(file.contentType)}\r\n\r\n`

  const prefix = Buffer.from(fieldParts + filePart, 'utf8')
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: prefix.length + file.size + suffix.length,
    createStream: () =>
      Readable.from(
        (async function* stream() {
          yield prefix
          yield* file.createStream()
          yield suffix
        })()
      )
  }
}
