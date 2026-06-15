import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { MAX_EDITABLE_TEXT_BYTES, MAX_PREVIEW_TEXT_BYTES } from '../shared/transfer'
import {
  chooseApplicationAndOpen,
  openVerifiedRegularFile,
  readLocalRevision,
  readLocalText,
  readLocalTextWithRevision,
  writeLocalText,
  writeLocalTextWithRevision,
} from './fileOpening'
import { computeContentRevision } from './contentRevision'

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

  it('Preview 上限注入で 1MiB 超〜20MiB 以下は読めるが、Editor 既定は弾く', async () => {
    const big = Buffer.alloc(MAX_EDITABLE_TEXT_BYTES + 1024, 0x61)
    // Editor（既定 1MiB）は弾く。
    openMock.mockResolvedValue(makeHandle({ readFile: vi.fn().mockResolvedValue(big) }))
    await expect(readLocalText('/work/big.txt')).rejects.toThrow('too large to edit')
    // Preview（20MiB 上限を注入）は読める。symlink/TOCTOU 保護（open handle 経由）も維持。
    openMock.mockResolvedValue(makeHandle({ readFile: vi.fn().mockResolvedValue(big) }))
    const doc = await readLocalText('/work/big.txt', 'auto', { maxBytes: MAX_PREVIEW_TEXT_BYTES })
    expect(doc.text.length).toBe(MAX_EDITABLE_TEXT_BYTES + 1024)
  })

  it('Preview 上限 20MiB 超は preview 用エラーで弾く', async () => {
    const huge = Buffer.alloc(MAX_PREVIEW_TEXT_BYTES + 1, 0x61)
    openMock.mockResolvedValue(makeHandle({ readFile: vi.fn().mockResolvedValue(huge) }))
    await expect(
      readLocalText('/work/huge.txt', 'auto', {
        maxBytes: MAX_PREVIEW_TEXT_BYTES,
        tooLargeMessage: 'File is too large to preview (limit 20 MiB).',
      })
    ).rejects.toThrow('too large to preview')
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

  it('readLocalTextWithRevision は document/revision/byteLength を返す（revision は生バイト由来）', async () => {
    const data = Buffer.from('hi')
    openMock.mockResolvedValue(makeHandle({ readFile: vi.fn().mockResolvedValue(data) }))
    const result = await readLocalTextWithRevision('/work/a.txt')
    expect(result.document).toEqual({ text: 'hi', encoding: 'utf-8', bom: false })
    expect(result.byteLength).toBe(2)
    expect(result.revision).toBe(computeContentRevision(new Uint8Array(data)))
  })

  it('readLocalRevision は現在の内容リビジョンだけを返す（decode しない）', async () => {
    // NUL を含む（テキストとしては読めない）バイト列でも revision は取れる。
    const data = Buffer.from([0x00, 0x01, 0x02])
    openMock.mockResolvedValue(makeHandle({ readFile: vi.fn().mockResolvedValue(data) }))
    await expect(readLocalRevision('/work/bin')).resolves.toBe(computeContentRevision(new Uint8Array(data)))
  })

  it('writeLocalTextWithRevision は書き込んだ内容の revision と byteLength を返す', async () => {
    const handle = makeHandle()
    openMock.mockResolvedValue(handle)
    const result = await writeLocalTextWithRevision('/work/a.txt', 'hi', 'utf-8', false)
    const written = handle.writeFile.mock.calls[0][0] as Uint8Array
    expect(result.revision).toBe(computeContentRevision(written))
    expect(result.byteLength).toBe(written.byteLength)
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
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    vi.clearAllMocks()
    fromWebContentsMock.mockReturnValue(null)
  })

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  })

  /** テスト用に process.platform を差し替える。 */
  const setPlatform = (platform: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  }

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

  /** Windows/Linux の detached spawn（'spawn' で成立）を模した child を返すよう仕込む。 */
  const spawnSucceed = () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void }
      child.unref = vi.fn()
      setImmediate(() => child.emit('spawn'))
      return child
    })
  }

  it('macOS は /Applications を defaultPath にし .app へ絞り、親ウィンドウへ attach する', async () => {
    setPlatform('darwin')
    const parent = {} as unknown
    fromWebContentsMock.mockReturnValue(parent)
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/Applications/Edit.app'] })
    spawnExit(0)

    await expect(chooseApplicationAndOpen(event, '/work/a.txt')).resolves.toBe('/Applications/Edit.app')
    expect(showOpenDialogMock).toHaveBeenCalledWith(
      parent,
      expect.objectContaining({
        properties: ['openFile'],
        defaultPath: '/Applications',
        filters: [{ name: 'Applications', extensions: ['app'] }],
      })
    )
  })

  it('Windows/Linux は defaultPath / filters を付けない（従来動作）', async () => {
    setPlatform('win32')
    // テスト実行環境は posix のため、application パス検証(isAbsolute)を通る絶対パスを使う。
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/opt/editor/bin/editor'] })
    spawnSucceed()

    await expect(chooseApplicationAndOpen(event, '/work/a.txt')).resolves.toBe('/opt/editor/bin/editor')
    const options = showOpenDialogMock.mock.calls[0].at(-1) as Record<string, unknown>
    expect(options).not.toHaveProperty('defaultPath')
    expect(options).not.toHaveProperty('filters')
  })

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
