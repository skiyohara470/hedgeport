// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConnectionTarget } from '../connection/connectionTypes'
import { calculateSplitRatio, FilerWorkspace, RemoteFilePane } from './FilerWorkspace'

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
    const listStorage = vi
      .fn()
      .mockRejectedValueOnce(new Error('Authentication failed'))
      .mockResolvedValueOnce([])
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
    expect(screen.getByRole('menuitem', { name: 'Download file' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Copy path' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy()
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

    const search = screen.getByPlaceholderText('Search file names')
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
    expect(screen.getByRole('menuitem', { name: 'Upload file' })).toBeTruthy()
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
