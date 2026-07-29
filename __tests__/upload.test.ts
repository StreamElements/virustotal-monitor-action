import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planUpload, runUpload } from '../src/upload'
import { MonitorItem } from '../src/types'
import { MonitorApiError, MonitorClient } from '../src/vt-client'

const REMOTE_DIR = '/obs-streamelements/windows/20260729000746'

let dir: string
let exe32: string
let exe64: string

const sha = (content: string): string => createHash('sha256').update(content).digest('hex')

function fakeClient(existing: MonitorItem[], overrides: Partial<MonitorClient> = {}): {
  client: MonitorClient
  uploadFile: jest.Mock
} {
  const uploadFile = jest.fn().mockResolvedValue('uploaded-id')
  const client = {
    listFolder: jest.fn().mockResolvedValue(existing),
    uploadFile,
    ...overrides
  } as unknown as MonitorClient
  return { client, uploadFile }
}

function remoteFile(path: string, sha256: string): MonitorItem {
  return { id: `id:${path}`, path, itemType: 'file', size: 10, sha256, creationDate: 1 }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vt-plan-'))
  exe32 = join(dir, 'obs-streamelements-setup-20260729000746.exe')
  exe64 = join(dir, 'obs-streamelements-setup-20260729000746-64bit.exe')
  await writeFile(exe32, '32-bit installer')
  await writeFile(exe64, '64-bit installer')
})

describe('planUpload', () => {
  it('creates items that are not in Monitor yet', async () => {
    const { client } = fakeClient([])
    const plan = await planUpload(client, { files: [exe32, exe64], remoteDir: REMOTE_DIR, dryRun: false })

    expect(plan.map(entry => entry.action)).toEqual(['create', 'create'])
    expect(plan[0].remotePath).toBe(`${REMOTE_DIR}/obs-streamelements-setup-20260729000746.exe`)
    expect(plan[1].remotePath).toBe(`${REMOTE_DIR}/obs-streamelements-setup-20260729000746-64bit.exe`)
  })

  it('skips a file already stored with identical content', async () => {
    const { client } = fakeClient([
      remoteFile(`${REMOTE_DIR}/obs-streamelements-setup-20260729000746.exe`, sha('32-bit installer'))
    ])
    const plan = await planUpload(client, { files: [exe32], remoteDir: REMOTE_DIR, dryRun: false })

    expect(plan[0].action).toBe('skip')
  })

  it('overwrites in place when the same path holds different content', async () => {
    const { client } = fakeClient([
      remoteFile(`${REMOTE_DIR}/obs-streamelements-setup-20260729000746.exe`, sha('an older build'))
    ])
    const plan = await planUpload(client, { files: [exe32], remoteDir: REMOTE_DIR, dryRun: false })

    expect(plan[0].action).toBe('overwrite')
    expect(plan[0].existingItemId).toBe(`id:${REMOTE_DIR}/obs-streamelements-setup-20260729000746.exe`)
  })

  it('treats a missing version folder as empty', async () => {
    const { client } = fakeClient([], {
      listFolder: jest.fn().mockRejectedValue(new MonitorApiError('not found', 404, 'NotFoundError'))
    } as unknown as Partial<MonitorClient>)

    const plan = await planUpload(client, { files: [exe32], remoteDir: REMOTE_DIR, dryRun: false })
    expect(plan[0].action).toBe('create')
  })

  it('propagates other API failures instead of uploading blindly', async () => {
    const { client } = fakeClient([], {
      listFolder: jest.fn().mockRejectedValue(new MonitorApiError('forbidden', 403, 'ForbiddenError'))
    } as unknown as Partial<MonitorClient>)

    await expect(planUpload(client, { files: [exe32], remoteDir: REMOTE_DIR, dryRun: false })).rejects.toThrow(
      /forbidden/
    )
  })
})

describe('runUpload', () => {
  it('re-running a release uploads nothing', async () => {
    const { client, uploadFile } = fakeClient([
      remoteFile(`${REMOTE_DIR}/obs-streamelements-setup-20260729000746.exe`, sha('32-bit installer')),
      remoteFile(`${REMOTE_DIR}/obs-streamelements-setup-20260729000746-64bit.exe`, sha('64-bit installer'))
    ])

    const result = await runUpload(client, { files: [exe32, exe64], remoteDir: REMOTE_DIR, dryRun: false })

    expect(uploadFile).not.toHaveBeenCalled()
    expect(result.uploaded).toHaveLength(0)
    expect(result.skipped).toHaveLength(2)
  })

  it('passes the existing item id through when overwriting', async () => {
    const { client, uploadFile } = fakeClient([
      remoteFile(`${REMOTE_DIR}/obs-streamelements-setup-20260729000746.exe`, sha('an older build'))
    ])

    await runUpload(client, { files: [exe32], remoteDir: REMOTE_DIR, dryRun: false })

    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ existingItemId: `id:${REMOTE_DIR}/obs-streamelements-setup-20260729000746.exe` })
    )
  })

  it('uploads nothing in dry-run but still reports the plan', async () => {
    const { client, uploadFile } = fakeClient([])
    const result = await runUpload(client, { files: [exe32, exe64], remoteDir: REMOTE_DIR, dryRun: true })

    expect(uploadFile).not.toHaveBeenCalled()
    expect(result.uploaded).toHaveLength(2)
    expect(result.bytesUploaded).toBeGreaterThan(0)
  })
})
