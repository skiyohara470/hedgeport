import { beforeEach, describe, expect, it, vi } from 'vitest'

const { providerMock, readMock, writeMock, listMock } = vi.hoisted(() => ({
  providerMock: vi.fn(),
  readMock: vi.fn(),
  writeMock: vi.fn(),
  listMock: vi.fn(),
}))
const { mkdirMock, writeFileMock, rmMock, statMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn(),
  writeFileMock: vi.fn(),
  rmMock: vi.fn(),
  statMock: vi.fn(),
}))
const { openVerifiedMock, chooseAppMock } = vi.hoisted(() => ({
  openVerifiedMock: vi.fn(),
  chooseAppMock: vi.fn(),
}))
const { getPathMock, openPathMock, showItemMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp'),
  openPathMock: vi.fn(),
  showItemMock: vi.fn(),
}))
let uuidCounter = 0

vi.mock('node:crypto', () => ({ randomUUID: () => `uuid-${(uuidCounter += 1)}` }))
vi.mock('node:fs/promises', () => ({
  mkdir: mkdirMock,
  writeFile: writeFileMock,
  rm: rmMock,
  stat: statMock,
}))
vi.mock('electron', () => ({
  app: { getPath: getPathMock },
  shell: { openPath: openPathMock, showItemInFolder: showItemMock },
}))
vi.mock('./providers/createStorageProvider', () => ({ createStorageProvider: providerMock }))
vi.mock('./fileOpening', () => ({ openVerifiedRegularFile: openVerifiedMock, chooseApplicationAndOpen: chooseAppMock }))

import {
  __resetExternalEditSessionsForTest,
  cleanupAllExternalEdits,
  discardExternalEdit,
  listExternalEditSessions,
  startExternalEdit,
  uploadExternalEdit,
} from './externalEdit'

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
const event = { sender: {} } as unknown as Parameters<typeof startExternalEdit>[0]
const fileEntry = (modifiedAt: string, size = 3) => [
  { name: 'a.txt', path: '/reports/a.txt', type: 'file', size, modifiedAt },
]

