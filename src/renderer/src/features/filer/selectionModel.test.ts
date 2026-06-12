import { describe, expect, it } from 'vitest'

import { emptySelection, selectEntry } from './selectionModel'

const paths = ['/a', '/b', '/c', '/d']

describe('selectEntry', () => {
  it('通常クリックは単一選択へ置き換える', () => {
    const selected = selectEntry(emptySelection(), paths, '/b', { toggle: false, range: false })
    const next = selectEntry(selected, paths, '/d', { toggle: false, range: false })

    expect([...next.selectedPaths]).toEqual(['/d'])
    expect(next.anchorPath).toBe('/d')
  })

  it('Cmd/Ctrlクリックは選択を追加・解除する', () => {
    const first = selectEntry(emptySelection(), paths, '/a', { toggle: false, range: false })
    const added = selectEntry(first, paths, '/c', { toggle: true, range: false })
    const removed = selectEntry(added, paths, '/a', { toggle: true, range: false })

    expect([...added.selectedPaths]).toEqual(['/a', '/c'])
    expect([...removed.selectedPaths]).toEqual(['/c'])
  })

  it('Shiftクリックはアンカーから対象までを連続選択する', () => {
    const first = selectEntry(emptySelection(), paths, '/b', { toggle: false, range: false })
    const ranged = selectEntry(first, paths, '/d', { toggle: false, range: true })

    expect([...ranged.selectedPaths]).toEqual(['/b', '/c', '/d'])
    expect(ranged.anchorPath).toBe('/b')
  })
})
