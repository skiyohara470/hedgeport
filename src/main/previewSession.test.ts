import { describe, expect, it, vi } from 'vitest'

// previewSession → connectionStore が electron.app を import するため最小モックを与える。
vi.mock('electron', () => ({ app: { getPath: vi.fn() } }))

import {
  createPreviewSessionStore,
  handlePreviewLoad,
  handlePreviewMeta,
  handlePreviewSave,
  readPreviewContent,
  openPreviewSession,
  validatePreviewRequest,
  type PreviewReaders,
  type PreviewWindowHandle,
  type PreviewWriters,
} from './previewSession'
import type { TextDocument } from '../shared/transfer'

const sftpTarget = {
  id: 'sftp-1',
  name: 'Prod',
  kind: 'sftp' as const,
  host: 'example.com',
  port: 22,
  username: 'u',
  password: 'p',
  rootPath: '/',
}

const doc = (text: string): TextDocument => ({ text, encoding: 'utf-8', bom: false })

/** remote/local を区別して記録する reader を作る。revision/byteLength も返す。 */
function makeReaders(over: { remoteRevision?: string; localRevision?: string } = {}): PreviewReaders & {
  remoteCalls: unknown[][]
  localCalls: unknown[][]
  revisionRemoteCalls: unknown[][]
  revisionLocalCalls: unknown[][]
} {
  const remoteCalls: unknown[][] = []
  const localCalls: unknown[][] = []
  const revisionRemoteCalls: unknown[][] = []
  const revisionLocalCalls: unknown[][] = []
  return {
    remoteCalls,
    localCalls,
    revisionRemoteCalls,
    revisionLocalCalls,
    readRemote: vi.fn(async (target, path, encoding) => {
      remoteCalls.push([target, path, encoding])
      return { document: doc('remote body'), revision: over.remoteRevision ?? 'rev-remote', byteLength: 11 }
    }),
    readLocal: vi.fn(async (path, encoding) => {
      localCalls.push([path, encoding])
      return { document: doc('local body'), revision: over.localRevision ?? 'rev-local', byteLength: 10 }
    }),
    revisionRemote: vi.fn(async (target, path) => {
      revisionRemoteCalls.push([target, path])
      return over.remoteRevision ?? 'rev-remote'
    }),
    revisionLocal: vi.fn(async (path) => {
      revisionLocalCalls.push([path])
      return over.localRevision ?? 'rev-local'
    }),
  }
}

/** 書き込みを記録する writer を作る。書き込み後の revision / byteLength を返す。 */
function makeWriters(
  over: { remoteRevision?: string; localRevision?: string; byteLength?: number } = {}
): PreviewWriters & { remoteCalls: unknown[][]; localCalls: unknown[][] } {
  const remoteCalls: unknown[][] = []
  const localCalls: unknown[][] = []
  const byteLength = over.byteLength ?? 7
  return {
    remoteCalls,
    localCalls,
    writeRemote: vi.fn(async (target, path, text, encoding, bom) => {
      remoteCalls.push([target, path, text, encoding, bom])
      return { revision: over.remoteRevision ?? 'rev-remote-2', byteLength }
    }),
    writeLocal: vi.fn(async (path, text, encoding, bom) => {
      localCalls.push([path, text, encoding, bom])
      return { revision: over.localRevision ?? 'rev-local-2', byteLength }
    }),
  }
}

