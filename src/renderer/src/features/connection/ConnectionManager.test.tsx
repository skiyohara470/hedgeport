// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectionManager } from './ConnectionManager'
import type { ConnectionTarget } from './connectionTypes'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const target: ConnectionTarget = {
  id: 's3-1',
  name: 'Archive',
  kind: 's3',
  region: 'ap-northeast-1',
  accessKeyId: 'access-key',
  secretAccessKey: 'secret-key',
  sessionToken: '',
}

const sftp = (id: string): ConnectionTarget => ({
  id,
  name: id,
  kind: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'u',
  password: 'p',
  rootPath: '/',
})

describe('ConnectionManager 並び替え（DnD）', () => {
  it('welcome では drag handle を表示する', () => {
    render(
      <ConnectionManager
        targets={[sftp('a'), sftp('b')]}
        onSelect={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    expect(screen.getByLabelText('Drag a to reorder')).toBeTruthy()
  })

  it('tab variant では drag handle を表示しない', () => {
    render(
      <ConnectionManager
        targets={[sftp('a'), sftp('b')]}
        onSelect={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        variant="tab"
        onReorder={vi.fn()}
      />
    )
    expect(screen.queryByLabelText('Drag a to reorder')).toBeNull()
  })

  it('drop で並び替え後の配列を onReorder へ渡す', () => {
    const onReorder = vi.fn()
    render(
      <ConnectionManager
        targets={[sftp('a'), sftp('b'), sftp('c')]}
        onSelect={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        onReorder={onReorder}
      />
    )
    // a を c の前へ drop（hint 無し = before）。
    const cRow = screen.getByRole('button', { name: 'c' }).closest('li') as HTMLElement
    fireEvent.drop(cRow, { dataTransfer: { getData: () => 'a' } })

    expect(onReorder).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'b' }),
      expect.objectContaining({ id: 'a' }),
      expect.objectContaining({ id: 'c' }),
    ])
  })

  it('no-op な drop（同位置）は onReorder を呼ばない', () => {
    const onReorder = vi.fn()
    render(
      <ConnectionManager
        targets={[sftp('a'), sftp('b')]}
        onSelect={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        onReorder={onReorder}
      />
    )
    // a を b の前へ = 変化なし。
    const bRow = screen.getByRole('button', { name: 'b' }).closest('li') as HTMLElement
    fireEvent.drop(bRow, { dataTransfer: { getData: () => 'a' } })
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('reorderBusy のとき drag handle は draggable=false', () => {
    render(
      <ConnectionManager
        targets={[sftp('a'), sftp('b')]}
        onSelect={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        onReorder={vi.fn()}
        reorderBusy
      />
    )
    expect(screen.getByLabelText('Drag a to reorder').getAttribute('draggable')).toBe('false')
  })
})

describe('ConnectionManager', () => {
  it('削除は確認した場合だけ実行する', async () => {
    const onDelete = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<ConnectionManager targets={[target]} onSelect={vi.fn()} onSave={vi.fn()} onDelete={onDelete} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit Archive' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete connection' }))
    expect(onDelete).not.toHaveBeenCalled()

    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Delete connection' }) as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Delete connection' }))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(onDelete).toHaveBeenCalledWith(target)
  })
})
