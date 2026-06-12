/**
 * ファイラのタブ1枚。
 */
export interface Tab {
  /** 一意な識別子 */
  id: string
  /** タブの表示タイトル */
  title: string
}

/**
 * タブ群の状態。tabs の並び順がそのまま表示順、activeId が選択中のタブ。
 */
export interface TabsState {
  tabs: Tab[]
  /** アクティブなタブの id。タブが1枚もないときは null */
  activeId: string | null
}

/**
 * タブを末尾に追加し、追加したタブをアクティブにする。
 * @param state 現在の状態
 * @param tab 追加するタブ
 * @returns 新しい状態（元の state は破壊しない）
 * @throws 同じ id のタブが既に存在する場合
 */
export function openTab(state: TabsState, tab: Tab): TabsState {
  if (state.tabs.some((t) => t.id === tab.id)) {
    throw new Error(`tab already exists: ${tab.id}`)
  }
  return {
    tabs: [...state.tabs, tab],
    activeId: tab.id,
  }
}

/**
 * 指定タブをアクティブにする（タブ構成は変えない）。
 * @param state 現在の状態
 * @param id アクティブにするタブの id
 * @returns 新しい状態（元の state は破壊しない）
 * @throws 指定 id のタブが存在しない場合
 */
export function activateTab(state: TabsState, id: string): TabsState {
  if (!state.tabs.some((t) => t.id === id)) {
    throw new Error(`unknown tab: ${id}`)
  }
  return {
    tabs: state.tabs,
    activeId: id,
  }
}

/**
 * 指定タブを閉じる。閉じたタブがアクティブだった場合は左隣（先頭なら新しい先頭）を
 * 新たなアクティブにし、最後の1枚を閉じたときは activeId を null にする。
 * @param state 現在の状態
 * @param id 閉じるタブの id
 * @returns 新しい状態（元の state は破壊しない）
 * @throws 指定 id のタブが存在しない場合
 */
export function closeTab(state: TabsState, id: string): TabsState {
  const index = state.tabs.findIndex((t) => t.id === id)
  if (index === -1) {
    throw new Error(`unknown tab: ${id}`)
  }

  const tabs = state.tabs.filter((t) => t.id !== id)

  // 非アクティブなタブを閉じた場合はアクティブを据え置く
  if (state.activeId !== id) {
    return { tabs, activeId: state.activeId }
  }

  // アクティブを閉じた場合: 残りがなければ null、あれば左隣（先頭なら新しい先頭）
  const activeId = tabs.length === 0 ? null : tabs[Math.max(index - 1, 0)].id
  return { tabs, activeId }
}
