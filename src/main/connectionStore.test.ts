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

    expect(
      isConnectionTarget({
        id: 's3-1',
        name: 'S3',
        kind: 's3',
        region: 'ap-northeast-1',
        bucket: 'bucket-a',
        prefix: 'daily',
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
        bucket: 'bucket-a',
        prefix: 'daily',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
      })
    ).toBe(false)
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