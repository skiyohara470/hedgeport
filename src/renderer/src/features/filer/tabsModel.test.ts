import { describe, it, expect } from 'vitest'

import { openTab, closeTab, activateTab, type Tab, type TabsState } from './tabsModel'

// このテストは tabsModel の純関数契約を固定する（実装は draft ステップで作成）。
// 計画 §6 ハンドオフ: open/close/activate のイミュータブル純関数。
// タブ追加・アクティブ切替・最後のタブ閉鎖時の挙動を検証する。

const tab = (id: string): Tab => ({ id, title: id.toUpperCase() })

const stateOf = (ids: string[], activeId: string | null): TabsState => ({
  tabs: ids.map(tab),
  activeId,
})

describe('openTab', () => {
  it('空の状態に開くとそのタブが追加されアクティブになる', () => {
    // Given: タブが1つもない状態
    const state = stateOf([], null)

    // When: タブ a を開く
    const next = openTab(state, tab('a'))

    // Then: a が追加されアクティブになる
    expect(next.tabs.map((t) => t.id)).toEqual(['a'])
    expect(next.activeId).toBe('a')
  })

  it('既存タブがある状態で開くと末尾に追加され新タブがアクティブになる', () => {
    // Given: a がアクティブ
    const state = stateOf(['a'], 'a')

    // When: b を開く
    const next = openTab(state, tab('b'))

    // Then: b が末尾に追加されアクティブが b に移る
    expect(next.tabs.map((t) => t.id)).toEqual(['a', 'b'])
    expect(next.activeId).toBe('b')
  })

  it('元の状態を破壊しない（イミュータブル）', () => {
    // Given: a がアクティブ
    const state = stateOf(['a'], 'a')
    const before = JSON.parse(JSON.stringify(state))

    // When: b を開く
    openTab(state, tab('b'))

    // Then: 元の state は変化しない
    expect(state).toEqual(before)
  })

  it('既存IDのタブを開こうとすると例外を投げる（重複をサイレントに許さない）', () => {
    // Given: a が存在
    const state = stateOf(['a'], 'a')

    // When/Then: 同じ id a を開くと throw
    expect(() => openTab(state, tab('a'))).toThrow()
  })
})

describe('activateTab', () => {
  it('指定タブをアクティブにする', () => {
    // Given: a がアクティブで b も存在
    const state = stateOf(['a', 'b'], 'a')

    // When: b をアクティブ化
    const next = activateTab(state, 'b')

    // Then: アクティブが b になる（タブ構成は不変）
    expect(next.activeId).toBe('b')
    expect(next.tabs.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('元の状態を破壊しない（イミュータブル）', () => {
    // Given: a がアクティブ
    const state = stateOf(['a', 'b'], 'a')
    const before = JSON.parse(JSON.stringify(state))

    // When: b をアクティブ化
    activateTab(state, 'b')

    // Then: 元の state は変化しない
    expect(state).toEqual(before)
  })

  it('存在しないIDをアクティブ化しようとすると例外を投げる（Fail Fast）', () => {
    // Given: a のみ存在
    const state = stateOf(['a'], 'a')

    // When/Then: 未知の id をアクティブ化すると throw
    expect(() => activateTab(state, 'zzz')).toThrow()
  })
})

describe('closeTab', () => {
  it('非アクティブなタブを閉じてもアクティブは変わらない', () => {
    // Given: b がアクティブ、a/b/c が存在
    const state = stateOf(['a', 'b', 'c'], 'b')

    // When: 非アクティブな a を閉じる
    const next = closeTab(state, 'a')

    // Then: a が消え、アクティブは b のまま
    expect(next.tabs.map((t) => t.id)).toEqual(['b', 'c'])
    expect(next.activeId).toBe('b')
  })

  it('アクティブタブを閉じると左隣がアクティブになる', () => {
    // Given: b がアクティブ、a/b/c が存在
    const state = stateOf(['a', 'b', 'c'], 'b')

    // When: アクティブな b を閉じる
    const next = closeTab(state, 'b')

    // Then: b が消え、左隣 a がアクティブになる
    expect(next.tabs.map((t) => t.id)).toEqual(['a', 'c'])
    expect(next.activeId).toBe('a')
  })

  it('末尾のアクティブタブを閉じると左隣がアクティブになる', () => {
    // Given: 末尾 c がアクティブ、a/b/c が存在（右端境界）
    const state = stateOf(['a', 'b', 'c'], 'c')

    // When: 末尾のアクティブ c を閉じる
    const next = closeTab(state, 'c')

    // Then: c が消え、左隣 b がアクティブになる
    expect(next.tabs.map((t) => t.id)).toEqual(['a', 'b'])
    expect(next.activeId).toBe('b')
  })

  it('先頭のアクティブタブを閉じると新しい先頭がアクティブになる', () => {
    // Given: a（先頭）がアクティブ、a/b/c が存在
    const state = stateOf(['a', 'b', 'c'], 'a')

    // When: 先頭のアクティブ a を閉じる（左隣が無い）
    const next = closeTab(state, 'a')

    // Then: 新しい先頭 b がアクティブになる
    expect(next.tabs.map((t) => t.id)).toEqual(['b', 'c'])
    expect(next.activeId).toBe('b')
  })

  it('最後の1枚を閉じるとタブが空になりアクティブが null になる', () => {
    // Given: 唯一のタブ a がアクティブ
    const state = stateOf(['a'], 'a')

    // When: a を閉じる
    const next = closeTab(state, 'a')

    // Then: タブが空、アクティブは null
    expect(next.tabs).toEqual([])
    expect(next.activeId).toBeNull()
  })

  it('元の状態を破壊しない（イミュータブル）', () => {
    // Given: b がアクティブ
    const state = stateOf(['a', 'b', 'c'], 'b')
    const before = JSON.parse(JSON.stringify(state))

    // When: b を閉じる
    closeTab(state, 'b')

    // Then: 元の state は変化しない
    expect(state).toEqual(before)
  })

  it('存在しないIDを閉じようとすると例外を投げる（Fail Fast）', () => {
    // Given: a のみ存在
    const state = stateOf(['a'], 'a')

    // When/Then: 未知の id を閉じると throw
    expect(() => closeTab(state, 'zzz')).toThrow()
  })
})
