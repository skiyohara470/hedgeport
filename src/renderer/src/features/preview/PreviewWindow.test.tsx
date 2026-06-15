// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDefaultSettings, type AppSettings } from '../../../../shared/settings'
import type { PreviewDocument, PreviewMeta } from '../../../../shared/preview'
import type { TextEncoding } from '../../../../shared/transfer'
import { PreviewWindow } from './PreviewWindow'

beforeEach(() => {
  // jsdom 未実装の API をスタブする。
  Element.prototype.scrollIntoView = vi.fn()
  window.close = vi.fn()
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const previewDoc = (
  over: Partial<PreviewDocument> & { text?: string; encoding?: TextEncoding } = {}
): PreviewDocument => ({
  name: over.name ?? 'a.txt',
  displayPath: over.displayPath ?? '/remote/a.txt',
  source: over.source ?? 'remote',
  document: { text: over.text ?? 'hello world', encoding: over.encoding ?? 'utf-8', bom: false },
})

const previewMeta = (over: Partial<PreviewMeta> = {}): PreviewMeta => ({
  name: over.name ?? 'a.txt',
  displayPath: over.displayPath ?? '/remote/a.txt',
  source: over.source ?? 'remote',
})

/** window.hedgeport をモックして PreviewWindow を描画する。 */
function setup(opts: {
  loadPreview: (encoding?: unknown) => Promise<PreviewDocument>
  meta?: PreviewMeta
  settings?: AppSettings
}) {
  const loadSettings = vi.fn().mockResolvedValue(opts.settings ?? createDefaultSettings('en'))
  const loadPreview = vi.fn(opts.loadPreview)
  const previewMetadata = vi.fn().mockResolvedValue(opts.meta ?? previewMeta())
  Object.defineProperty(window, 'hedgeport', {
    configurable: true,
    value: { loadSettings, loadPreview, previewMetadata },
  })
  render(<PreviewWindow />)
  return { loadPreview, previewMetadata }
}

/** 解決を外部から制御できる deferred を作る。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('PreviewWindow', () => {
  it('remote の実ファイル名 / パス / 内容を表示する', async () => {
    setup({
      meta: previewMeta({ name: 'report.csv', displayPath: '/r/report.csv', source: 'remote' }),
      loadPreview: () => Promise.resolve(previewDoc({ text: 'hello world' })),
    })
    expect(await screen.findByText('report.csv')).toBeTruthy()
    expect(screen.getByText('/r/report.csv')).toBeTruthy()
    expect(screen.getByText('Remote')).toBeTruthy()
    const body = await screen.findByLabelText('File contents')
    expect(body.textContent).toBe('hello world')
  })

  it('local の source バッジを出す', async () => {
    setup({
      meta: previewMeta({ source: 'local', name: 'l.txt', displayPath: '/abs/l.txt' }),
      loadPreview: () => Promise.resolve(previewDoc({ source: 'local' })),
    })
    expect(await screen.findByText('Local')).toBeTruthy()
  })

  it('内容ロード失敗中でもファイル名 / source / path は表示する', async () => {
    setup({
      meta: previewMeta({ name: 'broken.txt', displayPath: '/r/broken.txt', source: 'remote' }),
      loadPreview: () => Promise.reject(new Error('decode failed')),
    })
    // メタは内容ロードと独立に表示される。
    expect(await screen.findByText('broken.txt')).toBeTruthy()
    expect(screen.getByText('/r/broken.txt')).toBeTruthy()
    expect(screen.getByText('Remote')).toBeTruthy()
    // 本文はエラー表示。encoding select は操作可能（再試行できる）。
    expect(await screen.findByText('decode failed')).toBeTruthy()
    expect((screen.getByLabelText('Encoding') as HTMLSelectElement).disabled).toBe(false)
  })

  it('loading → empty を表示する', async () => {
    setup({ loadPreview: () => Promise.resolve(previewDoc({ text: '' })) })
    expect(await screen.findByText('This file is empty.')).toBeTruthy()
  })

  it('error を表示し Try again で再読込する', async () => {
    let attempt = 0
    const { loadPreview } = setup({
      loadPreview: () => {
        attempt += 1
        return attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(previewDoc({ text: 'recovered' }))
      },
    })
    expect(await screen.findByText('boom')).toBeTruthy()
    fireEvent.click(screen.getByText('Try again'))
    expect(await screen.findByText('recovered')).toBeTruthy()
    expect(loadPreview).toHaveBeenCalledTimes(2)
  })

  it('Auto 選択は保持し、検出結果は Auto ラベルに補足表示する。手動変更で再読込', async () => {
    const { loadPreview } = setup({
      loadPreview: (encoding) =>
        Promise.resolve(previewDoc({ encoding: encoding === 'shift_jis' ? 'shift_jis' : 'euc-jp' })),
    })
    const select = (await screen.findByLabelText('Encoding')) as HTMLSelectElement
    // 初回 auto 読み。検出結果(euc-jp)は Auto ラベルへ補足、選択値は 'auto' のまま保持。
    await waitFor(() => expect(screen.getByText('Auto (euc-jp)')).toBeTruthy())
    expect(select.value).toBe('auto')
    expect(loadPreview).toHaveBeenNthCalledWith(1, 'auto')

    // 手動で shift_jis に変更 → その encoding で再読込し、選択値も保持。
    fireEvent.change(select, { target: { value: 'shift_jis' } })
    await waitFor(() => expect(loadPreview).toHaveBeenLastCalledWith('shift_jis'))
    await waitFor(() => expect(select.value).toBe('shift_jis'))

    // Auto に戻すと再判定（auto で再読込）。
    fireEvent.change(select, { target: { value: 'auto' } })
    await waitFor(() => expect(loadPreview).toHaveBeenLastCalledWith('auto'))
    await waitFor(() => expect(select.value).toBe('auto'))
  })

  it('race: 古い load 結果が後から新しい選択を上書きしない', async () => {
    const first = deferred<PreviewDocument>()
    const second = deferred<PreviewDocument>()
    let call = 0
    const select0 = setup({
      loadPreview: () => {
        call += 1
        return call === 1 ? first.promise : second.promise
      },
    })
    void select0
    const select = (await screen.findByLabelText('Encoding')) as HTMLSelectElement
    // 2 回目（shift_jis）を先に解決させる。
    fireEvent.change(select, { target: { value: 'shift_jis' } })
    second.resolve(previewDoc({ text: 'NEW', encoding: 'shift_jis' }))
    expect(await screen.findByText('NEW')).toBeTruthy()
    // 後から 1 回目（auto）が遅れて解決しても無視される。
    first.resolve(previewDoc({ text: 'OLD', encoding: 'utf-8' }))
    await Promise.resolve()
    expect(screen.getByLabelText('File contents').textContent).toBe('NEW')
  })

  it('Ctrl+F / Cmd+F で検索バーを開き入力へ focus する', async () => {
    setup({ loadPreview: () => Promise.resolve(previewDoc({ text: 'find me find me' })) })
    await screen.findByLabelText('File contents')

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = (await screen.findByLabelText('Find')) as HTMLInputElement
    expect(document.activeElement).toBe(input)

    // 一度閉じて Cmd+F でも開く。
    fireEvent.click(screen.getByLabelText('Close search'))
    expect(screen.queryByLabelText('Find')).toBeNull()
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    expect(await screen.findByLabelText('Find')).toBeTruthy()
  })

  it('current/total・active 移動・wrap・Enter/Shift+Enter', async () => {
    setup({ loadPreview: () => Promise.resolve(previewDoc({ text: 'foo bar foo baz foo' })) })
    await screen.findByLabelText('File contents')
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = (await screen.findByLabelText('Find')) as HTMLInputElement

    fireEvent.change(input, { target: { value: 'foo' } })
    // 3 件、active=1。
    expect(await screen.findByText('1 / 3')).toBeTruthy()
    // active highlight は 1 つだけ。
    expect(document.querySelectorAll('.preview-match-active').length).toBe(1)

    fireEvent.keyDown(input, { key: 'Enter' }) // 次 → 2/3
    expect(await screen.findByText('2 / 3')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' }) // 次 → 3/3
    expect(await screen.findByText('3 / 3')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' }) // wrap → 1/3
    expect(await screen.findByText('1 / 3')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }) // 前 wrap → 3/3
    expect(await screen.findByText('3 / 3')).toBeTruthy()
  })

  it('case toggle で一致件数が変わる / no match 表示', async () => {
    setup({ loadPreview: () => Promise.resolve(previewDoc({ text: 'Foo foo' })) })
    await screen.findByLabelText('File contents')
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = (await screen.findByLabelText('Find')) as HTMLInputElement

    fireEvent.change(input, { target: { value: 'foo' } })
    expect(await screen.findByText('1 / 2')).toBeTruthy() // ci=2 件
    fireEvent.click(screen.getByLabelText('Match case'))
    expect(await screen.findByText('1 / 1')).toBeTruthy() // cs=1 件

    fireEvent.change(input, { target: { value: 'zzz' } })
    expect(await screen.findByText('No matches')).toBeTruthy()
    // 本文は残る。
    expect(screen.getByLabelText('File contents').textContent).toBe('Foo foo')
  })

  it('Escape は input 以外へ focus 移動後でも検索バーだけ閉じ、ウィンドウは閉じない', async () => {
    setup({ loadPreview: () => Promise.resolve(previewDoc({ text: 'foo foo' })) })
    await screen.findByLabelText('File contents')
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = (await screen.findByLabelText('Find')) as HTMLInputElement
    // query を入れて次へボタンを有効化し、そこへ focus を移してから window Escape。
    fireEvent.change(input, { target: { value: 'foo' } })
    const next = await screen.findByLabelText('Next match')
    next.focus()
    expect(document.activeElement).toBe(next)
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByLabelText('Find')).toBeNull()
    expect(window.close).not.toHaveBeenCalled()
  })

  it('設定（日本語 / テーマ）を適用する', async () => {
    const settings = { ...createDefaultSettings('ja'), theme: 'dark' as const }
    setup({ loadPreview: () => Promise.resolve(previewDoc()), settings })
    // 日本語ラベル。
    expect(await screen.findByText('リモート')).toBeTruthy()
    expect(screen.getByLabelText('再読込')).toBeTruthy()
    // テーマが root へ反映される。
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'))
  })
})
