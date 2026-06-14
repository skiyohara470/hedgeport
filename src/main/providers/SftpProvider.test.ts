import { beforeEach, describe, expect, it, vi } from 'vitest'

const { connectMock, mkdirMock, renameMock, existsMock, endMock, rmdirMock, getMock, putMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  mkdirMock: vi.fn(),
  renameMock: vi.fn(),
  existsMock: vi.fn(),
  endMock: vi.fn(),
  rmdirMock: vi.fn(),
  getMock: vi.fn(),
  putMock: vi.fn(),
}))

vi.mock('ssh2-sftp-client', () => ({
  default: class {
    connect = connectMock
    mkdir = mkdirMock
    rename = renameMock
    exists = existsMock
    end = endMock
    rmdir = rmdirMock
    get = getMock
    put = putMock
  },
}))

import { SftpProvider, sftpTimestampToIso } from './SftpProvider'

const target = {
  id: 'sftp-1',
  name: 'SFTP',
  kind: 'sftp' as const,
  host: 'sftp.example.com',
  port: 22,
  username: 'user',
  password: 'password',
  rootPath: '/exports',
}

describe('sftpTimestampToIso', () => {
  it('ミリ秒のSFTP更新日時をISO文字列へ変換する', () => {
    expect(sftpTimestampToIso(1_717_000_000_000)).toBe('2024-05-29T16:26:40.000Z')
  })

  it('秒単位で返すサーバーの更新日時にも対応する', () => {
    expect(sftpTimestampToIso(1_717_000_000)).toBe('2024-05-29T16:26:40.000Z')
  })

  it('無効な更新日時は表示対象外にする', () => {
    expect(sftpTimestampToIso(0)).toBeUndefined()
  })
})

describe('SftpProvider createDirectory / rename', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectMock.mockResolvedValue(undefined)
    endMock.mockResolvedValue(undefined)
  })

  it('createDirectory は rootPath 結合パスへ mkdir する', async () => {
    existsMock.mockResolvedValue(false)
    const provider = new SftpProvider(target)

    await provider.createDirectory('/reports/2027')

    expect(mkdirMock).toHaveBeenCalledWith('/exports/reports/2027', false)
  })

  it('createDirectory は既存名衝突を弾き mkdir しない', async () => {
    existsMock.mockResolvedValue('d')
    const provider = new SftpProvider(target)

    await expect(provider.createDirectory('/reports/2027')).rejects.toThrow('already exists')
    expect(mkdirMock).not.toHaveBeenCalled()
  })

  it('rename は source/destination の実パスへ rename する', async () => {
    existsMock.mockResolvedValue(false)
    const provider = new SftpProvider(target)

    await provider.rename('/a.txt', '/b.txt', 'file')

    expect(renameMock).toHaveBeenCalledWith('/exports/a.txt', '/exports/b.txt')
  })

  it('rename は destination 既存時に弾き rename しない', async () => {
    existsMock.mockResolvedValue('-')
    const provider = new SftpProvider(target)

    await expect(provider.rename('/a.txt', '/b.txt', 'file')).rejects.toThrow('already exists')
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('deleteDirectory は非再帰 rmdir を呼ぶ', async () => {
    rmdirMock.mockResolvedValue(undefined)
    const provider = new SftpProvider(target)

    await provider.deleteDirectory('/reports')

    expect(rmdirMock).toHaveBeenCalledWith('/exports/reports', false)
  })

  it('copyFile は get した内容を put する', async () => {
    const buffer = Buffer.from([1, 2, 3])
    getMock.mockResolvedValue(buffer)
    putMock.mockResolvedValue(undefined)
    const provider = new SftpProvider(target)

    await provider.copyFile('/a.txt', '/a copy.txt')

    expect(getMock).toHaveBeenCalledWith('/exports/a.txt')
    expect(putMock).toHaveBeenCalledWith(buffer, '/exports/a copy.txt')
  })
})
