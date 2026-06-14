import { EventEmitter } from 'node:events'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openMock, lstatMock, spawnMock, showOpenDialogMock, fromWebContentsMock } = vi.hoisted(() => ({
  openMock: vi.fn(),
  lstatMock: vi.fn(),
  spawnMock: vi.fn(),
  showOpenDialogMock: vi.fn(),
  fromWebContentsMock: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({ open: openMock, lstat: lstatMock }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: fromWebContentsMock },
  dialog: { showOpenDialog: showOpenDialogMock },
}))

import { chooseApplicationAndOpen, openVerifiedRegularFile, readLocalText, writeLocalText } from './fileOpening'

/** stat/read/write/truncate/close を備えた FileHandle ダブルを作る。 */
const makeHandle = (overrides: Record<string, unknown> = {}) => ({
  stat: vi.fn().mockResolvedValue({ isFile: () => true }),
  readFile: vi.fn().mockResolvedValue(Buffer.from('hi')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  truncate: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  ...overrides,
})

const errno = (code: string) => Object.assign(new Error(code), { code })

const event = { sender: {} } as unknown as Parameters<typeof chooseApplicationAndOpen>[0]

describe('readLocalText / writeLocalText（open handle 経由で TOCTOU 耐性）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('通常ファイルを読み TextDocument を返す', async () => {
    openMock.mockResolvedValue(makeHandle())
    await expect(readLocalText('/work/a.txt')).resolves.toEqual({ text: 'hi', encoding: 'utf-8', bom: false })
  })

  it('symlink（open の ELOOP）を拒否する', async () => {
    openMock.mockRejectedValue(errno('ELOOP'))
    await expect(readLocalText('/work/link')).rejects.toThrow('Symlinks cannot be edited')
  })

  it('存在しないパス（ENOENT）を拒否する', async () => {
    openMock.mockRejectedValue(errno('ENOENT'))
    await expect(readLocalText('/work/missing')).rejects.toThrow('File not found')
  })

  it('開いた対象が通常ファイルでなければ拒否し close する', async () => {
    const handle = makeHandle({ stat: vi.fn().mockResolvedValue({ isFile: () => false }) })
    openMock.mockResolvedValue(handle)
    await expect(readLocalText('/work/dir')).rejects.toThrow('Not a regular file')
    expect(handle.close).toHaveBeenCalled()
  })

  it('相対パスは拒否する', async () => {
    await expect(readLocalText('rel.txt')).rejects.toThrow('Invalid local path')
  })

  it('write は handle で truncate→writeFile し close する', async () => {
    const handle = makeHandle()
    openMock.mockResolvedValue(handle)
    await writeLocalText('/work/a.txt', 'hi', 'utf-8', false)
    expect(handle.truncate).toHaveBeenCalledWith(0)
    expect(handle.writeFile).toHaveBeenCalledWith(new TextEncoder().encode('hi'))
    expect(handle.close).toHaveBeenCalled()
  })

  it('write は symlink / 不在を拒否する', async () => {
    openMock.mockRejectedValue(errno('ELOOP'))
    await expect(writeLocalText('/work/link', 'x')).rejects.toThrow('Symlinks cannot be edited')
    openMock.mockRejectedValue(errno('ENOENT'))
    await expect(writeLocalText('/work/missing', 'x')).rejects.toThrow('File not found')
  })
})

describe('openVerifiedRegularFile フォールバック（O_NOFOLLOW 非対応 = nofollowSupported:false）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lstat で symlink を弾く（open しない）', async () => {
    lstatMock.mockResolvedValue({ isSymbolicLink: () => true })
    await expect(openVerifiedRegularFile('/work/link', 0, false)).rejects.toThrow('Symlinks cannot be edited')
    expect(openMock).not.toHaveBeenCalled()
  })

  it('lstat 不在は File not found', async () => {
    lstatMock.mockRejectedValue(errno('ENOENT'))
    await expect(openVerifiedRegularFile('/work/missing', 0, false)).rejects.toThrow('File not found')
  })

  it('open 後の dev/ino が lstat と一致しなければ差し替えとして拒否し close する', async () => {
    lstatMock.mockResolvedValue({ isSymbolicLink: () => false, dev: 1, ino: 2 })
    const handle = makeHandle({ stat: vi.fn().mockResolvedValue({ isFile: () => true, dev: 1, ino: 999 }) })
    openMock.mockResolvedValue(handle)

    await expect(openVerifiedRegularFile('/work/a.txt', 0, false)).rejects.toThrow('File changed during open')
    expect(handle.close).toHaveBeenCalled()
  })

  it('lstat と open の identity が一致すれば handle を返す', async () => {
    lstatMock.mockResolvedValue({ isSymbolicLink: () => false, dev: 1, ino: 2 })
    const handle = makeHandle({ stat: vi.fn().mockResolvedValue({ isFile: () => true, dev: 1, ino: 2 }) })
    openMock.mockResolvedValue(handle)

    await expect(openVerifiedRegularFile('/work/a.txt', 0, false)).resolves.toBe(handle)
  })
})

describe('chooseApplicationAndOpen（spawn 失敗を監視）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fromWebContentsMock.mockReturnValue(null)
  })

  /** darwin の open（spawn → exit code）を模した child を返すよう仕込む。 */
  const spawnExit = (code: number) => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; unref: () => void }
      child.stderr = new EventEmitter()
      child.unref = vi.fn()
      setImmediate(() => child.emit('exit', code))
      return child
    })
  }

  it('キャンセル時は null を返し spawn しない', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] })
    await expect(chooseApplicationAndOpen(event, '/work/a.txt')).resolves.toBeNull()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('選択アプリを shell:false / 引数配列で起動する（darwin は open -a, exit 0 で成功）', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/Applications/Edit.app'] })
    spawnExit(0)

    await expect(chooseApplicationAndOpen(event, '/work/a.txt')).resolves.toBe('/Applications/Edit.app')
    expect(spawnMock).toHaveBeenCalledWith(
      'open',
      ['-a', '/Applications/Edit.app', '/work/a.txt'],
      expect.objectContaining({ shell: false })
    )
  })

  it('spawn error（実行不可）は reject し、未処理エラーにしない', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/Applications/Missing.app'] })
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; unref: () => void }
      child.stderr = new EventEmitter()
      child.unref = vi.fn()
      setImmediate(() => child.emit('error', errno('ENOENT')))
      return child
    })

    await expect(chooseApplicationAndOpen(event, '/work/a.txt')).rejects.toThrow()
  })

  it('darwin で open が非 0 終了したら reject する', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/Applications/Edit.app'] })
    spawnExit(1)

    await expect(chooseApplicationAndOpen(event, '/work/a.txt')).rejects.toThrow('Failed to open application')
  })

  it('相対 filePath は拒否する', async () => {
    await expect(chooseApplicationAndOpen(event, 'rel.txt')).rejects.toThrow('Invalid local path')
  })
})
