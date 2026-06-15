// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDefaultSettings, type AppSettings } from '../../../../shared/settings'
import type { PreviewDocument, PreviewMeta, PreviewSaveResult } from '../../../../shared/preview'
import { MAX_EDITABLE_TEXT_BYTES, type TextEncoding } from '../../../../shared/transfer'
import { PreviewWindow } from './PreviewWindow'

beforeEach(() => {
  // jsdom 未実装の API をスタブする。
  Element.prototype.scrollIntoView = vi.fn()
  window.close = vi.fn()
  window.confirm = vi.fn().mockReturnValue(true)
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
  over: Partial<PreviewDocument> & { text?: string; encoding?: TextEncoding; bom?: boolean } = {}
): PreviewDocument => ({
  name: over.name ?? 'a.txt',
  displayPath: over.displayPath ?? '/remote/a.txt',
  source: over.source ?? 'remote',
  document: { text: over.text ?? 'hello world', encoding: over.encoding ?? 'utf-8', bom: over.bom ?? false },
  byteLength: over.byteLength ?? (over.text ?? 'hello world').length,
})

const previewMeta = (over: Partial<PreviewMeta> = {}): PreviewMeta => ({
  name: over.name ?? 'a.txt',
  displayPath: over.displayPath ?? '/remote/a.txt',
  source: over.source ?? 'remote',
})

/** window.hedgeport をモックして PreviewWindow を描画する。 */
function setup(opts: {
  loadPreview: (encoding?: unknown) => Promise<PreviewDocument>
  savePreview?: (request: unknown) => Promise<PreviewSaveResult>
  meta?: PreviewMeta
  settings?: AppSettings
}) {
  const loadSettings = vi.fn().mockResolvedValue(opts.settings ?? createDefaultSettings('en'))
  const loadPreview = vi.fn(opts.loadPreview)
  const savePreview = vi.fn(
    opts.savePreview ?? (() => Promise.resolve({ status: 'saved', revision: 'r', byteLength: 0 }))
  )
  const previewMetadata = vi.fn().mockResolvedValue(opts.meta ?? previewMeta())
  Object.defineProperty(window, 'hedgeport', {
    configurable: true,
    value: { loadSettings, loadPreview, savePreview, previewMetadata },
  })
  render(<PreviewWindow />)
  return { loadPreview, savePreview, previewMetadata }
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

  it('Edit ボタンで編集モードへ入り、編集して保存できる', async () => {
    const { savePreview } = setup({
      loadPreview: () => Promise.resolve(previewDoc({ text: 'hello', encoding: 'utf-8' })),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const textarea = (await screen.findByLabelText('File contents')) as HTMLTextAreaElement
    expect(textarea.tagName).toBe('TEXTAREA')
    expect(textarea.value).toBe('hello')

    // 未編集では Save 無効。編集すると有効。
    const saveButton = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(saveButton.disabled).toBe(true)
    fireEvent.change(textarea, { target: { value: 'hello world' } })
    expect(saveButton.disabled).toBe(false)

    fireEvent.click(saveButton)
    await waitFor(() =>
      expect(savePreview).toHaveBeenCalledWith({
        text: 'hello world',
        encoding: 'utf-8',
        bom: false,
        overwriteToken: undefined,
      })
    )
    expect(await screen.findByText('Saved')).toBeTruthy()
  })

  it('保存後に doc を更新し、Cancel→view→再 Edit で新本文を seed する', async () => {
    const savePreview = vi.fn(
      (_request: unknown): Promise<PreviewSaveResult> =>
        Promise.resolve({ status: 'saved', revision: 'r2', byteLength: 2 })
    )
    setup({ loadPreview: () => Promise.resolve(previewDoc({ text: 'a' })), savePreview })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    let textarea = (await screen.findByLabelText('File contents')) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'ab' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved')

    // Cancel で view へ。本文は新内容を表示（loadPreview の再呼び出しはしない）。
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    const body = await screen.findByLabelText('File contents')
    expect(body.tagName).toBe('PRE')
    expect(body.textContent).toBe('ab')

    // 再 Edit は古い 'a' ではなく新本文 'ab' を seed する（巻き戻し防止）。
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    textarea = (await screen.findByLabelText('File contents')) as HTMLTextAreaElement
    expect(textarea.value).toBe('ab')
  })

  it('Ctrl/Cmd+S でも保存する', async () => {
    const { savePreview } = setup({ loadPreview: () => Promise.resolve(previewDoc({ text: 'x' })) })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const textarea = (await screen.findByLabelText('File contents')) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'xy' } })
    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true })
    await waitFor(() => expect(savePreview).toHaveBeenCalledTimes(1))
  })

  it('編集上限を超えるファイルは編集不可メッセージを出し、閲覧を継続する', async () => {
    const { savePreview } = setup({
      loadPreview: () => Promise.resolve(previewDoc({ text: 'big', byteLength: MAX_EDITABLE_TEXT_BYTES + 1 })),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    // 編集には入らず（textarea は出ない）、メッセージを表示して閲覧（pre）を継続。
    expect(await screen.findByText(/cannot be edited/)).toBeTruthy()
    expect((screen.getByLabelText('File contents') as HTMLElement).tagName).toBe('PRE')
    expect(savePreview).not.toHaveBeenCalled()
  })

  it('保存時の競合は確認のうえ main 発行トークンで再保存する', async () => {
    let attempt = 0
    const savePreview = vi.fn((_request: unknown): Promise<PreviewSaveResult> => {
      attempt += 1
      return attempt === 1
        ? Promise.resolve({ status: 'conflict', token: 'tok-xyz' })
        : Promise.resolve({ status: 'saved', revision: 'r2', byteLength: 2 })
    })
    window.confirm = vi.fn().mockReturnValue(true)
    setup({ loadPreview: () => Promise.resolve(previewDoc({ text: 'a' })), savePreview })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const textarea = (await screen.findByLabelText('File contents')) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'ab' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(savePreview).toHaveBeenCalledTimes(2))
    // 初回はトークンなし、再保存は main が返したトークンを添える（renderer の真偽値ではない）。
    expect(savePreview.mock.calls[0][0]).toMatchObject({ overwriteToken: undefined })
    expect(savePreview.mock.calls[1][0]).toMatchObject({ overwriteToken: 'tok-xyz' })
  })

  it('競合確認を拒否すると上書きしない', async () => {
    const savePreview = vi.fn(
      (_request: unknown): Promise<PreviewSaveResult> => Promise.resolve({ status: 'conflict', token: 'tok-xyz' })
    )
    window.confirm = vi.fn().mockReturnValue(false)
    setup({ loadPreview: () => Promise.resolve(previewDoc({ text: 'a' })), savePreview })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const textarea = (await screen.findByLabelText('File contents')) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'ab' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(savePreview).toHaveBeenCalledTimes(1))
    // overwrite 再試行はしない。
    expect(savePreview).toHaveBeenCalledTimes(1)
  })

  it('未保存のまま閉じると確認し、承認時のみウィンドウを閉じる', async () => {
    setup({ loadPreview: () => Promise.resolve(previewDoc({ text: 'a' })) })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const textarea = (await screen.findByLabelText('File contents')) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'ab' } })

    // 拒否 → 閉じない。
    window.confirm = vi.fn().mockReturnValue(false)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(window.confirm).toHaveBeenCalled()
    expect(window.close).not.toHaveBeenCalled()

    // 承認 → 閉じる。
    window.confirm = vi.fn().mockReturnValue(true)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(window.close).toHaveBeenCalled()
  })

  it('編集モードでは検索バーを開かない（Ctrl+F 無効）', async () => {
    setup({ loadPreview: () => Promise.resolve(previewDoc({ text: 'foo foo' })) })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await screen.findByLabelText('File contents')
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(screen.queryByLabelText('Find')).toBeNull()
  })

  it('編集中の encoding 変更で再読込結果が編集上限超なら編集へ反映せず閲覧へ戻す', async () => {
    let call = 0
    setup({
      loadPreview: () => {
        call += 1
        // 初回(auto)は小さく編集可能、shift_jis 再読込は 1MiB 超で返す。
        return call === 1
          ? Promise.resolve(previewDoc({ text: 'small', encoding: 'utf-8' }))
          : Promise.resolve(previewDoc({ text: 'big', encoding: 'shift_jis', byteLength: MAX_EDITABLE_TEXT_BYTES + 1 }))
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const select = (await screen.findByLabelText('Encoding')) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'shift_jis' } })

    // 編集バッファへ入れず、閲覧へ戻して編集不可メッセージを出す。
    expect(await screen.findByText(/cannot be edited/)).toBeTruthy()
    await waitFor(() => expect((screen.getByLabelText('File contents') as HTMLElement).tagName).toBe('PRE'))
  })

  it('beforeunload: dirty 時は確認し、拒否で close をキャンセル / 承認で許可する', async () => {
    setup({ loadPreview: () => Promise.resolve(previewDoc({ text: 'a' })) })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const textarea = (await screen.findByLabelText('File contents')) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'ab' } })

    // 拒否 → preventDefault（close キャンセル）。
    window.confirm = vi.fn().mockReturnValue(false)
    const rejected = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(rejected)
    expect(window.confirm).toHaveBeenCalled()
    expect(rejected.defaultPrevented).toBe(true)

    // 承認 → preventDefault しない（close 許可）。
    window.confirm = vi.fn().mockReturnValue(true)
    const approved = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(approved)
    expect(approved.defaultPrevented).toBe(false)
  })

  it('beforeunload: 未編集ならダイアログを出さず close を許可する', async () => {
    setup({ loadPreview: () => Promise.resolve(previewDoc({ text: 'a' })) })
    await screen.findByLabelText('File contents')
    window.confirm = vi.fn()
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(window.confirm).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
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
