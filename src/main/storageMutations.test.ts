import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createDirMock, renameMock, providerMock, mkdirMock, fsRenameMock, statMock } = vi.hoisted(() => ({
  createDirMock: vi.fn(),
  renameMock: vi.fn(),
  providerMock: vi.fn(),
  mkdirMock: vi.fn(),
  fsRenameMock: vi.fn(),
  statMock: vi.fn(),
}))

// electron は connectionStore（isConnectionTarget）経由で import される。
vi.mock('electron', () => ({ app: { getPath: vi.fn() } }))
vi.mock('node:fs/promises', () => ({ mkdir: mkdirMock, rename: fsRenameMock, stat: statMock }))
vi.mock('./providers/createStorageProvider', () => ({ createStorageProvider: providerMock }))

import { createLocalDirectory, createRemoteDirectory, renameLocal, renameRemote } from './storageMutations'

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

/**
 * ENOENT を投げる stat（=対象が存在しない）を仕込む。
 */
const statMissing = (): void => {
  statMock.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }))
}

describe('storageMutations remote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    providerMock.mockReturnValue({ createDirectory: createDirMock, rename: renameMock })
  })

  it('createRemoteDirectory は親 + name の仮想パスへ委譲する', async () => {
    await createRemoteDirectory(target, '/reports', 'new-dir')
    expect(createDirMock).toHaveBeenCalledWith('/reports/new-dir')
  })

  it('createRemoteDirectory はスペースを含む名前を許容する', async () => {
    await createRemoteDirectory(target, '/', 'my folder')
    expect(createDirMock).toHaveBeenCalledWith('/my folder')
  })

  it('createRemoteDirectory は不正な名前を弾く', async () => {
    for (const name of ['', '   ', '.', '..', 'a/b', 'a\\b', `a${String.fromCharCode(0)}b`]) {
      await expect(createRemoteDirectory(target, '/reports', name)).rejects.toThrow('Invalid name.')
    }
    expect(createDirMock).not.toHaveBeenCalled()
  })

  it('createRemoteDirectory は非 canonical な親パスを弾く', async () => {
    for (const parent of ['//', '/a/../b', 'relative', '/a/', '']) {
      await expect(createRemoteDirectory(target, parent, 'x')).rejects.toThrow('Invalid remote path.')
    }
    expect(createDirMock).not.toHaveBeenCalled()
  })

  it('createRemoteDirectory は root と canonical な親を許可する', async () => {
    await createRemoteDirectory(target, '/', 'docs')
    await createRemoteDirectory(target, '/reports', 'docs')
    expect(createDirMock).toHaveBeenCalledWith('/docs')
    expect(createDirMock).toHaveBeenCalledWith('/reports/docs')
  })

  it('renameRemote は同一親 + 新名で provider.rename へ委譲する', async () => {
    await renameRemote(target, '/reports/old.txt', 'new.txt', 'file')
    expect(renameMock).toHaveBeenCalledWith('/reports/old.txt', '/reports/new.txt', 'file')
  })

  it('renameRemote は現名と同じ新名を弾く', async () => {
    await expect(renameRemote(target, '/reports/a.txt', 'a.txt', 'file')).rejects.toThrow('same as the current name')
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('renameRemote は不正な entryType を弾く', async () => {
    await expect(renameRemote(target, '/a.txt', 'b.txt', 'symlink')).rejects.toThrow('Invalid entry type.')
  })

  it('renameRemote は非 canonical な source を弾く', async () => {
    for (const path of ['/', '//a', '/a/', '/a/../b']) {
      await expect(renameRemote(target, path, 'x.txt', 'file')).rejects.toThrow('Invalid remote path.')
    }
    expect(renameMock).not.toHaveBeenCalled()
  })
})

describe('storageMutations local', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('createLocalDirectory は衝突なしで mkdir する', async () => {
    statMissing()
    await createLocalDirectory('/work', 'new-dir')
    expect(mkdirMock).toHaveBeenCalledWith('/work/new-dir')
  })

  it('createLocalDirectory は既存衝突を弾く', async () => {
    statMock.mockResolvedValue({})
    await expect(createLocalDirectory('/work', 'dup')).rejects.toThrow('already exists')
    expect(mkdirMock).not.toHaveBeenCalled()
  })

  it('createLocalDirectory は相対親パスを弾く', async () => {
    await expect(createLocalDirectory('relative/dir', 'x')).rejects.toThrow('Invalid local path.')
  })

  it('renameLocal は dirname + 新名へ rename する', async () => {
    statMissing()
    await renameLocal('/work/old.txt', 'new.txt', 'file')
    expect(fsRenameMock).toHaveBeenCalledWith('/work/old.txt', '/work/new.txt')
  })

  it('renameLocal は衝突を弾き rename しない', async () => {
    statMock.mockResolvedValue({})
    await expect(renameLocal('/work/a.txt', 'b.txt', 'file')).rejects.toThrow('already exists')
    expect(fsRenameMock).not.toHaveBeenCalled()
  })
})
