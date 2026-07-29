import { Readable } from 'node:stream'

import { buildMultipart } from '../src/multipart'

function fileStream(content: string): Readable {
  return Readable.from([Buffer.from(content, 'utf8')])
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks)
}

describe('buildMultipart', () => {
  const content = 'installer-bytes'

  const build = () =>
    buildMultipart(
      { path: '/obs-streamelements/windows/20260729000746/setup.exe' },
      {
        field: 'file',
        filename: 'setup.exe',
        contentType: 'application/octet-stream',
        size: Buffer.byteLength(content),
        createStream: () => fileStream(content)
      }
    )

  it('declares a content-length that matches the bytes actually sent', async () => {
    const body = build()
    const bytes = await collect(body.createStream())
    expect(bytes.length).toBe(body.contentLength)
  })

  it('emits the field, the file part and the closing boundary', async () => {
    const body = build()
    const text = (await collect(body.createStream())).toString('utf8')
    const boundary = /boundary=(.+)$/.exec(body.contentType)?.[1] as string

    expect(text).toContain(`--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n`)
    expect(text).toContain('/obs-streamelements/windows/20260729000746/setup.exe')
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="setup.exe"')
    expect(text).toContain('Content-Type: application/octet-stream')
    expect(text).toContain(content)
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true)
  })

  it('can be streamed more than once so a request can be retried', async () => {
    const body = build()
    const first = await collect(body.createStream())
    const second = await collect(body.createStream())
    expect(first.equals(second)).toBe(true)
  })

  it('neutralises quotes and newlines in filenames', async () => {
    const body = buildMultipart(
      {},
      {
        field: 'file',
        filename: 'we"ird\nname.exe',
        contentType: 'application/octet-stream',
        size: 1,
        createStream: () => fileStream('x')
      }
    )
    const text = (await collect(body.createStream())).toString('utf8')
    expect(text).toContain('filename="we%22ird name.exe"')
  })
})
