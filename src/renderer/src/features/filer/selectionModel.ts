/**
 * 一覧上の選択状態。
 * anchorPath は Shift 選択時の起点として使う。
 */
export interface SelectionState {
  selectedPaths: Set<string>
  anchorPath: string | null
}

interface SelectionModifiers {
  toggle: boolean
  range: boolean
}

export const emptySelection = (): SelectionState => ({
  selectedPaths: new Set(),
  anchorPath: null,
})

/**
 * クリック時の修飾キーを反映して次の選択状態を作る。
 * Cmd/Ctrl でトグル、Shift で範囲選択、それ以外は単一選択に戻す。
 */
export function selectEntry(
  state: SelectionState,
  orderedPaths: string[],
  path: string,
  modifiers: SelectionModifiers
): SelectionState {
  if (modifiers.range && state.anchorPath) {
    const anchorIndex = orderedPaths.indexOf(state.anchorPath)
    const targetIndex = orderedPaths.indexOf(path)
    if (anchorIndex !== -1 && targetIndex !== -1) {
      const start = Math.min(anchorIndex, targetIndex)
      const end = Math.max(anchorIndex, targetIndex)
      return {
        selectedPaths: new Set(orderedPaths.slice(start, end + 1)),
        anchorPath: state.anchorPath,
      }
    }
  }

  if (modifiers.toggle) {
    const selectedPaths = new Set(state.selectedPaths)
    if (selectedPaths.has(path)) {
      selectedPaths.delete(path)
    } else {
      selectedPaths.add(path)
    }
    return { selectedPaths, anchorPath: path }
  }

  return {
    selectedPaths: new Set([path]),
    anchorPath: path,
  }
}
