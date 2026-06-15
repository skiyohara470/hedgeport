// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HistoryDirection } from '../../../../shared/navigation'
import type { ConnectionTarget } from '../connection/connectionTypes'
import { FilerWorkspace } from './FilerWorkspace'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const sftp: ConnectionTarget = {
  id: 'sftp-1',
  name: 'Prod',
  kind: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'u',
  password: 'p',
  rootPath: '/',
  lastLocalPath: '/work',
}

/** リモート: '/' に dir 'a'、'/a' に dir 'b'、それ以深はファイル。 */
const remoteList = vi.fn(async (_target: unknown, path: string) => {
  if (path === '/') return [{ name: 'a', path: '/a', type: 'directory' as const }]
  if (path === '/a') return [{ name: 'b', path: '/a/b', type: 'directory' as const }]
  return [{ name: 'leaf.txt', path: `${path}/leaf.txt`, type: 'file' as const }]
})

/** ローカル: '/work' に dir 'l1'、'/work/l1' に dir 'l2'。 */
const localList = vi.fn(async (path?: string) => {
  const p = path ?? '/work'
  if (p === '/work')
    return { path: '/work', parentPath: '/', entries: [{ name: 'l1', path: '/work/l1', type: 'directory' as const }] }
  return { path: p, parentPath: '/work', entries: [{ name: 'l2', path: `${p}/l2`, type: 'directory' as const }] }
})

/**
 * window.hedgeport をモックし、IPC ナビゲーション listener を捕捉する。
 */
function setup(overrides: Record<string, unknown> = {}) {
  let navListener: ((direction: HistoryDirection) => void) | null = null
  const api = {
    listStorage: remoteList,
    listLocal: localList,
    onHistoryNavigation: (listener: (direction: HistoryDirection) => void) => {
      navListener = listener
      return () => {
        navListener = null
      }
    },
    ...overrides,
  }
  Object.defineProperty(window, 'hedgeport', { configurable: true, value: api })
  render(
    <FilerWorkspace
      target={sftp}
      targets={[sftp]}
      onSaveTarget={vi.fn()}
      onDeleteTarget={vi.fn()}
      onDisconnect={vi.fn()}
    />
  )
  return {
    ipcNavigate: (direction: HistoryDirection) => act(() => navListener?.(direction)),
    // 同 tick で 2 入力を送る（await/UI 待ちなし）。
    ipcNavigateBurst: (a: HistoryDirection, b: HistoryDirection) =>
      act(() => {
        navListener?.(a)
        navListener?.(b)
      }),
    // act でラップせず IPC を発火する（複数 source を同一 act 内で混在させるため）。
    ipcRaw: (direction: HistoryDirection) => navListener?.(direction),
  }
}

/** DOM 補助ボタン（戻る = button 3）を 1 回発火する（act ラップなし）。 */
function domBack(): void {
  window.dispatchEvent(new MouseEvent('mousedown', { button: 3, bubbles: true, cancelable: true }))
}

/** 同 tick で DOM 補助ボタンを 2 回押す。 */
function domBurst(): void {
  act(() => {
    domBack()
    domBack()
  })
}

