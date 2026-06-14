import type { ConnectionTarget } from './connectionTypes'

/** ドロップ位置（ターゲット行の前 / 後ろ）。 */
export type DropPosition = 'before' | 'after'

/**
 * ドラッグ＆ドロップによる接続一覧の並び替え結果を求める純関数。
 * source を取り出し、target の前 / 後ろへ挿入した新しい配列を返す。
 * 何も変わらない（same / no-op）場合や、不明な id・自分自身への drop は null を返し、保存をスキップさせる。
 *
 * @param targets 現在の接続設定配列
 * @param sourceId ドラッグ元の接続 id
 * @param targetId ドロップ先の接続 id
 * @param position target の前後どちらへ挿入するか
 * @returns 並び替え後の配列。変化なし / 不正な場合は null
 */
export function reorderConnections(
  targets: ConnectionTarget[],
  sourceId: string,
  targetId: string,
  position: DropPosition
): ConnectionTarget[] | null {
  if (sourceId === targetId) return null
  const sourceIndex = targets.findIndex((target) => target.id === sourceId)
  const targetIndex = targets.findIndex((target) => target.id === targetId)
  // 外部 drop や存在しない id は無視する。
  if (sourceIndex < 0 || targetIndex < 0) return null

  const next = [...targets]
  const [moved] = next.splice(sourceIndex, 1)
  // source 除去後の配列で target の位置を取り直し、前後を決める。
  const insertBase = next.findIndex((target) => target.id === targetId)
  const insertAt = position === 'after' ? insertBase + 1 : insertBase
  next.splice(insertAt, 0, moved)

  // 並びが変わらなければ no-op（保存しない）。
  if (next.every((target, index) => target.id === targets[index].id)) return null
  return next
}