describe('externalEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    uuidCounter = 0
    __resetExternalEditSessionsForTest()
    providerMock.mockReturnValue({ read: readMock, write: writeMock, list: listMock })
    readMock.mockResolvedValue(new Uint8Array([1, 2, 3]))
    listMock.mockResolvedValue(fileEntry('T1'))
    mkdirMock.mockResolvedValue(undefined)
    writeFileMock.mockResolvedValue(undefined)
    rmMock.mockResolvedValue(undefined)
    statMock.mockResolvedValue({ mtimeMs: 100, size: 3 })
    openPathMock.mockResolvedValue('')
  })

  it('start: temp(0700/0600, basename のみ)へ download し system-default で開く（dirty:false, パス非公開）', async () => {
    const session = await startExternalEdit(event, target, '/reports/a.txt', 'system-default')

    expect(mkdirMock).toHaveBeenCalledWith('/tmp/hedgeport-edit/uuid-1', { recursive: true, mode: 0o700 })
    expect(writeFileMock).toHaveBeenCalledWith('/tmp/hedgeport-edit/uuid-1/a.txt', new Uint8Array([1, 2, 3]), {
      mode: 0o600,
    })
    expect(openPathMock).toHaveBeenCalledWith('/tmp/hedgeport-edit/uuid-1/a.txt')
    expect(session).toEqual({ id: 'uuid-1', remotePath: '/reports/a.txt', name: 'a.txt', dirty: false })
  })

  it('concurrency: 同一 key の同時 start は single-flight（1 回だけ download/temp 作成）', async () => {
    let resolveRead: (value: Uint8Array) => void = () => undefined
    readMock.mockImplementation(() => new Promise<Uint8Array>((resolve) => (resolveRead = resolve)))

    const p1 = startExternalEdit(event, target, '/reports/a.txt', 'system-default')
    const p2 = startExternalEdit(event, target, '/reports/a.txt', 'system-default')
    // p1 の read が呼ばれる（直列化タスクは microtask で走る）のを待ってから resolve。
    await new Promise((resolve) => setTimeout(resolve))
    resolveRead(new Uint8Array([1, 2, 3]))
    const [s1, s2] = await Promise.all([p1, p2])

    expect(s1?.id).toBe(s2?.id)
    expect(readMock).toHaveBeenCalledTimes(1)
    expect(mkdirMock).toHaveBeenCalledTimes(1)
    // 2 回目は既存を再利用しつつ launch（フォーカス）はする。
    expect(openPathMock).toHaveBeenCalledTimes(2)
  })

  it('transaction: launch 失敗時はセッション/temp を残さず、次の start は新規 download する', async () => {
    openPathMock.mockResolvedValueOnce('no app')
    await expect(startExternalEdit(event, target, '/reports/a.txt', 'system-default')).rejects.toThrow('no app')
    expect(rmMock).toHaveBeenCalledWith('/tmp/hedgeport-edit/uuid-1', { recursive: true, force: true })

    readMock.mockClear()
    const session = await startExternalEdit(event, target, '/reports/a.txt', 'system-default')
    expect(readMock).toHaveBeenCalledTimes(1) // 残骸が無いので再 download
    expect(session?.id).toBe('uuid-2')
  })

  it('transaction: writeFile 失敗時も temp を片付け、セッションを残さない', async () => {
    writeFileMock.mockRejectedValueOnce(new Error('disk full'))
    await expect(startExternalEdit(event, target, '/reports/a.txt', 'system-default')).rejects.toThrow('disk full')
    expect(rmMock).toHaveBeenCalledWith('/tmp/hedgeport-edit/uuid-1', { recursive: true, force: true })
    expect(await listExternalEditSessions()).toEqual([])
  })

  it('choose-app キャンセルは新規セッションを破棄し null を返す', async () => {
    chooseAppMock.mockResolvedValue(null)
    const session = await startExternalEdit(event, target, '/reports/a.txt', 'choose-app')
    expect(session).toBeNull()
    expect(rmMock).toHaveBeenCalledWith('/tmp/hedgeport-edit/uuid-1', { recursive: true, force: true })
  })

  it('upload: conflict なしなら provider.write（temp は検証 handle 経由）', async () => {
    openVerifiedMock.mockResolvedValue({
      readFile: vi.fn().mockResolvedValue(Buffer.from([9])),
      close: vi.fn().mockResolvedValue(undefined),
    })
    const session = await startExternalEdit(event, target, '/reports/a.txt', 'system-default')

    await uploadExternalEdit(session!.id)
    expect(writeMock).toHaveBeenCalledWith('/reports/a.txt', new Uint8Array([9]))
  })

  it('upload: リモートが削除されていたら conflict で block', async () => {
    openVerifiedMock.mockResolvedValue({
      readFile: vi.fn().mockResolvedValue(Buffer.from([9])),
      close: vi.fn().mockResolvedValue(undefined),
    })
    const session = await startExternalEdit(event, target, '/reports/a.txt', 'system-default')
    listMock.mockResolvedValue([]) // remote から消えた

    await expect(uploadExternalEdit(session!.id)).rejects.toThrow('no longer exists')
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('upload: modifiedAt が変化していたら conflict で block', async () => {
    openVerifiedMock.mockResolvedValue({
      readFile: vi.fn().mockResolvedValue(Buffer.from([9])),
      close: vi.fn().mockResolvedValue(undefined),
    })
    const session = await startExternalEdit(event, target, '/reports/a.txt', 'system-default')
    listMock.mockResolvedValue(fileEntry('T2'))

    await expect(uploadExternalEdit(session!.id)).rejects.toThrow('changed since you opened it')
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('upload: temp が symlink 等で検証失敗なら write しない', async () => {
    openVerifiedMock.mockRejectedValue(new Error('Symlinks cannot be edited as text.'))
    const session = await startExternalEdit(event, target, '/reports/a.txt', 'system-default')

    await expect(uploadExternalEdit(session!.id)).rejects.toThrow('Symlinks cannot be edited')
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('dirty: temp 未変更は clean、変化で dirty、upload 後は再び clean', async () => {
    openVerifiedMock.mockResolvedValue({
      readFile: vi.fn().mockResolvedValue(Buffer.from([9])),
      close: vi.fn().mockResolvedValue(undefined),
    })
    statMock.mockResolvedValue({ mtimeMs: 100, size: 3 }) // download スナップショット
    const session = await startExternalEdit(event, target, '/reports/a.txt', 'system-default')

    expect((await listExternalEditSessions())[0].dirty).toBe(false)

    statMock.mockResolvedValue({ mtimeMs: 200, size: 5 }) // 外部で編集された
    expect((await listExternalEditSessions())[0].dirty).toBe(true)

    await uploadExternalEdit(session!.id) // 書き戻し後に snapshot 更新（mtime 200/size 5）
    expect((await listExternalEditSessions())[0].dirty).toBe(false)
  })

  it('discard: temp を片付けてセッションを消す（再 upload は not found）', async () => {
    const session = await startExternalEdit(event, target, '/reports/a.txt', 'system-default')
    await discardExternalEdit(session!.id)

    expect(rmMock).toHaveBeenCalledWith('/tmp/hedgeport-edit/uuid-1', { recursive: true, force: true })
    await expect(uploadExternalEdit(session!.id)).rejects.toThrow('not found')
  })

  it('shutdown: in-flight start の完了を待ってから cleanup し、新規 start は拒否', async () => {
    let resolveRead: (value: Uint8Array) => void = () => undefined
    readMock.mockImplementation(() => new Promise<Uint8Array>((resolve) => (resolveRead = resolve)))

    // start を provider.read で一時停止させる。
    const startPromise = startExternalEdit(event, target, '/reports/a.txt', 'system-default')
    await new Promise((resolve) => setTimeout(resolve)) // read 到達まで待つ

    // 停止中に cleanup 開始（queues を settle 待ちするので start 完了まで snapshot しない）。
    const cleanupPromise = cleanupAllExternalEdits()

    // shutdown 後の新規 start は拒否。
    await expect(startExternalEdit(event, target, '/reports/b.txt', 'system-default')).rejects.toThrow('shutting down')

    resolveRead(new Uint8Array([1, 2, 3]))
    await startPromise
    await cleanupPromise

    // 完了後に登録されたセッションの temp も cleanup される。
    expect(rmMock).toHaveBeenCalledWith('/tmp/hedgeport-edit/uuid-1', { recursive: true, force: true })
    expect(await listExternalEditSessions()).toEqual([])
  })

  it('セッションごとに temp ディレクトリが分離される', async () => {
    await startExternalEdit(event, target, '/reports/a.txt', 'system-default')
    listMock.mockResolvedValue([{ name: 'b.txt', path: '/reports/b.txt', type: 'file', size: 3, modifiedAt: 'T1' }])
    await startExternalEdit(event, target, '/reports/b.txt', 'system-default')
    expect(mkdirMock.mock.calls.map((call) => call[0])).toEqual([
      '/tmp/hedgeport-edit/uuid-1',
      '/tmp/hedgeport-edit/uuid-2',
    ])
  })
})
