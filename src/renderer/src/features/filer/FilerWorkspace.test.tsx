// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDefaultSettings } from '../../../../shared/settings'
import type { ConnectionTarget } from '../connection/connectionTypes'
import {
  calculateSplitRatio,
  centeredEditorPosition,
  clampEditorRect,
  defaultEditorSize,
  FilerWorkspace,
  MIN_EDITOR_HEIGHT,
  MIN_EDITOR_WIDTH,
  RemoteFilePane,
  resizeEditorRect,
} from './FilerWorkspace'

// jsdom の pointer capture は「アクティブな pointer がない」と例外を投げるため、ドラッグ系テスト用に no-op で上書きする。
Element.prototype.setPointerCapture = () => undefined
Element.prototype.releasePointerCapture = () => undefined

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const target: ConnectionTarget = {
  id: 'sftp-1',
  name: 'Production SFTP',
  kind: 'sftp',
  host: 'sftp.example.com',
  port: 22,
  username: 'user',
  password: 'password',
  rootPath: '/exports',
}

describe('RemoteFilePane', () => {
  it('ルートを取得し、フォルダ選択時にそのパスを取得する', async () => {
    const listStorage = vi
      .fn()
      .mockResolvedValueOnce([
        { name: 'daily', path: '/daily', type: 'directory', modifiedAt: '2026-06-12T12:00:00.000Z' },
        {
          name: 'README.md',
          path: '/README.md',
          type: 'file',
          size: 1200,
          modifiedAt: '2026-06-12T12:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([{ name: 'report.csv', path: '/daily/report.csv', type: 'file', size: 42 }])
      .mockResolvedValueOnce([])
    Object.defineProperty(window, 'hedgeport', {
      configurable: true,
      value: { listStorage },
    })

    render(<RemoteFilePane target={target} />)

    expect(await screen.findByText('daily')).toBeTruthy()
    expect(screen.getByText('README.md')).toBeTruthy()
    expect(screen.getByText('1.2 KB')).toBeTruthy()
    expect(screen.getByText('Modified')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Parent directory' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Reload directory' })).toBeTruthy()
    expect(listStorage).toHaveBeenCalledWith(target, '/')

    fireEvent.doubleClick(screen.getByText('daily').closest('tr')!)

    expect(await screen.findByText('report.csv')).toBeTruthy()
    await waitFor(() => expect(listStorage).toHaveBeenLastCalledWith(target, '/daily'))
    expect((screen.getByRole('button', { name: 'Parent directory' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '/' }))
    await waitFor(() => expect(listStorage).toHaveBeenLastCalledWith(target, '/'))
  })

  it('ローカルファイルは接続先ごとの最後の場所から開く', async () => {
    const listStorage = vi.fn().mockResolvedValue([])
    const listLocal = vi
      .fn()
      .mockResolvedValueOnce({
        path: '/work',
        parentPath: '/',
        entries: [{ name: 'daily', path: '/work/daily', type: 'directory' }],
      })
      .mockResolvedValueOnce({
        path: '/work/daily',
        parentPath: '/work',
        entries: [],
      })
      .mockResolvedValueOnce({
        path: '/work',
        parentPath: '/',
        entries: [{ name: 'daily', path: '/work/daily', type: 'directory' }],
      })
    const onSaveTarget = vi.fn()
    Object.defineProperty(window, 'hedgeport', {
      configurable: true,
      value: { listStorage, listLocal },
    })

    render(
      <FilerWorkspace
        target={{
          ...target,
          lastLocalPath: '/work',
        }}
        targets={[target]}
        onSaveTarget={onSaveTarget}
        onDeleteTarget={vi.fn()}
        onDisconnect={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show local files' }))
    await waitFor(() => expect(listLocal).toHaveBeenCalledWith('/work'))
    expect(listLocal).toHaveBeenCalledWith('/work')
    expect(screen.getAllByRole('button', { name: 'Back' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Forward' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Parent directory' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Reload directory' }).length).toBeGreaterThan(0)

    const dailyRow = (await screen.findByText('daily')).closest('tr')!
    fireEvent.doubleClick(dailyRow)
    await waitFor(() => expect(listLocal).toHaveBeenLastCalledWith('/work/daily'))

    fireEvent.click(screen.getByRole('button', { name: 'work' }))
    await waitFor(() => expect(listLocal).toHaveBeenLastCalledWith('/work'))

    await waitFor(() =>
      expect(onSaveTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          lastLocalPath: '/work/daily',
        })
      )
    )
  })

  it('一覧取得エラーを表示して再試行できる', async () => {
    const listStorage = vi.fn().mockRejectedValueOnce(new Error('Authentication failed')).mockResolvedValueOnce([])
    Object.defineProperty(window, 'hedgeport', {
      configurable: true,
      value: { listStorage },
    })

    render(<RemoteFilePane target={target} />)

    expect(await screen.findByText('Authentication failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('This directory is empty.')).toBeTruthy()
    expect(listStorage).toHaveBeenCalledTimes(2)
  })

  it('戻ると進むでディレクトリ履歴をたどれる', async () => {
    const listStorage = vi
      .fn()
      .mockResolvedValueOnce([{ name: 'daily', path: '/daily', type: 'directory' }])
      .mockResolvedValueOnce([{ name: 'report.csv', path: '/daily/report.csv', type: 'file' }])
      .mockResolvedValueOnce([{ name: 'daily', path: '/daily', type: 'directory' }])
      .mockResolvedValueOnce([{ name: 'report.csv', path: '/daily/report.csv', type: 'file' }])
    Object.defineProperty(window, 'hedgeport', {
      configurable: true,
      value: { listStorage },
    })

    render(<RemoteFilePane target={target} />)

    const dailyRow = (await screen.findByText('daily')).closest('tr')!
    fireEvent.doubleClick(dailyRow)
    expect(await screen.findByText('report.csv')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText('daily')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
    expect(await screen.findByText('report.csv')).toBeTruthy()
  })

  it('右クリックでファイル操作メニューを表示する', async () => {
    const listStorage = vi.fn().mockResolvedValue([
      { name: 'daily', path: '/daily', type: 'directory' },
      { name: 'report.csv', path: '/report.csv', type: 'file' },
    ])
    Object.defineProperty(window, 'hedgeport', {
      configurable: true,
      value: { listStorage },
    })

    render(<RemoteFilePane target={target} />)

    const reportRow = (await screen.findByText('report.csv')).closest('tr')!
    fireEvent.contextMenu(reportRow, { clientX: 120, clientY: 140 })

    expect(await screen.findByRole('menu', { name: 'report.csv actions' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Download to Local/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Download file…/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Copy path/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Delete/ })).toBeTruthy()
  })

  it('通常・Cmd/Ctrl・Shiftクリックで一覧選択できる', async () => {
    const listStorage = vi.fn().mockResolvedValue([
      { name: 'a.txt', path: '/a.txt', type: 'file' },
      { name: 'b.txt', path: '/b.txt', type: 'file' },
      { name: 'c.txt', path: '/c.txt', type: 'file' },
      { name: 'd.txt', path: '/d.txt', type: 'file' },
    ])
    Object.defineProperty(window, 'hedgeport', {
      configurable: true,
      value: { listStorage },
    })
    render(<RemoteFilePane target={target} />)

    const row = async (name: string): Promise<HTMLTableRowElement> =>
      (await screen.findByText(name)).closest('tr') as HTMLTableRowElement
    const a = await row('a.txt')
    const b = await row('b.txt')
    const c = await row('c.txt')
    const d = await row('d.txt')

    fireEvent.click(b)
    expect(b.getAttribute('aria-selected')).toBe('true')
    expect(a.getAttribute('aria-selected')).toBe('false')

    fireEvent.click(d, { metaKey: true })
    expect(b.getAttribute('aria-selected')).toBe('true')
    expect(d.getAttribute('aria-selected')).toBe('true')

    fireEvent.click(b, { ctrlKey: true })
    expect(b.getAttribute('aria-selected')).toBe('false')
    expect(d.getAttribute('aria-selected')).toBe('true')

    fireEvent.click(a)
    fireEvent.click(c, { shiftKey: true })
    expect(a.getAttribute('aria-selected')).toBe('true')
    expect(b.getAttribute('aria-selected')).toBe('true')
    expect(c.getAttribute('aria-selected')).toBe('true')
    expect(d.getAttribute('aria-selected')).toBe('false')
  })

  it('ヘッダーの全選択と検索で表示範囲を絞り込める', async () => {
    const listStorage = vi.fn().mockResolvedValue([
      { name: 'alpha.txt', path: '/alpha.txt', type: 'file' },
      { name: 'beta.txt', path: '/beta.txt', type: 'file' },
      { name: 'gamma.txt', path: '/gamma.txt', type: 'file' },
    ])
    Object.defineProperty(window, 'hedgeport', {
      configurable: true,
      value: { listStorage },
    })
    render(<RemoteFilePane target={target} />)

    const selectAll = await screen.findByLabelText('Select all')
    fireEvent.click(selectAll)

    expect((screen.getByLabelText('Select alpha.txt') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Select beta.txt') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Select gamma.txt') as HTMLInputElement).checked).toBe(true)

    const search = screen.getByPlaceholderText('Search files')
    fireEvent.change(search, { target: { value: 'beta' } })

    expect(screen.getByText('beta.txt')).toBeTruthy()
    expect(screen.queryByText('alpha.txt')).toBeNull()
    expect(screen.queryByText('gamma.txt')).toBeNull()

    fireEvent.click(selectAll)
    expect((screen.getByLabelText('Select beta.txt') as HTMLInputElement).checked).toBe(false)
  })

  it('ローカル側の右クリックではアップロード項目を表示する', async () => {
    const listStorage = vi.fn().mockResolvedValue([])
    const listLocal = vi.fn().mockResolvedValue({
      path: '/work',
      parentPath: '/',
      entries: [{ name: 'draft.txt', path: '/work/draft.txt', type: 'file' }],
    })
    Object.defineProperty(window, 'hedgeport', {
      configurable: true,
      value: { listStorage, listLocal },
    })

    render(
      <FilerWorkspace
        target={{ ...target, lastLocalPath: '/work' }}
        targets={[target]}
        onSaveTarget={vi.fn()}
        onDeleteTarget={vi.fn()}
        onDisconnect={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show local files' }))
    const draftRow = (await screen.findByText('draft.txt')).closest('tr')!
    fireEvent.contextMenu(draftRow, { clientX: 160, clientY: 180 })

    expect(await screen.findByRole('menu', { name: 'draft.txt actions' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Upload file/ })).toBeTruthy()
  })

  it('各ヘッダーでソート順を切り替えられる', async () => {
    const listStorage = vi.fn().mockResolvedValue([
      { name: 'bravo.txt', path: '/bravo.txt', type: 'file', size: 300 },
      { name: 'alpha.txt', path: '/alpha.txt', type: 'file', size: 100 },
      { name: 'charlie.txt', path: '/charlie.txt', type: 'file', size: 200 },
    ])
    Object.defineProperty(window, 'hedgeport', {
      configurable: true,
      value: { listStorage },
    })
    render(<RemoteFilePane target={target} />)

    expect(await screen.findByText('alpha.txt')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Size/ }))
    expect(screen.getAllByRole('row')[1].textContent).toContain('alpha.txt')
    expect(screen.getAllByRole('row')[2].textContent).toContain('charlie.txt')
    expect(screen.getAllByRole('row')[3].textContent).toContain('bravo.txt')

    fireEvent.click(screen.getByRole('button', { name: /Size/ }))
    expect(screen.getAllByRole('row')[1].textContent).toContain('bravo.txt')
    expect(screen.getAllByRole('row')[2].textContent).toContain('charlie.txt')
    expect(screen.getAllByRole('row')[3].textContent).toContain('alpha.txt')
  })

  it('S3 は初期ページで bucket をディレクトリ表示し、root では mutation を無効化する', async () => {
    const s3Target: ConnectionTarget = {
      id: 's3-1',
      name: 'Account S3',
      kind: 's3',
      region: 'ap-northeast-1',
      accessKeyId: 'AKIA...',
      secretAccessKey: 'secret',
      sessionToken: '',
    }
    const listStorage = vi
      .fn()
      .mockResolvedValueOnce([
        { name: 'bucket-a', path: '/bucket-a', type: 'directory' },
        { name: 'bucket-b', path: '/bucket-b', type: 'directory' },
      ])
      .mockResolvedValueOnce([
        { name: 'reports', path: '/bucket-a/reports', type: 'directory' },
        { name: 'a.txt', path: '/bucket-a/a.txt', type: 'file', size: 3 },
      ])
      .mockResolvedValueOnce([
        { name: 'bucket-a', path: '/bucket-a', type: 'directory' },
        { name: 'bucket-b', path: '/bucket-b', type: 'directory' },
      ])
    Object.defineProperty(window, 'hedgeport', { configurable: true, value: { listStorage } })

    render(<RemoteFilePane target={s3Target} />)

    // 初期ページ = bucket 一覧。
    expect(await screen.findByText('bucket-a')).toBeTruthy()
    expect(screen.getByText('bucket-b')).toBeTruthy()
    expect(listStorage).toHaveBeenCalledWith(s3Target, '/')
    // root では New Folder… / Open with… が無効。
    expect((screen.getByRole('button', { name: 'New Folder…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Open with…' }) as HTMLButtonElement).disabled).toBe(true)

    // bucket-a をダブルクリックで開く（bucket ルートへ移動）。
    fireEvent.doubleClick(screen.getByText('bucket-a').closest('tr')!)
    expect(await screen.findByText('reports')).toBeTruthy()
    await waitFor(() => expect(listStorage).toHaveBeenLastCalledWith(s3Target, '/bucket-a'))
    // bucket 内では New Folder… が有効に戻る。
    expect((screen.getByRole('button', { name: 'New Folder…' }) as HTMLButtonElement).disabled).toBe(false)

    // Up で bucket 一覧（root）へ戻る。
    fireEvent.click(screen.getByRole('button', { name: 'Parent directory' }))
    await waitFor(() => expect(listStorage).toHaveBeenLastCalledWith(s3Target, '/'))
  })

  it('S3 root で bucket が 0 件なら専用の空状態を表示する', async () => {
    const s3Target: ConnectionTarget = {
      id: 's3-1',
      name: 'Account S3',
      kind: 's3',
      region: 'ap-northeast-1',
      accessKeyId: 'AKIA...',
      secretAccessKey: 'secret',
      sessionToken: '',
    }
    const listStorage = vi.fn().mockResolvedValue([])
    Object.defineProperty(window, 'hedgeport', { configurable: true, value: { listStorage } })

    render(<RemoteFilePane target={s3Target} />)

    expect(await screen.findByText('No buckets are accessible in this region.')).toBeTruthy()
    // 検索結果 0 件は既存文言を維持する。
    fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'zzz' } })
    expect(await screen.findByText('No files match this search.')).toBeTruthy()
  })

  it('showHiddenFiles=false は "." 始まりのエントリを除外し、true で表示する', async () => {
    const entries = [
      { name: '.env', path: '/.env', type: 'file' as const },
      { name: 'visible.txt', path: '/visible.txt', type: 'file' as const },
    ]
    const listStorage = vi.fn().mockResolvedValue(entries)
    Object.defineProperty(window, 'hedgeport', { configurable: true, value: { listStorage } })

    const { rerender } = render(<RemoteFilePane target={target} showHiddenFiles={false} />)
    expect(await screen.findByText('visible.txt')).toBeTruthy()
    expect(screen.queryByText('.env')).toBeNull()

    rerender(<RemoteFilePane target={target} showHiddenFiles />)
    expect(await screen.findByText('.env')).toBeTruthy()
  })
})

describe('FilerWorkspace ファイル操作', () => {
  /**
   * リモート / ローカル両ペインを表示した状態でワークスペースを描画する共通セットアップ。
   */
  const renderWorkspace = async (
    overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
    settings?: Partial<import('../../../../shared/settings').AppSettings>
  ): Promise<void> => {
    const listStorage =
      overrides.listStorage ?? vi.fn().mockResolvedValue([{ name: 'a.txt', path: '/a.txt', type: 'file', size: 3 }])
    const listLocal =
      overrides.listLocal ??
      vi.fn().mockResolvedValue({
        path: '/work',
        parentPath: '/',
        entries: [{ name: 'draft.txt', path: '/work/draft.txt', type: 'file', size: 5 }],
      })
    const ok = { succeeded: 1, failures: [] }
    Object.defineProperty(window, 'hedgeport', {
      configurable: true,
      value: {
        listStorage,
        listLocal,
        openPreview: overrides.openPreview ?? vi.fn().mockResolvedValue(undefined),
        readText: overrides.readText ?? vi.fn().mockResolvedValue({ text: 'contents', encoding: 'utf-8', bom: false }),
        writeText: overrides.writeText ?? vi.fn().mockResolvedValue(undefined),
        pickDirectory: overrides.pickDirectory ?? vi.fn().mockResolvedValue('/chosen'),
        createRemoteDirectory: overrides.createRemoteDirectory ?? vi.fn().mockResolvedValue(undefined),
        renameRemote: overrides.renameRemote ?? vi.fn().mockResolvedValue(undefined),
        createLocalDirectory: overrides.createLocalDirectory ?? vi.fn().mockResolvedValue(undefined),
        renameLocal: overrides.renameLocal ?? vi.fn().mockResolvedValue(undefined),
        batchDownload: overrides.batchDownload ?? vi.fn().mockResolvedValue(ok),
        batchUpload: overrides.batchUpload ?? vi.fn().mockResolvedValue(ok),
        batchDeleteRemote: overrides.batchDeleteRemote ?? vi.fn().mockResolvedValue(ok),
        batchDeleteLocal: overrides.batchDeleteLocal ?? vi.fn().mockResolvedValue(ok),
        paste: overrides.paste ?? vi.fn().mockResolvedValue(ok),
        openLocalPath: overrides.openLocalPath ?? vi.fn().mockResolvedValue(undefined),
        revealInFolder: overrides.revealInFolder ?? vi.fn().mockResolvedValue(undefined),
        readLocalText:
          overrides.readLocalText ?? vi.fn().mockResolvedValue({ text: 'local', encoding: 'utf-8', bom: false }),
        writeLocalText: overrides.writeLocalText ?? vi.fn().mockResolvedValue(undefined),
        chooseApplication: overrides.chooseApplication ?? vi.fn().mockResolvedValue('/Applications/Edit.app'),
        startExternalEdit:
          overrides.startExternalEdit ??
          vi.fn().mockResolvedValue({ id: 's1', remotePath: '/a.txt', name: 'a.txt', dirty: false }),
        uploadExternalEdit: overrides.uploadExternalEdit ?? vi.fn().mockResolvedValue(undefined),
        discardExternalEdit: overrides.discardExternalEdit ?? vi.fn().mockResolvedValue(undefined),
        revealExternalEdit: overrides.revealExternalEdit ?? vi.fn().mockResolvedValue(undefined),
        listExternalSessions: overrides.listExternalSessions ?? vi.fn().mockResolvedValue([]),
      },
    })

    render(
      <FilerWorkspace
        target={{ ...target, lastLocalPath: '/work' }}
        targets={[target]}
        settings={{ ...createDefaultSettings('en'), ...settings }}
        onSaveTarget={vi.fn()}
        onDeleteTarget={vi.fn()}
        onDisconnect={vi.fn()}
      />
    )
    // ローカルペインを開いてから操作する。
    fireEvent.click(screen.getByRole('button', { name: 'Show local files' }))
    await screen.findByText('draft.txt')
  }

  it('リモートファイルをローカルの現在ディレクトリへ一括ダウンロードする', async () => {
    const batchDownload = vi.fn().mockResolvedValue({ succeeded: 1, failures: [] })
    await renderWorkspace({ batchDownload })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Download to Local/ }))

    await waitFor(() =>
      expect(batchDownload).toHaveBeenCalledWith(expect.objectContaining({ id: 'sftp-1' }), ['/a.txt'], '/work')
    )
    expect(await screen.findByText('Downloaded 1')).toBeTruthy()
  })

  it('ダイアログで選んだディレクトリへダウンロードする（キャンセルは no-op）', async () => {
    const batchDownload = vi.fn().mockResolvedValue({ succeeded: 1, failures: [] })
    const pickDirectory = vi.fn().mockResolvedValue('/chosen/dir')
    await renderWorkspace({ batchDownload, pickDirectory })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Download file…/ }))

    await waitFor(() =>
      expect(batchDownload).toHaveBeenCalledWith(expect.objectContaining({ id: 'sftp-1' }), ['/a.txt'], '/chosen/dir')
    )

    // キャンセル時は何もしない。
    const cancelled = vi.fn().mockResolvedValue({ succeeded: 0, failures: [] })
    const cancelPick = vi.fn().mockResolvedValue(null)
    await renderWorkspace({ batchDownload: cancelled, pickDirectory: cancelPick })
    const row2 = screen.getAllByText('a.txt')[0].closest('tr')!
    fireEvent.contextMenu(row2, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Download file…/ }))
    await waitFor(() => expect(cancelPick).toHaveBeenCalled())
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('ローカルペイン非表示時は Download to Local を無効化する', async () => {
    const downloadToDirectory = vi.fn().mockResolvedValue(undefined)
    // renderWorkspace はローカルペインを開くので、ここでは開かずに直接描画する。
    Object.defineProperty(window, 'hedgeport', {
      configurable: true,
      value: {
        listStorage: vi.fn().mockResolvedValue([{ name: 'a.txt', path: '/a.txt', type: 'file', size: 3 }]),
        listLocal: vi.fn().mockResolvedValue({ path: '/work', parentPath: '/', entries: [] }),
        downloadToDirectory,
      },
    })
    render(
      <FilerWorkspace
        target={{ ...target, lastLocalPath: '/work' }}
        targets={[target]}
        onSaveTarget={vi.fn()}
        onDeleteTarget={vi.fn()}
        onDisconnect={vi.fn()}
      />
    )

    const remoteRow = (await screen.findByText('a.txt')).closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })

    // 転送先を視認できないため Download to Local は無効。Download file… は使える。
    const toLocal = (await screen.findByRole('menuitem', { name: /Download to Local/ })) as HTMLButtonElement
    expect(toLocal.disabled).toBe(true)
    expect((screen.getByRole('menuitem', { name: /Download file…/ }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(toLocal)
    expect(downloadToDirectory).not.toHaveBeenCalled()
  })

  it('ローカルファイルをリモートの現在ディレクトリへ一括アップロードする', async () => {
    const batchUpload = vi.fn().mockResolvedValue({ succeeded: 1, failures: [] })
    await renderWorkspace({ batchUpload })

    const localRow = screen.getByText('draft.txt').closest('tr')!
    fireEvent.contextMenu(localRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Upload file/ }))

    await waitFor(() =>
      expect(batchUpload).toHaveBeenCalledWith(expect.objectContaining({ id: 'sftp-1' }), ['/work/draft.txt'], '/')
    )
    expect(await screen.findByText('Uploaded 1')).toBeTruthy()
  })

  it('確認後にリモートエントリを一括削除する', async () => {
    const batchDeleteRemote = vi.fn().mockResolvedValue({ succeeded: 1, failures: [] })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await renderWorkspace({ batchDeleteRemote })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete/ }))

    expect(confirmSpy).toHaveBeenCalled()
    await waitFor(() =>
      expect(batchDeleteRemote).toHaveBeenCalledWith(expect.objectContaining({ id: 'sftp-1' }), [
        { path: '/a.txt', type: 'file' },
      ])
    )
    expect(await screen.findByText('Deleted 1')).toBeTruthy()
  })

  it('確認をキャンセルすると削除しない', async () => {
    const batchDeleteRemote = vi.fn().mockResolvedValue({ succeeded: 0, failures: [] })
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await renderWorkspace({ batchDeleteRemote })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete/ }))

    expect(batchDeleteRemote).not.toHaveBeenCalled()
  })

  it('confirmBeforeDelete=false なら確認なしで削除する', async () => {
    const batchDeleteRemote = vi.fn().mockResolvedValue({ succeeded: 1, failures: [] })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await renderWorkspace({ batchDeleteRemote }, { confirmBeforeDelete: false })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete/ }))

    // confirm を出さずに削除する。
    expect(confirmSpy).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(batchDeleteRemote).toHaveBeenCalledWith(expect.objectContaining({ id: 'sftp-1' }), [
        { path: '/a.txt', type: 'file' },
      ])
    )
  })

  it('空白右クリックの New Folder でリモートにディレクトリを作る', async () => {
    const createRemoteDirectory = vi.fn().mockResolvedValue(undefined)
    await renderWorkspace({ createRemoteDirectory })

    // 行ではなく空白領域（検索ツールバー）を右クリックして背景メニューを開く。
    const remoteShell = document.querySelectorAll('.file-table-shell')[0] as HTMLElement
    fireEvent.contextMenu(remoteShell, { clientX: 5, clientY: 5 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /New Folder…/ }))

    const input = (await screen.findByLabelText('Folder name')) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'docs' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(createRemoteDirectory).toHaveBeenCalledWith(expect.objectContaining({ id: 'sftp-1' }), '/', 'docs')
    )
    expect(await screen.findByText('Created docs')).toBeTruthy()
  })

  it('Rename… モーダルでリモートエントリを改名する', async () => {
    const renameRemote = vi.fn().mockResolvedValue(undefined)
    await renderWorkspace({ renameRemote })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename…/ }))

    const input = (await screen.findByLabelText('New name')) as HTMLInputElement
    expect(input.value).toBe('a.txt')
    fireEvent.change(input, { target: { value: 'b.txt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    await waitFor(() =>
      expect(renameRemote).toHaveBeenCalledWith(expect.objectContaining({ id: 'sftp-1' }), '/a.txt', 'b.txt', 'file')
    )
  })

  it('ショートカット Mod+D でフォーカス中ペインの選択ファイルをダウンロードする', async () => {
    const batchDownload = vi.fn().mockResolvedValue({ succeeded: 1, failures: [] })
    await renderWorkspace({ batchDownload })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.mouseDown(remoteRow) // リモートペインをフォーカス
    fireEvent.click(remoteRow) // 単一選択
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true })

    await waitFor(() =>
      expect(batchDownload).toHaveBeenCalledWith(expect.objectContaining({ id: 'sftp-1' }), ['/a.txt'], '/work')
    )
  })

  it('入力中はグローバルショートカットを発火しない', async () => {
    const batchDownload = vi.fn().mockResolvedValue({ succeeded: 0, failures: [] })
    await renderWorkspace({ batchDownload })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.mouseDown(remoteRow)
    fireEvent.click(remoteRow)
    // 検索 input にフォーカスしている状況を模して input を event target にする。
    const search = screen.getAllByPlaceholderText('Search files')[0]
    fireEvent.keyDown(search, { key: 'd', ctrlKey: true })

    expect(batchDownload).not.toHaveBeenCalled()
  })

  it('リモートファイルを開いて編集し保存する', async () => {
    const readText = vi.fn().mockResolvedValue({ text: 'first line', encoding: 'utf-8', bom: false })
    const writeText = vi.fn().mockResolvedValue(undefined)
    await renderWorkspace({ readText, writeText })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open Enter' }))

    const textarea = (await screen.findByLabelText('File contents')) as HTMLTextAreaElement
    expect(textarea.value).toBe('first line')
    fireEvent.change(textarea, { target: { value: 'edited line' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sftp-1' }),
        '/a.txt',
        'edited line',
        'utf-8',
        false
      )
    )
    expect(await screen.findByText('Saved a.txt (utf-8)')).toBeTruthy()
  })

  it('バイナリ等で開けない場合はモーダルにエラーを表示する', async () => {
    const readText = vi
      .fn()
      .mockRejectedValue(new Error('File looks binary (contains NUL) and cannot be edited as text.'))
    await renderWorkspace({ readText })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open Enter' }))

    expect(await screen.findByText(/looks binary/)).toBeTruthy()
  })

  it('読み込んだ BOM を保持して保存に渡す', async () => {
    const readText = vi.fn().mockResolvedValue({ text: 'hi', encoding: 'utf-8', bom: true })
    const writeText = vi.fn().mockResolvedValue(undefined)
    await renderWorkspace({ readText, writeText })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open Enter' }))

    const textarea = (await screen.findByLabelText('File contents')) as HTMLTextAreaElement
    expect((screen.getByLabelText('UTF-8 BOM') as HTMLInputElement).checked).toBe(true)
    fireEvent.change(textarea, { target: { value: 'hi2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.objectContaining({ id: 'sftp-1' }), '/a.txt', 'hi2', 'utf-8', true)
    )
  })

  it('リモートファイルのダブルクリックは Preview（独立ウィンドウ）を開き Built-in Editor は開かない', async () => {
    const openPreview = vi.fn().mockResolvedValue(undefined)
    const readText = vi.fn().mockResolvedValue({ text: 'remote body', encoding: 'utf-8', bom: false })
    await renderWorkspace({ openPreview, readText })

    fireEvent.doubleClick(screen.getByText('a.txt').closest('tr')!)

    await waitFor(() =>
      expect(openPreview).toHaveBeenCalledWith({
        source: 'remote',
        target: expect.objectContaining({ id: 'sftp-1' }),
        path: '/a.txt',
        name: 'a.txt',
      })
    )
    // built-in editor は開かず、本文読み込みも行わない。
    expect(screen.queryByLabelText('File contents')).toBeNull()
    expect(readText).not.toHaveBeenCalled()
  })

  it('ローカルファイルのダブルクリックは Preview を開き System Default では開かない', async () => {
    const openPreview = vi.fn().mockResolvedValue(undefined)
    const openLocalPath = vi.fn().mockResolvedValue(undefined)
    await renderWorkspace({ openPreview, openLocalPath })

    fireEvent.doubleClick(screen.getByText('draft.txt').closest('tr')!)

    await waitFor(() =>
      expect(openPreview).toHaveBeenCalledWith({ source: 'local', path: '/work/draft.txt', name: 'draft.txt' })
    )
    // System Default（openLocalPath）は呼ばれない。
    expect(openLocalPath).not.toHaveBeenCalled()
  })

  it('ディレクトリのダブルクリックは open ではなくペイン内移動する', async () => {
    const listStorage = vi
      .fn()
      .mockResolvedValueOnce([{ name: 'sub', path: '/sub', type: 'directory' }])
      .mockResolvedValueOnce([{ name: 'inner.txt', path: '/sub/inner.txt', type: 'file' }])
    const readText = vi.fn().mockResolvedValue({ text: 'x', encoding: 'utf-8', bom: false })
    await renderWorkspace({ listStorage, readText })

    fireEvent.doubleClick(screen.getByText('sub').closest('tr')!)

    expect(await screen.findByText('inner.txt')).toBeTruthy()
    await waitFor(() => expect(listStorage).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'sftp-1' }), '/sub'))
    expect(readText).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('File contents')).toBeNull()
  })

  it('チェックボックスのダブルクリックではファイルを開かない', async () => {
    const readText = vi.fn().mockResolvedValue({ text: 'remote body', encoding: 'utf-8', bom: false })
    await renderWorkspace({ readText })

    fireEvent.doubleClick(screen.getByLabelText('Select a.txt'))

    expect(readText).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('File contents')).toBeNull()
  })

  it('エディタモーダルは移動・リサイズ用の構造を持ち、初期は中央配置される', async () => {
    await renderWorkspace()

    // Built-in Editor は context menu の Open（既定アクション）で開く。
    fireEvent.contextMenu(screen.getByText('a.txt').closest('tr')!, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open Enter' }))
    await screen.findByLabelText('File contents')

    const modal = document.querySelector('.editor-modal-floating') as HTMLElement
    expect(modal).toBeTruthy()
    // ドラッグハンドル（タイトル領域）と右下リサイズハンドルが存在する。
    expect(modal.querySelector('.editor-drag-handle')).toBeTruthy()
    expect(screen.getByLabelText('Resize editor')).toBeTruthy()
    // jsdom viewport(1024x768) に対し 8 割サイズで中央配置される。
    expect(modal.style.width).toBe('819px')
    expect(modal.style.height).toBe('614px')
    expect(modal.style.left).toBe('103px')
    expect(modal.style.top).toBe('77px')
  })

  it('ヘッダのタイトルドラッグでモーダルを移動し、画面外はクランプする', async () => {
    await renderWorkspace()

    fireEvent.contextMenu(screen.getByText('a.txt').closest('tr')!, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open Enter' }))
    await screen.findByLabelText('File contents')
    const modal = document.querySelector('.editor-modal-floating') as HTMLElement
    const handle = modal.querySelector('.editor-drag-handle') as HTMLElement

    // jsdom の PointerEvent は init の clientX を反映しないため、座標を持つ MouseEvent を直接 dispatch する。
    const firePointer = (target: Window | HTMLElement, type: string, clientX: number, clientY: number): void => {
      fireEvent(target, new MouseEvent(type, { clientX, clientY, button: 0, bubbles: true, cancelable: true }))
    }

    // 開始 (103,77) から +60,+40 ドラッグ → (163,117)。
    firePointer(handle, 'pointerdown', 200, 200)
    firePointer(window, 'pointermove', 260, 240)
    expect(modal.style.left).toBe('163px')
    expect(modal.style.top).toBe('117px')

    // 画面外へ大きく動かしてもモーダル全体が viewport 内（maxX=1024-819=205, maxY=768-614=154）。
    firePointer(window, 'pointermove', 100000, 100000)
    expect(modal.style.left).toBe('205px')
    expect(modal.style.top).toBe('154px')
    firePointer(window, 'pointerup', 0, 0)
  })

  it('ドラッグ中にエディタを閉じても window リスナーが残らない', async () => {
    await renderWorkspace()

    fireEvent.contextMenu(screen.getByText('a.txt').closest('tr')!, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open Enter' }))
    await screen.findByLabelText('File contents')
    const modal = document.querySelector('.editor-modal-floating') as HTMLElement
    const handle = modal.querySelector('.editor-drag-handle') as HTMLElement

    const firePointer = (target: Window | HTMLElement, type: string, clientX: number, clientY: number): void => {
      fireEvent(target, new MouseEvent(type, { clientX, clientY, button: 0, bubbles: true, cancelable: true }))
    }

    // ドラッグ開始 → pointerup を出さずにエディタを閉じる。
    firePointer(handle, 'pointerdown', 200, 200)
    fireEvent.click(screen.getByRole('button', { name: 'Close editor' }))
    expect(document.querySelector('.editor-modal-floating')).toBeNull()

    // 閉じた後の pointermove は何も起こさない（リスナー解除済み・例外も出ない）。
    expect(() => firePointer(window, 'pointermove', 5000, 5000)).not.toThrow()
    expect(document.querySelector('.editor-modal-floating')).toBeNull()
  })

  it('リモート初回読みは auto を要求し、検出した concrete encoding を表示・保存する', async () => {
    const readText = vi.fn().mockResolvedValue({ text: '日本語', encoding: 'shift_jis', bom: false })
    const writeText = vi.fn().mockResolvedValue(undefined)
    await renderWorkspace({ readText, writeText })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open Enter' }))

    await screen.findByLabelText('File contents')
    // 初回は auto 要求。NEVER save with auto: 検出された concrete (shift_jis) を select に表示する。
    expect(readText).toHaveBeenCalledWith(expect.objectContaining({ id: 'sftp-1' }), '/a.txt', 'auto')
    const select = screen.getByLabelText('Encoding') as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('shift_jis'))

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sftp-1' }),
        '/a.txt',
        '日本語',
        'shift_jis',
        false
      )
    )
  })

  it('UTF-8 不正時は文字コード選択を促し、shift_jis 選択で再読込できる', async () => {
    const readText = vi.fn(async (_target, _path, encoding?: string) => {
      // 初回は auto で読み、判定不能を模して文字コード選択を促す。手動 shift_jis で成功。
      if (encoding === undefined || encoding === 'auto' || encoding === 'utf-8') {
        throw new Error('This file is not valid UTF-8. Choose another encoding.')
      }
      return { text: '日本語テキスト', encoding: 'shift_jis', bom: false }
    })
    await renderWorkspace({ readText })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open Enter' }))

    // modal は閉じず、文字コード選択を促すエラー + encoding select が出る。
    expect(await screen.findByText(/not valid UTF-8/)).toBeTruthy()
    const select = screen.getByLabelText('Encoding') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'shift_jis' } })

    expect(await screen.findByDisplayValue('日本語テキスト')).toBeTruthy()
    await waitFor(() =>
      expect(readText).toHaveBeenCalledWith(expect.objectContaining({ id: 'sftp-1' }), '/a.txt', 'shift_jis')
    )
  })

  it('編集中の encoding 変更は確認し、現在 encoding で保存する', async () => {
    const readText = vi.fn().mockResolvedValue({ text: 'hello', encoding: 'utf-8', bom: false })
    const writeText = vi.fn().mockResolvedValue(undefined)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await renderWorkspace({ readText, writeText })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open Enter' }))

    const textarea = (await screen.findByLabelText('File contents')) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'edited' } })

    // 編集済みで encoding 変更 → confirm(false) なので再読込しない。
    fireEvent.change(screen.getByLabelText('Encoding'), { target: { value: 'euc-jp' } })
    expect(confirmSpy).toHaveBeenCalled()
    expect(readText).toHaveBeenCalledTimes(1) // 再読込なし

    // 保存は現在 encoding(utf-8) で行う。
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sftp-1' }),
        '/a.txt',
        'edited',
        'utf-8',
        false
      )
    )
  })

  it('空リモートディレクトリでも空白右クリックで New Folder を開ける', async () => {
    const createRemoteDirectory = vi.fn().mockResolvedValue(undefined)
    await renderWorkspace({ listStorage: vi.fn().mockResolvedValue([]), createRemoteDirectory })

    // 空ディレクトリでも FileTable が描画され、空白右クリックで背景メニューが出る。
    const remoteShell = document.querySelectorAll('.file-table-shell')[0] as HTMLElement
    fireEvent.contextMenu(remoteShell, { clientX: 5, clientY: 5 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /New Folder…/ }))

    const input = (await screen.findByLabelText('Folder name')) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'docs' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(createRemoteDirectory).toHaveBeenCalledWith(expect.objectContaining({ id: 'sftp-1' }), '/', 'docs')
    )
  })

  it('空リモートディレクトリでも Mod+Shift+N で New Folder を開ける', async () => {
    await renderWorkspace({ listStorage: vi.fn().mockResolvedValue([]) })

    const remoteShell = document.querySelectorAll('.file-table-shell')[0] as HTMLElement
    fireEvent.mouseDown(remoteShell) // リモートペインをフォーカス
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true, shiftKey: true })

    expect(await screen.findByLabelText('Folder name')).toBeTruthy()
  })

  it('Download file… のダイアログ待機中にタブを切り替えたら反映しない', async () => {
    const batchDownload = vi.fn().mockResolvedValue({ succeeded: 1, failures: [] })
    let resolvePick: (value: string | null) => void = () => undefined
    const pickDirectory = vi.fn().mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolvePick = resolve
        })
    )
    await renderWorkspace({ batchDownload, pickDirectory })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Download file…/ }))
    await waitFor(() => expect(pickDirectory).toHaveBeenCalled())

    // ダイアログ待機中に新規タブ（接続先 null）へ切り替える。
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    // ダイアログがディレクトリを返しても、スコープ不一致なので転送しない。
    resolvePick('/chosen')
    await new Promise((resolve) => setTimeout(resolve))

    expect(batchDownload).not.toHaveBeenCalled()
  })

  it('非 mac では Backspace で削除しない', async () => {
    const batchDeleteRemote = vi.fn().mockResolvedValue({ succeeded: 0, failures: [] })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await renderWorkspace({ batchDeleteRemote })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.mouseDown(remoteRow)
    fireEvent.click(remoteRow)
    fireEvent.keyDown(window, { key: 'Backspace' })

    expect(batchDeleteRemote).not.toHaveBeenCalled()
  })

  it('alt 併用ではショートカットを発火しない', async () => {
    const batchDownload = vi.fn().mockResolvedValue({ succeeded: 0, failures: [] })
    await renderWorkspace({ batchDownload })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.mouseDown(remoteRow)
    fireEvent.click(remoteRow)
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true, altKey: true })

    expect(batchDownload).not.toHaveBeenCalled()
  })

  it('複数選択を右クリックで維持し、まとめて削除する（件数ラベル）', async () => {
    const batchDeleteRemote = vi.fn().mockResolvedValue({ succeeded: 2, failures: [] })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await renderWorkspace({
      listStorage: vi.fn().mockResolvedValue([
        { name: 'a.txt', path: '/a.txt', type: 'file' },
        { name: 'b.txt', path: '/b.txt', type: 'file' },
      ]),
      batchDeleteRemote,
    })

    const aRow = screen.getByText('a.txt').closest('tr')!
    const bRow = screen.getByText('b.txt').closest('tr')!
    fireEvent.click(aRow)
    fireEvent.click(bRow, { ctrlKey: true })
    // 選択内を右クリック → 複数選択を維持。
    fireEvent.contextMenu(bRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete 2 items/ }))

    await waitFor(() =>
      expect(batchDeleteRemote).toHaveBeenCalledWith(expect.objectContaining({ id: 'sftp-1' }), [
        { path: '/a.txt', type: 'file' },
        { path: '/b.txt', type: 'file' },
      ])
    )
  })

  it('複数選択時は Rename が無効', async () => {
    await renderWorkspace({
      listStorage: vi.fn().mockResolvedValue([
        { name: 'a.txt', path: '/a.txt', type: 'file' },
        { name: 'b.txt', path: '/b.txt', type: 'file' },
      ]),
    })

    const aRow = screen.getByText('a.txt').closest('tr')!
    const bRow = screen.getByText('b.txt').closest('tr')!
    fireEvent.click(aRow)
    fireEvent.click(bRow, { ctrlKey: true })
    fireEvent.contextMenu(bRow, { clientX: 10, clientY: 10 })

    expect(((await screen.findByRole('menuitem', { name: /Rename…/ })) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Copy で内部クリップボードに記録し、空白右クリックの Paste で貼り付ける', async () => {
    const paste = vi.fn().mockResolvedValue({ succeeded: 1, failures: [] })
    await renderWorkspace({ paste })

    const aRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.click(aRow)
    fireEvent.contextMenu(aRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy Ctrl+C' }))
    expect(await screen.findByText('Copied 1')).toBeTruthy()

    // 空白右クリックの Paste（クリップボードがあるので有効）。
    const remoteShell = document.querySelectorAll('.file-table-shell')[0] as HTMLElement
    fireEvent.contextMenu(remoteShell, { clientX: 5, clientY: 5 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Paste Ctrl+V' }))

    await waitFor(() =>
      expect(paste).toHaveBeenCalledWith(
        expect.objectContaining({
          entries: [{ path: '/a.txt', name: 'a.txt', type: 'file' }],
          source: expect.objectContaining({ kind: 'remote' }),
          destination: expect.objectContaining({ kind: 'remote', directory: '/' }),
        })
      )
    )
  })

  it('ローカル右クリックメニューは Upload/Copy/Paste/Rename/Delete/New Folder を出す（対称）', async () => {
    await renderWorkspace()
    const draftRow = screen.getByText('draft.txt').closest('tr')!
    fireEvent.contextMenu(draftRow, { clientX: 10, clientY: 10 })

    expect(await screen.findByRole('menuitem', { name: /Upload file/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Copy Ctrl+C' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Paste Ctrl+V' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Rename…/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Delete/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /New Folder…/ })).toBeTruthy()
  })

  it('toolbar の Download は選択時に有効化され実行できる', async () => {
    const batchDownload = vi.fn().mockResolvedValue({ succeeded: 1, failures: [] })
    await renderWorkspace({ batchDownload })

    const downloadButton = () => screen.getAllByRole('button', { name: 'Download to Local' })[0] as HTMLButtonElement
    expect(downloadButton().disabled).toBe(true) // 未選択は無効

    fireEvent.click(screen.getByText('a.txt').closest('tr')!)
    await waitFor(() => expect(downloadButton().disabled).toBe(false))
    fireEvent.click(downloadButton())

    await waitFor(() =>
      expect(batchDownload).toHaveBeenCalledWith(expect.objectContaining({ id: 'sftp-1' }), ['/a.txt'], '/work')
    )
  })

  it('ローカルの Show in … で revealInFolder を呼ぶ', async () => {
    const revealInFolder = vi.fn().mockResolvedValue(undefined)
    await renderWorkspace({ revealInFolder })

    const draftRow = screen.getByText('draft.txt').closest('tr')!
    fireEvent.contextMenu(draftRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Show in/ }))

    await waitFor(() => expect(revealInFolder).toHaveBeenCalledWith('/work/draft.txt'))
  })

  it('ローカル空白メニューの Open Folder で現在ディレクトリを開く', async () => {
    const openLocalPath = vi.fn().mockResolvedValue(undefined)
    await renderWorkspace({ openLocalPath })

    const localShell = document.querySelectorAll('.file-table-shell')[1] as HTMLElement
    fireEvent.contextMenu(localShell, { clientX: 5, clientY: 5 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Open Folder in/ }))

    await waitFor(() => expect(openLocalPath).toHaveBeenCalledWith('/work'))
  })

  it('global の Open preview eye ボタンは廃止されている', async () => {
    await renderWorkspace()
    expect(screen.queryByRole('button', { name: 'Open preview' })).toBeNull()
  })

  it('toolbar の Open split button: ▼ で開き方メニューを出す（remote も全モード有効）', async () => {
    await renderWorkspace()
    fireEvent.click(screen.getByText('a.txt').closest('tr')!) // 単一選択
    // remote pane（先頭）の Open with… キャレット。
    fireEvent.click(screen.getAllByRole('button', { name: 'Open with…' })[0])

    expect(await screen.findByRole('menuitem', { name: /Preview/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Built-in Editor/ })).toBeTruthy()
    // Phase 2: remote の外部アプリ系も有効。
    expect((screen.getByRole('menuitem', { name: /System Default App/ }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('menuitem', { name: /Choose Application/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('remote System Default は外部編集セッションを開始しバナーに出す', async () => {
    const startExternalEdit = vi
      .fn()
      .mockResolvedValue({ id: 's1', remotePath: '/a.txt', name: 'a.txt', tempFilePath: '/tmp/x/a.txt' })
    await renderWorkspace({ startExternalEdit })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open… Ctrl+Enter' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /System Default App/ }))

    await waitFor(() =>
      expect(startExternalEdit).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sftp-1' }),
        '/a.txt',
        'system-default'
      )
    )
    // バナーに Upload/Reveal/Discard が出る。
    expect(await screen.findByRole('button', { name: 'Upload Changes' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reveal Local Copy' })).toBeTruthy()
  })

  it('外部編集バナーの Upload Changes / Discard が IPC を呼ぶ', async () => {
    const uploadExternalEdit = vi.fn().mockResolvedValue(undefined)
    const discardExternalEdit = vi.fn().mockResolvedValue(undefined)
    await renderWorkspace({ uploadExternalEdit, discardExternalEdit })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open… Ctrl+Enter' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Choose Application/ }))

    const upload = await screen.findByRole('button', { name: 'Upload Changes' })
    fireEvent.click(upload)
    await waitFor(() => expect(uploadExternalEdit).toHaveBeenCalledWith('s1'))
    expect(await screen.findByText('uploaded')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(discardExternalEdit).toHaveBeenCalledWith('s1'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Upload Changes' })).toBeNull())
  })

  it('Upload の conflict エラーをバナーに表示する（自動でやり直さない）', async () => {
    const uploadExternalEdit = vi.fn().mockRejectedValue(new Error('Remote file changed since you opened it.'))
    await renderWorkspace({ uploadExternalEdit })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open… Ctrl+Enter' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /System Default App/ }))

    fireEvent.click(await screen.findByRole('button', { name: 'Upload Changes' }))
    expect(await screen.findByText(/Remote file changed/)).toBeTruthy()
    // バナーは残る（破棄されない）。
    expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy()
  })

  it('window focus で dirty を取り直しバナーに modified を出す', async () => {
    const listExternalSessions = vi
      .fn()
      .mockResolvedValue([{ id: 's1', remotePath: '/a.txt', name: 'a.txt', dirty: true }])
    await renderWorkspace({ listExternalSessions })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open… Ctrl+Enter' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /System Default App/ }))
    expect(await screen.findByText('clean')).toBeTruthy()

    // 外部アプリから戻ってきた想定で focus → dirty 再取得。
    fireEvent.focus(window)
    expect(await screen.findByText('modified')).toBeTruthy()
  })

  it('Preview を選ぶと独立プレビューウィンドウを開き、built-in editor は開かない', async () => {
    const openPreview = vi.fn().mockResolvedValue(undefined)
    const readText = vi.fn().mockResolvedValue({ text: 'view me', encoding: 'utf-8', bom: false })
    await renderWorkspace({ openPreview, readText })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open… Ctrl+Enter' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Preview/ }))

    // 独立ウィンドウ起動要求が remote 種別 + path/name/target で呼ばれる。
    await waitFor(() =>
      expect(openPreview).toHaveBeenCalledWith({
        source: 'remote',
        target: expect.objectContaining({ id: 'sftp-1' }),
        path: '/a.txt',
        name: 'a.txt',
      })
    )
    // built-in editor（textarea）は開かない。読み取りもしない。
    expect(screen.queryByLabelText('File contents')).toBeNull()
    expect(readText).not.toHaveBeenCalled()
  })

  it('local の Preview は target なし・絶対パスの request で独立ウィンドウを開く', async () => {
    const openPreview = vi.fn().mockResolvedValue(undefined)
    await renderWorkspace({ openPreview })

    // ローカルペイン（renderWorkspace で表示済み）の draft.txt を Preview。
    const localRow = screen.getByText('draft.txt').closest('tr')!
    fireEvent.contextMenu(localRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open… Ctrl+Enter' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Preview/ }))

    await waitFor(() =>
      expect(openPreview).toHaveBeenCalledWith({ source: 'local', path: '/work/draft.txt', name: 'draft.txt' })
    )
    // local request に target は含めない。
    expect(openPreview.mock.calls[0][0]).not.toHaveProperty('target')
  })

  it('Preview 起動失敗は status bar にエラー表示する', async () => {
    const openPreview = vi.fn().mockRejectedValue(new Error('preview boom'))
    await renderWorkspace({ openPreview })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open… Ctrl+Enter' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Preview/ }))

    expect(await screen.findByText('preview boom')).toBeTruthy()
  })

  it('ローカルの Built-in Editor は local read/write を使う', async () => {
    const readLocalText = vi.fn().mockResolvedValue({ text: 'local body', encoding: 'utf-8', bom: false })
    const writeLocalText = vi.fn().mockResolvedValue(undefined)
    await renderWorkspace({ readLocalText, writeLocalText })

    const draftRow = screen.getByText('draft.txt').closest('tr')!
    fireEvent.contextMenu(draftRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open… Ctrl+Enter' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Built-in Editor/ }))

    const textarea = (await screen.findByLabelText('File contents')) as HTMLTextAreaElement
    expect(textarea.value).toBe('local body')
    // 初回読みは auto。保存は検出された concrete encoding (utf-8) を使う。
    await waitFor(() => expect(readLocalText).toHaveBeenCalledWith('/work/draft.txt', 'auto'))
    fireEvent.change(textarea, { target: { value: 'edited local' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(writeLocalText).toHaveBeenCalledWith('/work/draft.txt', 'edited local', 'utf-8', false))
  })

  it('ローカルの System Default は openLocalPath、Choose Application は chooseApplication を呼ぶ', async () => {
    const openLocalPath = vi.fn().mockResolvedValue(undefined)
    const chooseApplication = vi.fn().mockResolvedValue('/Applications/Edit.app')
    await renderWorkspace({ openLocalPath, chooseApplication })

    const draftRow = screen.getByText('draft.txt').closest('tr')!
    fireEvent.contextMenu(draftRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open… Ctrl+Enter' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /System Default App/ }))
    await waitFor(() => expect(openLocalPath).toHaveBeenCalledWith('/work/draft.txt'))

    fireEvent.contextMenu(draftRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open… Ctrl+Enter' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Choose Application/ }))
    await waitFor(() => expect(chooseApplication).toHaveBeenCalledWith('/work/draft.txt'))
  })

  it('ローカルファイルの既定 Open（Enter/context menu）は System Default で開く', async () => {
    const openLocalPath = vi.fn().mockResolvedValue(undefined)
    await renderWorkspace({ openLocalPath })

    const draftRow = screen.getByText('draft.txt').closest('tr')!
    fireEvent.contextMenu(draftRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open Enter' }))

    await waitFor(() => expect(openLocalPath).toHaveBeenCalledWith('/work/draft.txt'))
  })

  it('検索ツールバーが各ペインに存在する（固定バー構造）', async () => {
    await renderWorkspace()
    // remote + local の 2 ペイン分の固定 toolbar。
    expect(document.querySelectorAll('.table-toolbar').length).toBe(2)
    expect(document.querySelectorAll('.pane-action-toolbar').length).toBe(2)
    // 一覧だけがスクロールするスクロール領域。
    expect(document.querySelectorAll('.file-table-scroll').length).toBe(2)
  })

  it('検索は可視ラベルを持たず aria-label=Search files の input を出す', async () => {
    await renderWorkspace()
    expect(screen.queryByText('File search')).toBeNull()
    expect(screen.getAllByLabelText('Search files').length).toBe(2)
  })

  it('rename 送信中にタブを切り替えると旧失敗を新状態へ注入しない', async () => {
    let rejectRename: (reason: Error) => void = () => undefined
    const renameRemote = vi.fn().mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRename = reject
        })
    )
    await renderWorkspace({ renameRemote })

    const remoteRow = screen.getByText('a.txt').closest('tr')!
    fireEvent.contextMenu(remoteRow, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename…/ }))
    const input = await screen.findByLabelText('New name')
    fireEvent.change(input, { target: { value: 'b.txt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(renameRemote).toHaveBeenCalled())

    // 送信中に新規タブ（接続先 null）へ切替 → reset effect が dialog を閉じる。
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    expect(screen.queryByLabelText('New name')).toBeNull()

    // 旧 rename の失敗が後から届いても、閉じた dialog を再表示・エラー注入しない。
    rejectRename(new Error('stale failure'))
    await new Promise((resolve) => setTimeout(resolve))
    expect(screen.queryByLabelText('New name')).toBeNull()
    expect(screen.queryByText('stale failure')).toBeNull()
  })

  it('ローカル移動でリモートのディレクトリが変わらない（ペイン独立）', async () => {
    const listStorage = vi
      .fn()
      .mockResolvedValueOnce([{ name: 'reports', path: '/reports', type: 'directory' }])
      .mockResolvedValueOnce([{ name: 'r.csv', path: '/reports/r.csv', type: 'file' }])
    const listLocal = vi
      .fn()
      .mockResolvedValueOnce({
        path: '/work',
        parentPath: '/',
        entries: [{ name: 'sub', path: '/work/sub', type: 'directory' }],
      })
      .mockResolvedValueOnce({ path: '/work/sub', parentPath: '/work', entries: [] })
    Object.defineProperty(window, 'hedgeport', {
      configurable: true,
      value: { listStorage, listLocal },
    })

    render(
      <FilerWorkspace
        target={{ ...target, lastLocalPath: '/work' }}
        targets={[target]}
        onSaveTarget={vi.fn()}
        onDeleteTarget={vi.fn()}
        onDisconnect={vi.fn()}
      />
    )

    // リモートを /reports へ移動。
    fireEvent.doubleClick((await screen.findByText('reports')).closest('tr')!)
    expect(await screen.findByText('r.csv')).toBeTruthy()

    // ローカルペインを開き、サブディレクトリへ移動（lastLocalPath 保存で target 参照が更新される）。
    fireEvent.click(screen.getByRole('button', { name: 'Show local files' }))
    fireEvent.doubleClick((await screen.findByText('sub')).closest('tr')!)
    await waitFor(() => expect(listLocal).toHaveBeenLastCalledWith('/work/sub'))

    // リモートは /reports のまま。ルート再取得（listStorage('/')）は初回の 1 度きり。
    expect(screen.getByText('r.csv')).toBeTruthy()
    expect(listStorage.mock.calls.filter((call) => call[1] === '/').length).toBe(1)
  })
})

describe('calculateSplitRatio', () => {
  it('ポインター位置を分割比率へ変換する', () => {
    expect(calculateSplitRatio(350, 100, 500)).toBe(50)
  })

  it('左右の最小幅を20%に制限する', () => {
    expect(calculateSplitRatio(0, 100, 500)).toBe(20)
    expect(calculateSplitRatio(700, 100, 500)).toBe(80)
  })
})

describe('editor modal geometry helpers', () => {
  const viewport = { width: 1000, height: 800 }

  it('defaultEditorSize は viewport の 8 割を実効 min / 上限でクランプする', () => {
    expect(defaultEditorSize(viewport)).toEqual({ width: 800, height: 640 })
    // viewport が設定 min より小さい場合は overflow させず viewport 寸法まで縮退する。
    expect(defaultEditorSize({ width: 300, height: 200 })).toEqual({ width: 300, height: 200 })
  })

  it('centeredEditorPosition は viewport 中央へ配置する', () => {
    expect(centeredEditorPosition({ width: 800, height: 640 }, viewport)).toEqual({ x: 100, y: 80 })
  })

  it('clampEditorRect はサイズと位置を合わせてモーダル全体を viewport 内へ収める', () => {
    // 既に収まる矩形はそのまま。
    expect(clampEditorRect({ x: 100, y: 80, width: 800, height: 640 }, viewport)).toEqual({
      x: 100,
      y: 80,
      width: 800,
      height: 640,
    })
    // 負座標は 0 へ。
    expect(clampEditorRect({ x: -50, y: -30, width: 400, height: 300 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    })
    // (a) 800px 幅モーダルを右下へドラッグしても、サイズ維持で位置を [0, viewport-size] に収める。
    expect(clampEditorRect({ x: 904, y: 704, width: 800, height: 640 }, viewport)).toEqual({
      x: 200,
      y: 160,
      width: 800,
      height: 640,
    })
    // サイズが viewport を超える場合は viewport 上限へ。
    expect(clampEditorRect({ x: 0, y: 0, width: 5000, height: 5000 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 800,
    })
  })

  it('clampEditorRect は (c) viewport が設定 min より小さくても overflow させない', () => {
    expect(clampEditorRect({ x: 50, y: 50, width: 800, height: 600 }, { width: 300, height: 200 })).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    })
  })

  it('resizeEditorRect は (b) 左上を固定し最大サイズを現在位置で使える領域に制限する', () => {
    const start = { x: 200, y: 160, width: 400, height: 300 }
    // 通常の拡大。
    expect(resizeEditorRect(start, 100, 50, viewport)).toEqual({ x: 200, y: 160, width: 500, height: 350 })
    // 右下方向へ大きく拡大しても right/bottom edge が viewport を超えない（maxW=800, maxH=640）。
    expect(resizeEditorRect(start, 5000, 5000, viewport)).toEqual({ x: 200, y: 160, width: 800, height: 640 })
    // 縮小は実効 min まで。
    expect(resizeEditorRect(start, -5000, -5000, viewport)).toEqual({
      x: 200,
      y: 160,
      width: MIN_EDITOR_WIDTH,
      height: MIN_EDITOR_HEIGHT,
    })
  })
})
