import { beforeEach, describe, expect, it, vi } from 'vitest'

const { providerMock, deleteMock, deleteDirMock, readMock, writeMock } = vi.hoisted(() => ({
  providerMock: vi.fn(),
  deleteMock: vi.fn(),
  deleteDirMock: vi.fn(),
  readMock: vi.fn(),
  writeMock: vi.fn(),
}))
const { lstatMock, readFileMock, writeFileMock, unlinkMock, rmdirMock } = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
  unlinkMock: vi.fn(),
  rmdirMock: vi.fn(),
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn() } }))
vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  readFile: readFileMock,
  writeFile: writeFileMock,
  unlink: unlinkMock,
  rmdir: rmdirMock,
}))
vi.mock('./providers/createStorageProvider', () => ({ createStorageProvider: providerMock }))

import { batchDeleteLocal, batchDeleteRemote, batchDownloadToDirectory, batchUpload } from './batchOperations'

const target = {
  id: 'sftp-1',
  name: 'SFTP',
  kind: 'sftp' as const,
  host: 'h',
  port: 22,
  username: 'u',
  password: 'p',
  rootPath: '/exports',
}

const lstatKind = (kind: 'file' | 'directory' | 'symlink') => ({
  isSymbolicLink: () => kind === 'symlink',
  isFile: () => kind === 'file',
  isDirectory: () => kind === 'directory',
})

describe('batchDeleteRemote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    providerMock.mockReturnValue({ delete: deleteMock, deleteDirectory: deleteDirMock })
  })

  it('file は delete、directory は deleteDirectory へ振り分ける', async () => {
    const result = await batchDeleteRemote(target, [
      { path: '/a.txt', type: 'file' },
      { path: '/dir', type: 'directory' },
    ])

    expect(deleteMock).toHaveBeenCalledWith('/a.txt')
    expect(deleteDirMock).toHaveBeenCalledWith('/dir')
    expect(result).toEqual({ succeeded: 2, failures: [] })
  })

  it('逐次処理し、失敗は止めず集計する', async () => {
    deleteMock.mockRejectedValueOnce(new Error('boom'))
    const result = await batchDeleteRemote(target, [
      { path: '/a.txt', type: 'file' },
      { path: '/b.txt', type: 'file' },
    ])

    expect(result.succeeded).toBe(1)
    expect(result.failures).toEqual([{ path: '/a.txt', message: 'boom' }])
  })

  it('非 canonical なパスは失敗として記録する', async () => {
    const result = await batchDeleteRemote(target, [{ path: '//x', type: 'file' }])
    expect(result.succeeded).toBe(0)
    expect(result.failures[0].message).toContain('Invalid remote path')
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('未知 type / 非object 要素は項目単位で failure 化する', async () => {
    const result = await batchDeleteRemote(target, [
      { path: '/a.txt', type: 'symlink' },
      'not-an-object',
      { path: '/b.txt', type: 'file' },
    ])
    expect(result.succeeded).toBe(1)
    expect(result.failures).toHaveLength(2)
    expect(result.failures[0]).toEqual({ path: '/a.txt', message: 'Invalid entry type.' })
    expect(result.failures[1].path).toBe('not-an-object')
    expect(deleteMock).toHaveBeenCalledTimes(1)
  })
})

describe('batchDeleteLocal', () => {
  beforeEach(() => vi.clearAllMocks())

  it('file/symlink は unlink、directory は rmdir（非再帰）', async () => {
    lstatMock
      .mockResolvedValueOnce(lstatKind('file'))
      .mockResolvedValueOnce(lstatKind('directory'))
      .mockResolvedValueOnce(lstatKind('symlink'))

    const result = await batchDeleteLocal([
      { path: '/work/a.txt', type: 'file' },
      { path: '/work/dir', type: 'directory' },
      { path: '/work/link', type: 'file' },
    ])

    expect(unlinkMock).toHaveBeenCalledWith('/work/a.txt')
    expect(rmdirMock).toHaveBeenCalledWith('/work/dir')
    expect(unlinkMock).toHaveBeenCalledWith('/work/link')
    expect(result.succeeded).toBe(3)
  })

  it('相対パスは失敗として記録する', async () => {
    const result = await batchDeleteLocal([{ path: 'rel', type: 'file' }])
    expect(result.failures[0].message).toContain('Invalid local path')
  })
})

describe('batchDownloadToDirectory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    providerMock.mockReturnValue({ read: readMock })
  })

  it('各ファイルを dir + basename へ書き出す', async () => {
    readMock.mockResolvedValue(new Uint8Array([1]))
    const result = await batchDownloadToDirectory(target, ['/reports/a.csv', '/b.csv'], '/Users/me/dl')

    expect(writeFileMock).toHaveBeenCalledWith('/Users/me/dl/a.csv', new Uint8Array([1]))
    expect(writeFileMock).toHaveBeenCalledWith('/Users/me/dl/b.csv', new Uint8Array([1]))
    expect(result.succeeded).toBe(2)
  })
})

describe('batchUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    providerMock.mockReturnValue({ write: writeMock })
  })

  it('各ローカルファイルを remoteDir + basename へ write する', async () => {
    readFileMock.mockResolvedValue(Buffer.from([2]))
    const result = await batchUpload(target, ['/work/a.csv'], '/reports')

    expect(writeMock).toHaveBeenCalledWith('/reports/a.csv', new Uint8Array([2]))
    expect(result.succeeded).toBe(1)
  })
})
