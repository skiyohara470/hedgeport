// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDefaultSettings } from '../../shared/settings'
import { App } from './App'
import type { ConnectionTarget } from './features/connection/connectionTypes'

// jsdom は matchMedia 未実装のため、テーマ追従用にスタブする。
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const sftp = (id: string, name = id): ConnectionTarget => ({
  id,
  name,
  kind: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'u',
  rootPath: '/',
})

/**
 * window.hedgeport をテスト用に差し替える。loadConnections は initial を返す。
 */
const setupApi = (overrides: Partial<Record<string, ReturnType<typeof vi.fn>>>, initial: ConnectionTarget[]) => {
  const api = {
    loadConnections: vi.fn().mockResolvedValue(initial),
    // 保存はメタデータ配列を返す契約。既定では渡された下書きをそのまま返す。
    saveConnections: vi.fn().mockImplementation((drafts: unknown) => Promise.resolve(drafts)),
    loadSettings: vi.fn().mockResolvedValue(createDefaultSettings('en')),
    saveSettings: vi.fn().mockImplementation((settings: unknown) => Promise.resolve(settings)),
    ...overrides,
  }
  Object.defineProperty(window, 'hedgeport', { configurable: true, value: api })
  return api
}

/** drag handle から target 行へ drop して並び替えを発火する。 */
const dropOnto = (targetName: string, sourceId: string): void => {
  const row = screen.getByRole('button', { name: targetName }).closest('li') as HTMLElement
  fireEvent.drop(row, { dataTransfer: { getData: () => sourceId } })
}