describe('validatePreviewRequest', () => {
  it('local 要求を正規化し target は捨てる', () => {
    const result = validatePreviewRequest({ source: 'local', path: '/abs/a.txt', name: 'a.txt', target: sftpTarget })
    expect(result).toEqual({ source: 'local', path: '/abs/a.txt', name: 'a.txt' })
    expect('target' in result).toBe(false)
  })

  it('remote 要求は有効な target を保持する', () => {
    const result = validatePreviewRequest({ source: 'remote', path: '/dir/a.txt', name: 'a.txt', target: sftpTarget })
    expect(result).toEqual({ source: 'remote', path: '/dir/a.txt', name: 'a.txt', target: sftpTarget })
  })

  it('name は renderer 値を信用せず検証済み path から導出する', () => {
    // renderer が偽の name を送っても path basename で上書きする。
    const remote = validatePreviewRequest({ source: 'remote', path: '/dir/real.txt', name: 'evil', target: sftpTarget })
    expect(remote.name).toBe('real.txt')
    const local = validatePreviewRequest({ source: 'local', path: '/abs/sub/local.txt', name: 'evil' })
    expect(local.name).toBe('local.txt')
  })

  it('local は絶対パスのみ、remote は canonical な仮想エントリパスのみ受理する', () => {
    expect(() => validatePreviewRequest({ source: 'local', path: 'relative.txt', name: 'x' })).toThrow()
    // remote: 非正規化 / 末尾スラッシュ / ルートは拒否。
    expect(() => validatePreviewRequest({ source: 'remote', path: 'a.txt', name: 'x', target: sftpTarget })).toThrow()
    expect(() => validatePreviewRequest({ source: 'remote', path: '/a/../b', name: 'x', target: sftpTarget })).toThrow()
    expect(() => validatePreviewRequest({ source: 'remote', path: '/dir/', name: 'x', target: sftpTarget })).toThrow()
    expect(() => validatePreviewRequest({ source: 'remote', path: '/', name: 'x', target: sftpTarget })).toThrow()
  })

  it('NUL / 制御文字を含む path を拒否する', () => {
    expect(() => validatePreviewRequest({ source: 'local', path: '/abs/a\u0000.txt', name: 'x' })).toThrow()
    expect(() => validatePreviewRequest({ source: 'local', path: '/abs/a\t.txt', name: 'x' })).toThrow()
  })

  it('不正な形状 / source / 空 path / target を拒否する', () => {
    expect(() => validatePreviewRequest(null)).toThrow()
    expect(() => validatePreviewRequest('x')).toThrow()
    expect(() => validatePreviewRequest({ source: 'bogus', path: '/a', name: 'a' })).toThrow()
    expect(() => validatePreviewRequest({ source: 'local', path: '', name: 'a' })).toThrow()
    // remote なのに target 不正。
    expect(() => validatePreviewRequest({ source: 'remote', path: '/a', name: 'a', target: { id: 'x' } })).toThrow()
  })
})

describe('readPreviewContent', () => {
  it('remote は readRemote、local は readLocal を使い target/secret を返さず byteLength/revision を含む', async () => {
    const readers = makeReaders()
    const remote = await readPreviewContent(
      { source: 'remote', path: '/a.txt', name: 'a.txt', target: sftpTarget },
      'auto',
      readers
    )
    expect(readers.remoteCalls).toEqual([[sftpTarget, '/a.txt', 'auto']])
    expect(remote).toEqual({
      document: {
        name: 'a.txt',
        displayPath: '/a.txt',
        source: 'remote',
        document: doc('remote body'),
        byteLength: 11,
      },
      revision: 'rev-remote',
    })
    // 返却値に target / 認証情報は含まれない。
    expect(JSON.stringify(remote)).not.toContain('password')

    const local = await readPreviewContent({ source: 'local', path: '/abs/b.txt', name: 'b.txt' }, 'shift_jis', readers)
    expect(readers.localCalls).toEqual([['/abs/b.txt', 'shift_jis']])
    expect(local.document.document).toEqual(doc('local body'))
    expect(local.document.byteLength).toBe(10)
  })
})

describe('createPreviewSessionStore + handlePreviewLoad', () => {
  it('sender に束縛され、別 id（main/別 preview）からの load は拒否する', async () => {
    const store = createPreviewSessionStore()
    const readers = makeReaders()
    store.register(5, { source: 'remote', path: '/a.txt', name: 'a.txt', target: sftpTarget })

    // 自分（id=5）の session は読める。
    const result = await handlePreviewLoad(store, 5, 'auto', readers)
    expect(result.name).toBe('a.txt')
    // 別ウィンドウ（メイン=0 や別 preview=99）は session を持たず横取りできない。
    await expect(handlePreviewLoad(store, 0, 'auto', readers)).rejects.toThrow(/No preview session/)
    await expect(handlePreviewLoad(store, 99, 'auto', readers)).rejects.toThrow(/No preview session/)
  })

  it('load は読込時点の revision をセッションへ記録する', async () => {
    const store = createPreviewSessionStore()
    const readers = makeReaders({ localRevision: 'r1' })
    store.register(8, { source: 'local', path: '/x.txt', name: 'x.txt' })
    // 登録直後は未ロード（revision=null）。
    expect(store.get(8)?.revision).toBeNull()
    await handlePreviewLoad(store, 8, 'auto', readers)
    expect(store.get(8)?.revision).toBe('r1')
  })

  it('複数ウィンドウは独立し、close（delete）で当該 session だけ破棄される', async () => {
    const store = createPreviewSessionStore()
    const readers = makeReaders()
    store.register(1, { source: 'local', path: '/x.txt', name: 'x.txt' })
    store.register(2, { source: 'remote', path: '/y.txt', name: 'y.txt', target: sftpTarget })
    expect(store.size).toBe(2)

    // window 1 を閉じる。
    store.delete(1)
    expect(store.has(1)).toBe(false)
    expect(store.has(2)).toBe(true)
    await expect(handlePreviewLoad(store, 1, 'auto', readers)).rejects.toThrow(/No preview session/)
    // window 2 は生きている。
    const r2 = await handlePreviewLoad(store, 2, 'auto', readers)
    expect(r2.name).toBe('y.txt')
  })

  it('encoding を reader へそのまま渡す', async () => {
    const store = createPreviewSessionStore()
    const readers = makeReaders()
    store.register(3, { source: 'local', path: '/z.txt', name: 'z.txt' })
    await handlePreviewLoad(store, 3, 'euc-jp', readers)
    expect(readers.localCalls).toEqual([['/z.txt', 'euc-jp']])
  })

  it('不正な encoding は reader 呼び出し前に拒否する', async () => {
    const store = createPreviewSessionStore()
    const readers = makeReaders()
    store.register(4, { source: 'local', path: '/z.txt', name: 'z.txt' })
    await expect(handlePreviewLoad(store, 4, 'utf-16' as never, readers)).rejects.toThrow(/Unsupported encoding/)
    expect(readers.localCalls).toEqual([])
  })
})

