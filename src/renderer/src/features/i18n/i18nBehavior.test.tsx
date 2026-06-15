// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConnectionTarget } from '../connection/connectionTypes'
import { ConnectionForm } from '../connection/ConnectionForm'
import { FilerWorkspace, formatModifiedAt } from '../filer/FilerWorkspace'
import { I18nProvider } from './I18nContext'

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
}

describe('ConnectionForm i18n', () => {
  it('en では英語ラベル', () => {
    render(
      <I18nProvider language="en">
        <ConnectionForm onSave={vi.fn()} onCancel={vi.fn()} />
      </I18nProvider>
    )
    expect(screen.getByText('New connection')).toBeTruthy()
    expect(screen.getByLabelText('Display name')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add connection' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeTruthy()
  })

  it('ja では日本語ラベル', () => {
    render(
      <I18nProvider language="ja">
        <ConnectionForm onSave={vi.fn()} onCancel={vi.fn()} />
      </I18nProvider>
    )
    expect(screen.getByText('新規接続')).toBeTruthy()
    expect(screen.getByLabelText('表示名')).toBeTruthy()
    expect(screen.getByRole('button', { name: '接続を追加' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '接続テスト' })).toBeTruthy()
  })

  it('Save/Add クリック（submit）でも en の validation が出る（noValidate）', () => {
    render(
      <I18nProvider language="en">
        <ConnectionForm onSave={vi.fn()} onCancel={vi.fn()} />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
    expect(screen.getByText('Display name is required.')).toBeTruthy()
  })

  it('Save/Add クリック（submit）でも ja の validation が出る（noValidate）', () => {
    render(
      <I18nProvider language="ja">
        <ConnectionForm onSave={vi.fn()} onCancel={vi.fn()} />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: '接続を追加' }))
    expect(screen.getByText('表示名は必須です。')).toBeTruthy()
  })

  it('編集フローのラベルを en/ja で出す', () => {
    const target: ConnectionTarget = { ...sftp, lastLocalPath: '/work' }
    const { rerender } = render(
      <I18nProvider language="en">
        <ConnectionForm target={target} onSave={vi.fn()} onCancel={vi.fn()} onDelete={vi.fn()} />
      </I18nProvider>
    )
    expect(screen.getByText('Edit connection')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete connection' })).toBeTruthy()

    rerender(
      <I18nProvider language="ja">
        <ConnectionForm target={target} onSave={vi.fn()} onCancel={vi.fn()} onDelete={vi.fn()} />
      </I18nProvider>
    )
    expect(screen.getByText('接続を編集')).toBeTruthy()
    expect(screen.getByRole('button', { name: '変更を保存' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '接続を削除' })).toBeTruthy()
  })
})

describe('FilerWorkspace i18n', () => {
  const renderWorkspace = (language: 'ja' | 'en') => {
    const listStorage = vi.fn().mockResolvedValue([{ name: 'a.txt', path: '/a.txt', type: 'file' }])
    Object.defineProperty(window, 'hedgeport', { configurable: true, value: { listStorage } })
    return render(
      <I18nProvider language={language}>
        <FilerWorkspace
          target={sftp}
          targets={[sftp]}
          onSaveTarget={vi.fn()}
          onDeleteTarget={vi.fn()}
          onDisconnect={vi.fn()}
        />
      </I18nProvider>
    )
  }

  it('ツールバー / ナビ / 検索を ja で表示する', async () => {
    renderWorkspace('ja')
    expect(await screen.findByText('a.txt')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'ローカルファイルを表示' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '設定' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '切断' })).toBeTruthy()
    expect(screen.getByLabelText('ファイルを検索')).toBeTruthy()
    expect(screen.getByRole('button', { name: '親ディレクトリ' })).toBeTruthy()
  })

  it('開いたままの名前入力ダイアログも言語切替で固定ラベルが更新される', async () => {
    const { rerender } = renderWorkspace('en')
    await screen.findByText('a.txt')
    // New Folder… を開く（名前入力ダイアログ）。
    fireEvent.click(screen.getByRole('button', { name: 'New Folder…' }))
    expect(await screen.findByRole('heading', { name: 'New folder' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy()

    rerender(
      <I18nProvider language="ja">
        <FilerWorkspace
          target={sftp}
          targets={[sftp]}
          onSaveTarget={vi.fn()}
          onDeleteTarget={vi.fn()}
          onDisconnect={vi.fn()}
        />
      </I18nProvider>
    )
    // ダイアログを開いたまま、固定ラベルが日本語へ即時切替。
    expect(await screen.findByRole('heading', { name: '新規フォルダ' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '作成' })).toBeTruthy()
  })

  it('開いた context menu が言語切替で即時に日本語化する', async () => {
    const { rerender } = renderWorkspace('en')
    const row = (await screen.findByText('a.txt')).closest('tr')!
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    expect(await screen.findByRole('menuitem', { name: /Download to Local/ })).toBeTruthy()

    rerender(
      <I18nProvider language="ja">
        <FilerWorkspace
          target={sftp}
          targets={[sftp]}
          onSaveTarget={vi.fn()}
          onDeleteTarget={vi.fn()}
          onDisconnect={vi.fn()}
        />
      </I18nProvider>
    )
    // 開いたままのメニュー項目が日本語へ。
    expect(screen.getByRole('menuitem', { name: /ローカルへダウンロード/ })).toBeTruthy()
  })

  it('rename ダイアログのタイトル/ボタンを ja で出す', async () => {
    renderWorkspace('ja')
    const row = (await screen.findByText('a.txt')).closest('tr')!
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /名前を変更…/ }))
    expect(await screen.findByRole('heading', { name: 'a.txt の名前を変更' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '名前を変更' })).toBeTruthy()
  })

  it('Built-in Editor の主要ラベルを ja で出す', async () => {
    const listStorage = vi.fn().mockResolvedValue([{ name: 'a.txt', path: '/a.txt', type: 'file' }])
    const readText = vi.fn().mockResolvedValue({ text: 'hi', encoding: 'utf-8', bom: false })
    Object.defineProperty(window, 'hedgeport', { configurable: true, value: { listStorage, readText } })
    render(
      <I18nProvider language="ja">
        <FilerWorkspace
          target={sftp}
          targets={[sftp]}
          onSaveTarget={vi.fn()}
          onDeleteTarget={vi.fn()}
          onDisconnect={vi.fn()}
        />
      </I18nProvider>
    )
    // ファイルのダブルクリックは独立プレビューを開くため、Built-in Editor は context menu の Open で開く。
    const row = (await screen.findByText('a.txt')).closest('tr')!
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: '開く Enter' }))
    expect(await screen.findByLabelText('ファイル内容')).toBeTruthy()
    expect(screen.getByLabelText('文字コード')).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy()
  })

  it('削除確認は en/ja で単数・複数を出し分ける', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const twoFiles = [
      { name: 'a.txt', path: '/a.txt', type: 'file' as const },
      { name: 'b.txt', path: '/b.txt', type: 'file' as const },
    ]
    const listStorage = vi.fn().mockResolvedValue(twoFiles)
    Object.defineProperty(window, 'hedgeport', { configurable: true, value: { listStorage } })

    const { rerender } = render(
      <I18nProvider language="en">
        <FilerWorkspace
          target={sftp}
          targets={[sftp]}
          onSaveTarget={vi.fn()}
          onDeleteTarget={vi.fn()}
          onDisconnect={vi.fn()}
        />
      </I18nProvider>
    )
    // 単数: 1 件選択して削除。
    const rowA = (await screen.findByText('a.txt')).closest('tr')!
    fireEvent.click(rowA)
    fireEvent.contextMenu(rowA, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Delete/ }))
    expect(confirmSpy).toHaveBeenLastCalledWith('Delete “a.txt”? This cannot be undone.')

    // 複数（en 複数形）: 全選択して削除。
    fireEvent.click(screen.getByLabelText('Select all'))
    fireEvent.contextMenu(rowA, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Delete/ }))
    expect(confirmSpy).toHaveBeenLastCalledWith('Delete 2 files? This cannot be undone.')

    // 複数（ja）。
    rerender(
      <I18nProvider language="ja">
        <FilerWorkspace
          target={sftp}
          targets={[sftp]}
          onSaveTarget={vi.fn()}
          onDeleteTarget={vi.fn()}
          onDisconnect={vi.fn()}
        />
      </I18nProvider>
    )
    // 選択（2 件）は言語切替後も保持される。そのまま削除して ja 複数表現を確認。
    fireEvent.contextMenu((await screen.findByText('a.txt')).closest('tr')!, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /削除/ }))
    expect(confirmSpy).toHaveBeenLastCalledWith('2 件のファイルを削除しますか？この操作は元に戻せません。')
  })

  it('rename ダイアログ（remote）を en で出す', async () => {
    renderWorkspace('en')
    const row = (await screen.findByText('a.txt')).closest('tr')!
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename…/ }))
    expect(await screen.findByRole('heading', { name: 'Rename a.txt' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy()
  })

  it('rename ダイアログ（local）を en/ja で出す', async () => {
    const renderLocal = (language: 'ja' | 'en') => {
      const listStorage = vi.fn().mockResolvedValue([])
      const listLocal = vi.fn().mockResolvedValue({
        path: '/work',
        parentPath: '/',
        entries: [{ name: 'local.txt', path: '/work/local.txt', type: 'file' }],
      })
      Object.defineProperty(window, 'hedgeport', { configurable: true, value: { listStorage, listLocal } })
      return render(
        <I18nProvider language={language}>
          <FilerWorkspace
            target={{ ...sftp, lastLocalPath: '/work' }}
            targets={[sftp]}
            onSaveTarget={vi.fn()}
            onDeleteTarget={vi.fn()}
            onDisconnect={vi.fn()}
          />
        </I18nProvider>
      )
    }

    renderLocal('en')
    fireEvent.click(screen.getByRole('button', { name: 'Show local files' }))
    let row = (await screen.findByText('local.txt')).closest('tr')!
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename…/ }))
    expect(await screen.findByRole('heading', { name: 'Rename local.txt' })).toBeTruthy()
    cleanup()

    renderLocal('ja')
    fireEvent.click(screen.getByRole('button', { name: 'ローカルファイルを表示' }))
    row = (await screen.findByText('local.txt')).closest('tr')!
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /名前を変更…/ }))
    expect(await screen.findByRole('heading', { name: 'local.txt の名前を変更' })).toBeTruthy()
  })

  it('Built-in Editor の主要ラベルを en で出す', async () => {
    const listStorage = vi.fn().mockResolvedValue([{ name: 'a.txt', path: '/a.txt', type: 'file' }])
    const readText = vi.fn().mockResolvedValue({ text: 'hi', encoding: 'utf-8', bom: false })
    Object.defineProperty(window, 'hedgeport', { configurable: true, value: { listStorage, readText } })
    render(
      <I18nProvider language="en">
        <FilerWorkspace
          target={sftp}
          targets={[sftp]}
          onSaveTarget={vi.fn()}
          onDeleteTarget={vi.fn()}
          onDisconnect={vi.fn()}
        />
      </I18nProvider>
    )
    // ファイルのダブルクリックは独立プレビューを開くため、Built-in Editor は context menu の Open で開く。
    const row = (await screen.findByText('a.txt')).closest('tr')!
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open Enter' }))
    expect(await screen.findByLabelText('File contents')).toBeTruthy()
    expect(screen.getByLabelText('Encoding')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })

  it('Preview メニュー（en/ja）は独立プレビューウィンドウを開く', async () => {
    const open = async (language: 'ja' | 'en', openLabel: RegExp, previewLabel: string) => {
      const listStorage = vi.fn().mockResolvedValue([{ name: 'a.txt', path: '/a.txt', type: 'file' }])
      const openPreview = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(window, 'hedgeport', { configurable: true, value: { listStorage, openPreview } })
      render(
        <I18nProvider language={language}>
          <FilerWorkspace
            target={sftp}
            targets={[sftp]}
            onSaveTarget={vi.fn()}
            onDeleteTarget={vi.fn()}
            onDisconnect={vi.fn()}
          />
        </I18nProvider>
      )
      const row = (await screen.findByText('a.txt')).closest('tr')!
      fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
      fireEvent.click(await screen.findByRole('menuitem', { name: openLabel }))
      fireEvent.click(await screen.findByRole('menuitem', { name: previewLabel }))
      return openPreview
    }

    const openPreviewEn = await open('en', /Open…/, 'Preview')
    await waitFor(() =>
      expect(openPreviewEn).toHaveBeenCalledWith({
        source: 'remote',
        target: expect.objectContaining({ id: sftp.id }),
        path: '/a.txt',
        name: 'a.txt',
      })
    )
    // in-app の読み取り専用ダイアログは開かない。
    expect(screen.queryByLabelText('File contents')).toBeNull()
    cleanup()

    const openPreviewJa = await open('ja', /開く…/, 'プレビュー')
    await waitFor(() => expect(openPreviewJa).toHaveBeenCalledTimes(1))
  })

  it('batch 部分失敗の status は言語切替で再翻訳される', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const listStorage = vi.fn().mockResolvedValue([{ name: 'a.txt', path: '/a.txt', type: 'file' }])
    const batchDeleteRemote = vi
      .fn()
      .mockResolvedValue({ succeeded: 1, failures: [{ path: '/b.txt', message: 'denied' }] })
    Object.defineProperty(window, 'hedgeport', { configurable: true, value: { listStorage, batchDeleteRemote } })

    const { rerender } = render(
      <I18nProvider language="en">
        <FilerWorkspace
          target={sftp}
          targets={[sftp]}
          onSaveTarget={vi.fn()}
          onDeleteTarget={vi.fn()}
          onDisconnect={vi.fn()}
        />
      </I18nProvider>
    )
    const row = (await screen.findByText('a.txt')).closest('tr')!
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Delete/ }))
    expect(await screen.findByText('1 succeeded, 1 failed (denied)')).toBeTruthy()

    // 言語切替で同じ status が日本語へ（key+params 保持のため再翻訳）。
    rerender(
      <I18nProvider language="ja">
        <FilerWorkspace
          target={sftp}
          targets={[sftp]}
          onSaveTarget={vi.fn()}
          onDeleteTarget={vi.fn()}
          onDisconnect={vi.fn()}
        />
      </I18nProvider>
    )
    expect(await screen.findByText('成功 1 件、失敗 1 件（denied）')).toBeTruthy()
  })
})

describe('formatModifiedAt', () => {
  it('選択言語のロケールで日付を整形する（OS ロケール非依存）', () => {
    const iso = '2024-06-01T12:34:00.000Z'
    const en = formatModifiedAt(iso, 'en')
    const ja = formatModifiedAt(iso, 'ja')
    expect(en).not.toBe(ja)
    // ja-JP は年月日が `2024/06/01` 始まり。
    expect(ja.startsWith('2024/')).toBe(true)
  })
})