describe('FilerWorkspace mouse navigation', () => {
  it('remote focus: マウス戻る/進むは remote 履歴だけを動かす', async () => {
    const { ipcNavigate } = setup()
    // / → /a へ移動。
    fireEvent.doubleClick((await screen.findByText('a')).closest('tr')!)
    expect(await screen.findByText('b')).toBeTruthy()

    ipcNavigate('back')
    expect(await screen.findByText('a')).toBeTruthy()
    await waitFor(() => expect(remoteList).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'sftp-1' }), '/'))

    ipcNavigate('forward')
    expect(await screen.findByText('b')).toBeTruthy()
  })

  it('history なしのときは no-op', async () => {
    const { ipcNavigate } = setup()
    await screen.findByText('a')
    remoteList.mockClear()
    ipcNavigate('back')
    // 追加のディレクトリ取得は発生しない。
    expect(remoteList).not.toHaveBeenCalled()
  })

  it('local 非表示時は remote を動かす', async () => {
    const { ipcNavigate } = setup()
    fireEvent.doubleClick((await screen.findByText('a')).closest('tr')!)
    await screen.findByText('b')
    ipcNavigate('back')
    expect(await screen.findByText('a')).toBeTruthy()
  })

  it('local focus: local 履歴だけ動き remote は不変', async () => {
    const { ipcNavigate } = setup()
    await screen.findByText('a')
    // ローカルペインを開く。
    fireEvent.click(screen.getByRole('button', { name: 'Show local files' }))
    const l1 = await screen.findByText('l1')
    // local ペインへ focus（section pointerdown）してから移動。
    fireEvent.pointerDown(l1)
    fireEvent.doubleClick(l1.closest('tr')!)
    expect(await screen.findByText('l2')).toBeTruthy()

    ipcNavigate('back')
    // local が戻る（l1 が再表示）。remote の 'a' は出たまま。
    expect(await screen.findByText('l1')).toBeTruthy()
    expect(screen.getByText('a')).toBeTruthy()
  })

  it('aria-modal ダイアログ表示中は無視する', async () => {
    const readText = vi.fn().mockResolvedValue({ text: 'hi', encoding: 'utf-8', bom: false })
    const { ipcNavigate } = setup({ readText })
    fireEvent.doubleClick((await screen.findByText('a')).closest('tr')!)
    await screen.findByText('b')
    // built-in editor（aria-modal）を開く。leaf を開くため /a/b へ入り、Open… > Built-in Editor を使う
    //（ファイルの既定 Open は独立プレビューを開くため、in-DOM の aria-modal にはならない）。
    fireEvent.doubleClick((await screen.findByText('b')).closest('tr')!)
    const leafRow = (await screen.findByText('leaf.txt')).closest('tr')!
    fireEvent.contextMenu(leafRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open… Ctrl+Enter' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Built-in Editor/ }))
    await screen.findByLabelText('File contents')
    remoteList.mockClear()

    ipcNavigate('back')
    expect(remoteList).not.toHaveBeenCalled()
  })

  it('入力フォーカス中（検索欄）は無視する', async () => {
    const { ipcNavigate } = setup()
    fireEvent.doubleClick((await screen.findByText('a')).closest('tr')!)
    await screen.findByText('b')
    const search = screen.getAllByLabelText('Search files')[0]
    act(() => search.focus())
    remoteList.mockClear()

    ipcNavigate('back')
    expect(remoteList).not.toHaveBeenCalled()
  })

  it('DOM 補助ボタン(button 3)は preventDefault して戻る', async () => {
    setup()
    fireEvent.doubleClick((await screen.findByText('a')).closest('tr')!)
    await screen.findByText('b')

    const event = new MouseEvent('mousedown', { button: 3, bubbles: true, cancelable: true })
    const prevented = !window.dispatchEvent(event)
    expect(prevented).toBe(true)
    expect(await screen.findByText('a')).toBeTruthy()
  })

  it('同 tick の IPC back ×2（同 source）は 2 段戻る（取りこぼさない）', async () => {
    const { ipcNavigateBurst } = setup()
    fireEvent.doubleClick((await screen.findByText('a')).closest('tr')!)
    fireEvent.doubleClick((await screen.findByText('b')).closest('tr')!)
    await screen.findByText('leaf.txt')

    // await/UI 待ちなしで 2 連続 → /a/b → / まで 2 段戻る。
    ipcNavigateBurst('back', 'back')
    expect(await screen.findByText('a')).toBeTruthy()
    expect(screen.queryByText('b')).toBeNull()
  })

  it('同 tick の DOM back ×2 は 2 段戻る', async () => {
    setup()
    fireEvent.doubleClick((await screen.findByText('a')).closest('tr')!)
    fireEvent.doubleClick((await screen.findByText('b')).closest('tr')!)
    await screen.findByText('leaf.txt')

    domBurst()
    expect(await screen.findByText('a')).toBeTruthy()
    expect(screen.queryByText('b')).toBeNull()
  })

  it('同 tick の IPC→DOM 同方向は 1 段だけ（二重通知 dedupe）', async () => {
    const { ipcRaw } = setup()
    fireEvent.doubleClick((await screen.findByText('a')).closest('tr')!)
    fireEvent.doubleClick((await screen.findByText('b')).closest('tr')!)
    await screen.findByText('leaf.txt')

    // IPC を先、DOM を後に同 tick で（同方向・別 source）→ 1 段だけ → /a（entry 'b' が見える）。
    act(() => {
      ipcRaw('back')
      domBack()
    })
    expect(await screen.findByText('b')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'a' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('同 tick の DOM→IPC 同方向は 1 段だけ（二重通知 dedupe・逆順）', async () => {
    const { ipcRaw } = setup()
    fireEvent.doubleClick((await screen.findByText('a')).closest('tr')!)
    fireEvent.doubleClick((await screen.findByText('b')).closest('tr')!)
    await screen.findByText('leaf.txt')

    // DOM を先、IPC を後に同 tick で（同方向・別 source）→ 1 段だけ → /a。
    act(() => {
      domBack()
      ipcRaw('back')
    })
    expect(await screen.findByText('b')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'a' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('IPC accept → DOM duplicate reject → 直後の DOM 入力 accept で合計 2 段', async () => {
    const { ipcRaw } = setup()
    fireEvent.doubleClick((await screen.findByText('a')).closest('tr')!)
    fireEvent.doubleClick((await screen.findByText('b')).closest('tr')!)
    await screen.findByText('leaf.txt')

    // IPC back(accept) → 同一物理入力の DOM back(reject) → ユーザーの 2 回目 DOM back(accept)。
    // reject した観測も記録するため 3 つ目が落ちず、合計 2 段戻って / まで戻る。
    act(() => {
      ipcRaw('back')
      domBack()
      domBack()
    })
    expect(await screen.findByText('a')).toBeTruthy()
    expect(screen.queryByText('b')).toBeNull()
  })

  it('未 focus の入力要素上の補助ボタンは抑止のみでナビゲーションしない', async () => {
    setup()
    fireEvent.doubleClick((await screen.findByText('a')).closest('tr')!)
    await screen.findByText('b')

    // focus していない input を target に button3 mousedown（mousedown 時点では focus 未移動）。
    const input = document.createElement('input')
    document.body.appendChild(input)
    remoteList.mockClear()
    const prevented = !input.dispatchEvent(new MouseEvent('mousedown', { button: 3, bubbles: true, cancelable: true }))
    input.remove()
    // 既定の履歴移動は抑止される。
    expect(prevented).toBe(true)
    // だがナビゲーションは起きない（追加の list 取得なし）。
    expect(remoteList).not.toHaveBeenCalled()
  })

  it('remote: push 失敗時は現在地・履歴を保持し retry で復帰する', async () => {
    // '/a' への push だけ失敗させる。'/' は常に成功。
    const list = vi.fn(async (_target: unknown, path: string) => {
      if (path === '/a') throw new Error('push boom')
      return [{ name: 'a', path: '/a', type: 'directory' as const }]
    })
    setup({ listStorage: list })
    expect(await screen.findByText('a')).toBeTruthy()

    fireEvent.doubleClick(screen.getByText('a').closest('tr')!)
    expect(await screen.findByText('push boom')).toBeTruthy()
    // 現在地は '/' のまま（breadcrumb は '/' のみ・disabled）。
    expect((screen.getByRole('button', { name: '/' }) as HTMLButtonElement).disabled).toBe(true)
    // Try again は現在地（'/'）を再読込 → 'a' が復帰（path が '/a' へ進んでいない証拠）。
    fireEvent.click(screen.getByText('Try again'))
    expect(await screen.findByText('a')).toBeTruthy()
  })

  it('remote: back 失敗時は履歴を消費せず error 中でも再 back で戻れる', async () => {
    let failBack = false
    const list = vi.fn(async (_target: unknown, path: string) => {
      if (failBack && path === '/') throw new Error('back boom')
      if (path === '/') return [{ name: 'a', path: '/a', type: 'directory' as const }]
      return [{ name: 'b', path: '/a/b', type: 'directory' as const }]
    })
    const { ipcNavigate } = setup({ listStorage: list })
    fireEvent.doubleClick((await screen.findByText('a')).closest('tr')!) // → /a, back=['/']
    await screen.findByText('b')

    failBack = true
    ipcNavigate('back') // '/' の読込が失敗
    expect(await screen.findByText('back boom')).toBeTruthy()

    // 履歴は消費されていない（back stack に '/' が残る）。error 中でも再 back が効く。
    failBack = false
    ipcNavigate('back')
    expect(await screen.findByText('a')).toBeTruthy()
  })

  it('local: push 失敗時は現在地・履歴を保持し retry で復帰する', async () => {
    const localFail = vi.fn(async (path?: string) => {
      if (path === '/work/l1') throw new Error('local boom')
      const p = path ?? '/work'
      if (p === '/work')
        return {
          path: '/work',
          parentPath: '/',
          entries: [{ name: 'l1', path: '/work/l1', type: 'directory' as const }],
        }
      return { path: p, parentPath: '/work', entries: [] }
    })
    setup({ listLocal: localFail })
    fireEvent.click(screen.getByRole('button', { name: 'Show local files' }))
    const l1 = await screen.findByText('l1')

    fireEvent.doubleClick(l1.closest('tr')!) // push /work/l1 → 失敗
    expect(await screen.findByText('local boom')).toBeTruthy()
    // Try again は現在地（/work）を再読込 → l1 復帰（/work/l1 へ進んでいない証拠）。
    fireEvent.click(screen.getByText('Try again'))
    expect(await screen.findByText('l1')).toBeTruthy()
  })

  it('remote back 実行後に local へ focus しても local 履歴は動かない（旧 request 非再生）', async () => {
    const { ipcNavigate } = setup()
    fireEvent.doubleClick((await screen.findByText('a')).closest('tr')!)
    await screen.findByText('b')
    ipcNavigate('back')
    expect(await screen.findByText('a')).toBeTruthy()

    // local を開いて移動し、履歴を作ってから focus する（新規入力なし）。
    fireEvent.click(screen.getByRole('button', { name: 'Show local files' }))
    const l1 = await screen.findByText('l1')
    fireEvent.doubleClick(l1.closest('tr')!)
    const l2 = await screen.findByText('l2')
    fireEvent.pointerDown(l2)
    // focus 変更だけでは local は動かない（l2 のまま）。
    expect(screen.getByText('l2')).toBeTruthy()
  })

  it('aria-modal の name dialog 表示中は無視する', async () => {
    const createRemoteDirectory = vi.fn().mockResolvedValue(undefined)
    const { ipcNavigate } = setup({ createRemoteDirectory })
    fireEvent.doubleClick((await screen.findByText('a')).closest('tr')!)
    await screen.findByText('b')
    // New Folder ダイアログ（aria-modal）を開く。
    fireEvent.click(screen.getByRole('button', { name: 'New Folder…' }))
    await screen.findByRole('heading', { name: 'New folder' })
    remoteList.mockClear()

    ipcNavigate('back')
    expect(remoteList).not.toHaveBeenCalled()
  })

  it('未接続のアクティブタブでは no-op（クラッシュしない）', async () => {
    const { ipcNavigate } = setup()
    await screen.findByText('a')
    // 新規タブ（未接続）を開く。
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    await screen.findByText('Choose a connection')
    remoteList.mockClear()

    ipcNavigate('back')
    expect(remoteList).not.toHaveBeenCalled()
    expect(screen.getByText('Choose a connection')).toBeTruthy()
  })
})
