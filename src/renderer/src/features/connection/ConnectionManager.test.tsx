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
  bucket: 'archive',
  prefix: '',
  accessKeyId: 'access-key',
  secretAccessKey: 'secret-key',
  sessionToken: '',
}

describe('ConnectionManager', () => {
  it('削除は確認した場合だけ実行する', async () => {
    const onDelete = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(
      <ConnectionManager
        targets={[target]}
        onSelect={vi.fn()}
        onSave={vi.fn()}
        onDelete={onDelete}
      />
    )

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
