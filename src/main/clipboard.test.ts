import { beforeEach, describe, expect, it, vi } from 'vitest'

const { providerMock, listMock, readMock, writeMock, copyFileProviderMock } = vi.hoisted(() => ({
  providerMock: vi.fn(),
  listMock: vi.fn(),
  readMock: vi.fn(),
  writeMock: vi.fn(),
  copyFileProviderMock: vi.fn(),
}))
const { readdirMock, readFileMock, writeFileMock, fsCopyFileMock } = vi.hoisted(() => ({
  readdirMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
  fsCopyFileMock: vi.fn(),
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn() } }))
vi.mock('node:fs/promises', () => ({
  readdir: readdirMock,
  readFile: readFileMock,
  writeFile: writeFileMock,
  copyFile: fsCopyFileMock,
}))
vi.mock('./providers/createStorageProvider', () => ({ createStorageProvider: providerMock }))

import { pasteEntries, safeCopyName } from './clipboard'

const remoteTarget = (id: string) => ({
  id,
  name: id,
  kind: 'sftp' as const,
  host: 'h',
  port: 22,
  username: 'u',
  password: 'p',
  rootPath: '/exports',
})

const fileEntry = (path: string, name: string) => ({ path, name, type: 'file' as const })

describe('safeCopyName', () => {
  it('衝突なしならそのまま', () => {
    expect(safeCopyName('a.txt', new Set())).toBe('a.txt')
  })

  it('衝突時は copy を挿入し、さらに番号を増やす', () => {
    const taken = new Set(['a.txt', 'a copy.txt'])
    expect(safeCopyName('a.txt', taken)).toBe('a copy 2.txt')
  })

  it('拡張子なし / ドットファイルも安全に採番する', () => {
    expect(safeCopyName('README', new Set(['README']))).toBe('README copy')
    expect(safeCopyName('.env', new Set(['.env']))).toBe('.env copy')
  })
})

describe('pasteEntries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    providerMock.mockImplementation(() => ({
      list: listMock,
      read: readMock,
      write: writeMock,
      copyFile: copyFileProviderMock,
    }))
    listMock.mockResolvedValue([])
    readdirMock.mockResolvedValue([])
  })

  it('remote → local はダウンロード（read→writeFile）', async () => {
    readMock.mockResolvedValue(new Uint8Array([1]))
    const result = await pasteEntries({
      entries: [fileEntry('/reports/a.csv', 'a.csv')],
      source: { kind: 'remote', target: remoteTarget('s1') },
      destination: { kind: 'local', target: null, directory: '/work' },
    })

    expect(readMock).toHaveBeenCalledWith('/reports/a.csv')
    expect(writeFileMock).toHaveBeenCalledWith('/work/a.csv', new Uint8Array([1]))
    expect(result.succeeded).toBe(1)
  })

  it('local → remote はアップロード（readFile→write）', async () => {
    readFileMock.mockResolvedValue(Buffer.from([2]))
    const result = await pasteEntries({
      entries: [fileEntry('/work/a.csv', 'a.csv')],
      source: { kind: 'local', target: null },
      destination: { kind: 'remote', target: remoteTarget('s1'), directory: '/reports' },
    })

    expect(writeMock).toHaveBeenCalledWith('/reports/a.csv', new Uint8Array([2]))
    expect(result.succeeded).toBe(1)
  })

  it('local → local は fs.copyFile', async () => {
    const result = await pasteEntries({
      entries: [fileEntry('/work/a.csv', 'a.csv')],
      source: { kind: 'local', target: null },
      destination: { kind: 'local', target: null, directory: '/dest' },
    })

    expect(fsCopyFileMock).toHaveBeenCalledWith('/work/a.csv', '/dest/a.csv')
    expect(result.succeeded).toBe(1)
  })

  it('remote → 同一 remote は provider.copyFile（サーバーサイド）', async () => {
    const result = await pasteEntries({
      entries: [fileEntry('/reports/a.csv', 'a.csv')],
      source: { kind: 'remote', target: remoteTarget('s1') },
      destination: { kind: 'remote', target: remoteTarget('s1'), directory: '/archive' },
    })

    expect(copyFileProviderMock).toHaveBeenCalledWith('/reports/a.csv', '/archive/a.csv')
    expect(readMock).not.toHaveBeenCalled()
    expect(result.succeeded).toBe(1)
  })

  it('remote → 異なる remote は read→write', async () => {
    readMock.mockResolvedValue(new Uint8Array([3]))
    const result = await pasteEntries({
      entries: [fileEntry('/reports/a.csv', 'a.csv')],
      source: { kind: 'remote', target: remoteTarget('s1') },
      destination: { kind: 'remote', target: remoteTarget('s2'), directory: '/archive' },
    })

    expect(readMock).toHaveBeenCalledWith('/reports/a.csv')
    expect(writeMock).toHaveBeenCalledWith('/archive/a.csv', new Uint8Array([3]))
    expect(copyFileProviderMock).not.toHaveBeenCalled()
    expect(result.succeeded).toBe(1)
  })

  it('同名衝突は上書きせず copy 名で採番する', async () => {
    listMock.mockResolvedValue([{ name: 'a.csv', path: '/archive/a.csv', type: 'file' }])
    await pasteEntries({
      entries: [fileEntry('/reports/a.csv', 'a.csv')],
      source: { kind: 'remote', target: remoteTarget('s1') },
      destination: { kind: 'remote', target: remoteTarget('s1'), directory: '/archive' },
    })

    expect(copyFileProviderMock).toHaveBeenCalledWith('/reports/a.csv', '/archive/a copy.csv')
  })

  it('ディレクトリは対象外として失敗に記録する', async () => {
    const result = await pasteEntries({
      entries: [{ path: '/reports/sub', name: 'sub', type: 'directory' }],
      source: { kind: 'remote', target: remoteTarget('s1') },
      destination: { kind: 'local', target: null, directory: '/work' },
    })

    expect(result.succeeded).toBe(0)
    expect(result.failures[0].message).toContain('directories is not supported')
  })

  it('entry.name の遡上（../outside）を弾き保存先外へ書かせない', async () => {
    const result = await pasteEntries({
      entries: [{ path: '/work/a.txt', name: '../outside', type: 'file' }],
      source: { kind: 'local', target: null },
      destination: { kind: 'local', target: null, directory: '/dest' },
    })

    expect(result.succeeded).toBe(0)
    expect(result.failures[0].message).toContain('Invalid name')
    expect(fsCopyFileMock).not.toHaveBeenCalled()
  })

  it('不正な pane kind は拒否する', async () => {
    await expect(
      pasteEntries({
        entries: [fileEntry('/a.txt', 'a.txt')],
        source: { kind: 'cloud', target: null },
        destination: { kind: 'local', target: null, directory: '/dest' },
      })
    ).rejects.toThrow('Invalid pane kind.')
  })
})
