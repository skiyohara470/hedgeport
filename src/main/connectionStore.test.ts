import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const { getPath } = vi.hoisted(() => ({
  getPath: vi.fn<(name: string) => string>(),
}))

vi.mock('electron', () => ({
  app: {
    getPath,
  },
}))

import { isConnectionTarget, loadConnections, saveConnections } from './connectionStore'

describe('connectionStore', () => {
  let tempDir: string

  afterEach(async () => {
    vi.restoreAllMocks()
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  })

  it('sftp と s3 の接続設定を受け入れる', () => {
    expect(
      isConnectionTarget({
        id: 'sftp-1',
        name: 'SFTP',
        kind: 'sftp',
        host: 'example.com',
        port: 22,
        username: 'alice',
        password: 'secret',
        rootPath: '/exports',
      })
    ).toBe(true)

    // アカウント単位の S3（bucket / prefix を持たない）を受け入れる。
    expect(
      isConnectionTarget({
        id: 's3-1',
        name: 'S3',
        kind: 's3',
        region: 'ap-northeast-1',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: '',
      })
    ).toBe(true)
  })

  it('必須項目が欠けた接続設定は拒否する', () => {
    expect(
      isConnectionTarget({
        id: 'sftp-1',
        name: 'SFTP',
        kind: 'sftp',
        host: 'example.com',
        username: 'alice',
        password: 'secret',
        rootPath: '/exports',
      })
    ).toBe(false)

    expect(
      isConnectionTarget({
        id: 's3-1',
        name: 'S3',
        kind: 's3',
        region: 'ap-northeast-1',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
      })
    ).toBe(false)
  })

  it('legacy S3 レコード（bucket / prefix 付き）を load 時に正規化する', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hedgeport-connection-store-'))
    getPath.mockReturnValue(tempDir)
    const savedPath = join(tempDir, 'connections.json')
    // 旧形式（bucket / prefix を含む）を直接書き込む。
    await writeFile(
      savedPath,
      JSON.stringify([
        {
          id: 's3-legacy',
          name: 'Legacy S3',
          lastLocalPath: '/work',
          kind: 's3',
          region: 'ap-northeast-1',
          bucket: 'bucket-a',
          prefix: 'daily/',
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
          sessionToken: '',
        },
      ]),
      'utf8'
    )

    // load 時に bucket / prefix は除去され、他フィールドは保持される。
    await expect(loadConnections()).resolves.toEqual([
      {
        id: 's3-legacy',
        name: 'Legacy S3',
        lastLocalPath: '/work',
        kind: 's3',
        region: 'ap-northeast-1',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: '',
      },
    ])
  })

  it('接続設定を保存して再読み込みできる', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hedgeport-connection-store-'))
    getPath.mockReturnValue(tempDir)
    const targets = [
      {
        id: 'sftp-1',
        name: 'SFTP',
        kind: 'sftp' as const,
        host: 'example.com',
        port: 22,
        username: 'alice',
        password: 'secret',
        rootPath: '/exports',
      },
    ]

    await saveConnections(targets)

    await expect(loadConnections()).resolves.toEqual(targets)

    const savedPath = join(tempDir, 'connections.json')
    await expect(readFile(savedPath, 'utf8')).resolves.toContain('"id": "sftp-1"')
    await expect(stat(savedPath)).resolves.toMatchObject({ mode: expect.any(Number) })
  })

  it('saveConnections は legacy shape を渡しても bucket / prefix を保存しない', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hedgeport-connection-store-'))
    getPath.mockReturnValue(tempDir)

    // IPC 等から legacy shape（bucket / prefix 付き）を直接渡すケース。
    await saveConnections([
      {
        id: 's3-legacy',
        name: 'Legacy S3',
        kind: 's3',
        region: 'ap-northeast-1',
        bucket: 'bucket-a',
        prefix: 'daily/',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: '',
      },
    ] as unknown as Parameters<typeof saveConnections>[0])

    const saved = await readFile(join(tempDir, 'connections.json'), 'utf8')
    expect(saved).not.toContain('bucket')
    expect(saved).not.toContain('prefix')
    // load しても正規化済みの形状で返る。
    await expect(loadConnections()).resolves.toEqual([
      {
        id: 's3-legacy',
        name: 'Legacy S3',
        kind: 's3',
        region: 'ap-northeast-1',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: '',
      },
    ])
  })

  it('未保存時は空配列を返す', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hedgeport-connection-store-'))
    getPath.mockReturnValue(tempDir)

    await expect(loadConnections()).resolves.toEqual([])
  })

  it('不正な内容の接続ファイルは拒否する', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hedgeport-connection-store-'))
    getPath.mockReturnValue(tempDir)
    const savedPath = join(tempDir, 'connections.json')

    await writeFile(savedPath, JSON.stringify([{ id: 'broken' }]), 'utf8')

    await expect(loadConnections()).rejects.toThrow('Connections file has an invalid format.')
  })
})