describe('handlePreviewMeta', () => {
  it('session のメタ情報（name/path/source）だけを返し、無ければ拒否する', () => {
    const store = createPreviewSessionStore()
    store.register(7, { source: 'remote', path: '/dir/a.txt', name: 'a.txt', target: sftpTarget })
    expect(handlePreviewMeta(store, 7)).toEqual({ name: 'a.txt', displayPath: '/dir/a.txt', source: 'remote' })
    // メタにも target/secret は含めない。
    expect(JSON.stringify(handlePreviewMeta(store, 7))).not.toContain('password')
    expect(() => handlePreviewMeta(store, 0)).toThrow(/No preview session/)
  })
})

describe('handlePreviewSave', () => {
  const saveReq = { text: 'updated', encoding: 'utf-8' as const, bom: false }

  // トークン生成を決定的にして検証しやすくする。
  const seq = (): (() => string) => {
    let n = 0
    return () => `tok-${++n}`
  }

  it('競合なし（revision 一致）なら書き込み、saved（revision/byteLength）を返しセッションを更新する', async () => {
    const store = createPreviewSessionStore()
    const readers = makeReaders({ localRevision: 'r1' })
    const writers = makeWriters({ localRevision: 'r2', byteLength: 9 })
    store.register(1, { source: 'local', path: '/x.txt', name: 'x.txt' })
    await handlePreviewLoad(store, 1, 'auto', readers) // revision=r1

    const result = await handlePreviewSave(store, 1, saveReq, readers, writers)
    expect(result).toEqual({ status: 'saved', revision: 'r2', byteLength: 9 })
    expect(writers.localCalls).toEqual([['/x.txt', 'updated', 'utf-8', false]])
    // 保存後はセッションの基準 revision が更新され、保留トークンは無い。
    expect(store.get(1)?.revision).toBe('r2')
    expect(store.get(1)?.pendingOverwrite).toBeNull()
  })

  it('remote も target/path をセッションから解決して保存する', async () => {
    const store = createPreviewSessionStore()
    const readers = makeReaders({ remoteRevision: 'r1' })
    const writers = makeWriters({ remoteRevision: 'r2' })
    store.register(2, { source: 'remote', path: '/y.txt', name: 'y.txt', target: sftpTarget })
    await handlePreviewLoad(store, 2, 'auto', readers)

    const result = await handlePreviewSave(store, 2, saveReq, readers, writers)
    expect(result).toMatchObject({ status: 'saved', revision: 'r2' })
    expect(writers.remoteCalls).toEqual([[sftpTarget, '/y.txt', 'updated', 'utf-8', false]])
  })

  it('競合（保存直前に revision 変化）は書き込まず conflict{token} を返す。token で再保存すると上書きできる', async () => {
    const store = createPreviewSessionStore()
    const readers = makeReaders({ localRevision: 'r1' })
    const writers = makeWriters({ localRevision: 'r2' })
    store.register(3, { source: 'local', path: '/x.txt', name: 'x.txt' })
    await handlePreviewLoad(store, 3, 'auto', readers)
    // 別者が r9 へ変更。
    readers.revisionLocal = vi.fn(async () => 'r9')

    const conflict = await handlePreviewSave(store, 3, saveReq, readers, writers, seq())
    expect(conflict).toEqual({ status: 'conflict', token: 'tok-1' })
    expect(writers.localCalls).toEqual([])
    expect(store.get(3)?.revision).toBe('r1') // 未保存
    expect(store.get(3)?.pendingOverwrite).toEqual({ token: 'tok-1', conflictRevision: 'r9' })

    // 同じ token で再保存 → live(r9) が conflictRevision と一致するので上書き。
    const saved = await handlePreviewSave(store, 3, { ...saveReq, overwriteToken: 'tok-1' }, readers, writers)
    expect(saved).toMatchObject({ status: 'saved', revision: 'r2' })
    expect(writers.localCalls).toHaveLength(1)
    expect(store.get(3)?.pendingOverwrite).toBeNull()
  })

  it('不正 / 別 window / 再利用済みトークンの再保存は拒否する', async () => {
    const store = createPreviewSessionStore()
    const readers = makeReaders({ localRevision: 'r1' })
    const writers = makeWriters()
    store.register(3, { source: 'local', path: '/x.txt', name: 'x.txt' })
    await handlePreviewLoad(store, 3, 'auto', readers)
    readers.revisionLocal = vi.fn(async () => 'r9')

    // 保留トークンが無い段階での token 指定は拒否。
    await expect(
      handlePreviewSave(store, 3, { ...saveReq, overwriteToken: 'bogus' }, readers, writers)
    ).rejects.toThrow(/Invalid or expired overwrite token/)

    // 競合させて token を発行。
    const conflict = await handlePreviewSave(store, 3, saveReq, readers, writers, seq())
    const token = conflict.status === 'conflict' ? conflict.token : ''
    // 違うトークンは拒否。
    await expect(
      handlePreviewSave(store, 3, { ...saveReq, overwriteToken: 'tok-999' }, readers, writers)
    ).rejects.toThrow(/Invalid or expired overwrite token/)
    // 正しいトークンで一度成功（消費）。
    await handlePreviewSave(store, 3, { ...saveReq, overwriteToken: token }, readers, writers)
    // 同じトークンの再利用は拒否。
    await expect(handlePreviewSave(store, 3, { ...saveReq, overwriteToken: token }, readers, writers)).rejects.toThrow(
      /Invalid or expired overwrite token/
    )
  })

  it('token 確認後にさらに変更されていたら上書きせず、新しい conflict{token} を返す', async () => {
    const store = createPreviewSessionStore()
    const readers = makeReaders({ localRevision: 'r1' })
    const writers = makeWriters()
    store.register(3, { source: 'local', path: '/x.txt', name: 'x.txt' })
    await handlePreviewLoad(store, 3, 'auto', readers)
    readers.revisionLocal = vi.fn(async () => 'r9')

    const first = await handlePreviewSave(store, 3, saveReq, readers, writers, seq())
    expect(first).toEqual({ status: 'conflict', token: 'tok-1' })
    // 再保存の直前にさらに r10 へ変わった。
    readers.revisionLocal = vi.fn(async () => 'r10')
    const second = await handlePreviewSave(store, 3, { ...saveReq, overwriteToken: 'tok-1' }, readers, writers, seq())
    expect(second).toEqual({ status: 'conflict', token: 'tok-1' })
    expect(writers.localCalls).toEqual([])
    // 新しい conflictRevision(r10) へ束縛し直す。
    expect(store.get(3)?.pendingOverwrite).toEqual({ token: 'tok-1', conflictRevision: 'r10' })
  })

  it('再 load で保留中の上書きトークンを破棄する', async () => {
    const store = createPreviewSessionStore()
    const readers = makeReaders({ localRevision: 'r1' })
    const writers = makeWriters()
    store.register(3, { source: 'local', path: '/x.txt', name: 'x.txt' })
    await handlePreviewLoad(store, 3, 'auto', readers)
    readers.revisionLocal = vi.fn(async () => 'r9')
    await handlePreviewSave(store, 3, saveReq, readers, writers, seq())
    expect(store.get(3)?.pendingOverwrite).not.toBeNull()
    // 再 load でトークン破棄。古いトークンの再保存は拒否される。
    await handlePreviewLoad(store, 3, 'auto', readers)
    expect(store.get(3)?.pendingOverwrite).toBeNull()
    await expect(
      handlePreviewSave(store, 3, { ...saveReq, overwriteToken: 'tok-1' }, readers, writers)
    ).rejects.toThrow(/Invalid or expired overwrite token/)
  })

  it('未ロード（revision=null）のセッションからの保存は拒否する', async () => {
    const store = createPreviewSessionStore()
    const readers = makeReaders()
    const writers = makeWriters()
    store.register(5, { source: 'local', path: '/x.txt', name: 'x.txt' })
    await expect(handlePreviewSave(store, 5, saveReq, readers, writers)).rejects.toThrow(/not loaded/)
    expect(writers.localCalls).toEqual([])
  })

  it('セッションが無いウィンドウからの保存は拒否する', async () => {
    const store = createPreviewSessionStore()
    const readers = makeReaders()
    const writers = makeWriters()
    await expect(handlePreviewSave(store, 0, saveReq, readers, writers)).rejects.toThrow(/No preview session/)
  })

  it('不正な保存要求（text/encoding/bom/overwriteToken）は検証で拒否する', async () => {
    const store = createPreviewSessionStore()
    const readers = makeReaders()
    const writers = makeWriters()
    store.register(6, { source: 'local', path: '/x.txt', name: 'x.txt' })
    await handlePreviewLoad(store, 6, 'auto', readers)
    await expect(handlePreviewSave(store, 6, { encoding: 'utf-8', bom: false }, readers, writers)).rejects.toThrow()
    await expect(
      handlePreviewSave(store, 6, { text: 'x', encoding: 'utf-16', bom: false }, readers, writers)
    ).rejects.toThrow(/Unsupported encoding/)
    await expect(
      handlePreviewSave(store, 6, { text: 'x', encoding: 'utf-8', bom: 'no' }, readers, writers)
    ).rejects.toThrow()
    await expect(
      handlePreviewSave(store, 6, { text: 'x', encoding: 'utf-8', bom: false, overwriteToken: 123 }, readers, writers)
    ).rejects.toThrow(/Invalid overwrite token/)
    expect(writers.localCalls).toEqual([])
  })
})

