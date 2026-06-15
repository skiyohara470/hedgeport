import { describe, expect, it, vi } from 'vitest'

// previewSession → connectionStore が electron.app を import するため最小モックを与える。
vi.mock('electron', () => ({ app: { getPath: vi.fn() } }))

import {
  createPreviewSessionStore,
  handlePreviewLoad,
  handlePreviewMeta,
  loadPreviewDocument,
  openPreviewSession,
  validatePreviewRequest,
  type PreviewReaders,
  type PreviewWindowHandle,
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

/** remote/local を区別して記録する reader を作る。 */
function makeReaders(): PreviewReaders & {
  remoteCalls: unknown[][]
  localCalls: unknown[][]
} {
  const remoteCalls: unknown[][] = []
  const localCalls: unknown[][] = []
  return {
    remoteCalls,
    localCalls,
    readRemote: vi.fn(async (target, path, encoding) => {
      remoteCalls.push([target, path, encoding])
      return doc('remote body')
    }),
    readLocal: vi.fn(async (path, encoding) => {
      localCalls.push([path, encoding])
      return doc('local body')
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

describe('loadPreviewDocument', () => {
  it('remote は readRemote、local は readLocal を使い target/secret を返さない', async () => {
    const readers = makeReaders()
    const remote = await loadPreviewDocument(
      { source: 'remote', path: '/a.txt', name: 'a.txt', target: sftpTarget },
      'auto',
      readers
    )
    expect(readers.remoteCalls).toEqual([[sftpTarget, '/a.txt', 'auto']])
    expect(remote).toEqual({
      name: 'a.txt',
      displayPath: '/a.txt',
      source: 'remote',
      document: doc('remote body'),
    })
    // 返却値に target / 認証情報は含まれない。
    expect(JSON.stringify(remote)).not.toContain('password')

    const local = await loadPreviewDocument(
      { source: 'local', path: '/abs/b.txt', name: 'b.txt' },
      'shift_jis',
      readers
    )
    expect(readers.localCalls).toEqual([['/abs/b.txt', 'shift_jis']])
    expect(local.document).toEqual(doc('local body'))
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
