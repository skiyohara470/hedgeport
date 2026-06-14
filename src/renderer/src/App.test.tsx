// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App } from './App'
import type { ConnectionTarget } from './features/connection/connectionTypes'

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
  password: 'p',
  rootPath: '/',
})

/**
 * window.hedgeport をテスト用に差し替える。loadConnections は initial を返す。
 */
const setupApi = (overrides: Partial<Record<string, ReturnType<typeof vi.fn>>>, initial: ConnectionTarget[]) => {
  const api = {
    loadConnections: vi.fn().mockResolvedValue(initial),
    saveConnections: vi.fn().mockResolvedValue(undefined),
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

describe('App connection reorder (drag & drop)', () => {
  it('drop で並び替え後の順序を保存し、一覧へ反映する', async () => {
    const saveConnections = vi.fn().mockResolvedValue(undefined)
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
    const saveConnections = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
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
