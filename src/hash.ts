import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

/** Streamed so a 200 MB installer never lands in memory all at once. */
export async function sha256File(localPath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(localPath), hash)
  return hash.digest('hex')
}