describe('App settings', () => {
  it('起動画面の gear で設定を開き、保存でテーマを適用・永続化する', async () => {
    const saveSettings = vi.fn().mockImplementation((s: unknown) => Promise.resolve(s))
    setupApi({ saveSettings }, [sftp('a')])

    render(<App />)
    await screen.findByRole('button', { name: 'a' })
    // 既定 system + prefersDark=false → light。
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.change(await screen.findByLabelText('Theme'), { target: { value: 'dark' } })
    // 即時プレビューで dark になる。
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' })))
    // モーダルが閉じても適用が維持される。
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull())
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('Cancel は変更を破棄してプレビューを元へ戻す', async () => {
    setupApi({}, [sftp('a')])
    render(<App />)
    await screen.findByRole('button', { name: 'a' })

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.change(await screen.findByLabelText('Theme'), { target: { value: 'dark' } })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('言語変更は再起動なしで UI へ即反映する', async () => {
    const saveSettings = vi.fn().mockImplementation((s: unknown) => Promise.resolve(s))
    setupApi({ saveSettings }, [sftp('a')])
    render(<App />)
    await screen.findByRole('button', { name: 'Add connection' })

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.change(await screen.findByLabelText('Language'), { target: { value: 'ja' } })
    // 言語プレビューで Save ボタンも即翻訳されるため、日本語ラベルで押す。
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByRole('button', { name: '接続を追加' })).toBeTruthy()
    expect(document.documentElement.getAttribute('lang')).toBe('ja')
  })

  it('外観属性はレイアウトエフェクトで描画前（render 直後・待機なし）に反映される', () => {
    setupApi({}, [])
    render(<App />)
    // useLayoutEffect により render 完了時点で data 属性が付与済み（dark/light 混在フレーム回避）。
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(document.documentElement.getAttribute('data-density')).toBe('comfortable')
  })

  it('platform / 全画面状態をルート要素へ反映する（macOS タイトルバー出し分け）', async () => {
    let fullScreenListener: ((full: boolean) => void) | undefined
    const onFullScreenChange = vi.fn((listener: (full: boolean) => void) => {
      fullScreenListener = listener
      return () => undefined
    })
    setupApi({ platform: 'darwin' as unknown as ReturnType<typeof vi.fn>, onFullScreenChange }, [])
    render(<App />)

    await waitFor(() => expect(document.documentElement.getAttribute('data-platform')).toBe('darwin'))
    // 全画面通知で data-fullscreen が切り替わる。
    expect(document.documentElement.hasAttribute('data-fullscreen')).toBe(false)
    fullScreenListener?.(true)
    await waitFor(() => expect(document.documentElement.getAttribute('data-fullscreen')).toBe('true'))
    fullScreenListener?.(false)
    await waitFor(() => expect(document.documentElement.hasAttribute('data-fullscreen')).toBe(false))
  })

  it('設定ロード失敗時は既定で起動し通知を表示する', async () => {
    const loadSettings = vi.fn().mockRejectedValue(new Error('corrupted'))
    setupApi({ loadSettings }, [sftp('a')])
    render(<App />)

    // 既定で起動して接続選択は表示される。
    expect(await screen.findByRole('button', { name: 'a' })).toBeTruthy()
    expect(screen.getByText('Could not load settings. Using defaults.')).toBeTruthy()
  })

  it('workspace ツールバーの Settings も同じダイアログを開く', async () => {
    setupApi({ listStorage: vi.fn().mockResolvedValue([]) }, [sftp('a')])
    render(<App />)
    // 接続を選んで workspace へ入る。
    fireEvent.click(await screen.findByRole('button', { name: 'a' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy()
  })

  it('設定保存失敗時はエラー表示し確定しない', async () => {
    const saveSettings = vi.fn().mockRejectedValue(new Error('disk full'))
    setupApi({ saveSettings }, [sftp('a')])
    render(<App />)
    await screen.findByRole('button', { name: 'a' })

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.change(await screen.findByLabelText('Theme'), { target: { value: 'dark' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('disk full')).toBeTruthy()
    // ダイアログは開いたまま。
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
  })
})

describe('App connection reorder (drag & drop)', () => {
  it('drop で並び替え後の順序を保存し、一覧へ反映する', async () => {
    const saveConnections = vi.fn().mockImplementation((drafts: unknown) => Promise.resolve(drafts))
    setupApi({ saveConnections }, [sftp('a'), sftp('b'), sftp('c')])

    render(<App />)
    await screen.findByRole('button', { name: 'a' })

    // a を c の前へ → [b, a, c]。
    dropOnto('c', 'a')

    await waitFor(() =>
      expect(saveConnections).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'b' }),
        expect.objectContaining({ id: 'a' }),
        expect.objectContaining({ id: 'c' }),
      ])
    )
    // 反映後の DOM 並び。
    await waitFor(() => {
      const handles = screen.getAllByLabelText(/Drag .* to reorder/).map((el) => el.getAttribute('aria-label'))
      expect(handles).toEqual(['Drag b to reorder', 'Drag a to reorder', 'Drag c to reorder'])
    })
  })

  it('no-op な drop は保存しない', async () => {
    const saveConnections = vi.fn().mockResolvedValue(undefined)
    setupApi({ saveConnections }, [sftp('a'), sftp('b')])

    render(<App />)
    await screen.findByRole('button', { name: 'a' })

    // a を b の前へ = 変化なし。
    dropOnto('b', 'a')
    await Promise.resolve()
    expect(saveConnections).not.toHaveBeenCalled()
  })

  it('保存中は drag handle を draggable=false にして再ドラッグを抑止する', async () => {
    let resolveSave: () => void = () => undefined
    // 保存完了時はメタデータ配列を返す契約のため、渡された下書きで解決する。
    const saveConnections = vi.fn().mockImplementation(
      (drafts: unknown) =>
        new Promise<unknown>((resolve) => {
          resolveSave = () => resolve(drafts)
        })
    )
    setupApi({ saveConnections }, [sftp('a'), sftp('b'), sftp('c')])

    render(<App />)
    await screen.findByRole('button', { name: 'a' })

    dropOnto('c', 'a')

    await waitFor(() => expect(screen.getByLabelText('Drag a to reorder').getAttribute('draggable')).toBe('false'))
    resolveSave()
    await waitFor(() => expect(screen.getByLabelText('Drag a to reorder').getAttribute('draggable')).toBe('true'))
  })

  it('保存失敗時は順序を変えずエラー表示する', async () => {
    const saveConnections = vi.fn().mockRejectedValue(new Error('disk full'))
    setupApi({ saveConnections }, [sftp('a'), sftp('b'), sftp('c')])

    render(<App />)
    await screen.findByRole('button', { name: 'a' })

    dropOnto('c', 'a')

    await waitFor(() => expect(saveConnections).toHaveBeenCalled())
    expect(await screen.findByText('disk full')).toBeTruthy()
    // 順序は元のまま。
    const handles = screen.getAllByLabelText(/Drag .* to reorder/).map((el) => el.getAttribute('aria-label'))
    expect(handles).toEqual(['Drag a to reorder', 'Drag b to reorder', 'Drag c to reorder'])
  })
})