describe('openPreviewSession（ライフサイクル）', () => {
  /** テスト用のウィンドウハンドル（close/render-gone コールバックを保持）。 */
  function fakeHandle(over: Partial<PreviewWindowHandle> = {}) {
    const calls = { destroyed: 0 }
    let closed: (() => void) | null = null
    let renderGone: (() => void) | null = null
    const handle: PreviewWindowHandle = {
      id: 42,
      loadContent: over.loadContent ?? (() => Promise.resolve()),
      destroy: () => {
        calls.destroyed += 1
      },
      onClosed: (cb) => {
        closed = cb
      },
      onRenderProcessGone: (cb) => {
        renderGone = cb
      },
      ...over,
    }
    return { handle, calls, fireClosed: () => closed?.(), fireRenderGone: () => renderGone?.() }
  }

  it('成功時は session を登録し、close で破棄される', async () => {
    const store = createPreviewSessionStore()
    const { handle, fireClosed } = fakeHandle()
    await openPreviewSession({ source: 'local', path: '/abs/a.txt', name: 'a.txt' }, store, () => handle)
    expect(store.has(42)).toBe(true)
    // window close で session が消える。
    fireClosed()
    expect(store.has(42)).toBe(false)
  })

  it('render-process-gone でも session が破棄される', async () => {
    const store = createPreviewSessionStore()
    const { handle, fireRenderGone } = fakeHandle()
    await openPreviewSession({ source: 'local', path: '/abs/a.txt', name: 'a.txt' }, store, () => handle)
    fireRenderGone()
    expect(store.has(42)).toBe(false)
  })

  it('描画ロード失敗時は session 削除 + window 破棄してから throw する', async () => {
    const store = createPreviewSessionStore()
    const { handle, calls } = fakeHandle({ loadContent: () => Promise.reject(new Error('load failed')) })
    await expect(
      openPreviewSession({ source: 'local', path: '/abs/a.txt', name: 'a.txt' }, store, () => handle)
    ).rejects.toThrow('load failed')
    expect(store.has(42)).toBe(false)
    expect(calls.destroyed).toBe(1)
  })

  it('要求が不正ならウィンドウを生成しない', async () => {
    const store = createPreviewSessionStore()
    const createWindow = vi.fn()
    await expect(openPreviewSession({ source: 'bogus' }, store, createWindow)).rejects.toThrow()
    expect(createWindow).not.toHaveBeenCalled()
  })
})
