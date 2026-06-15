/**
 * main / preload / renderer が共有するディレクトリ履歴ナビゲーションの方向。
 * ブラウザ履歴ではなく、HedgePort のペイン内ディレクトリ履歴の移動を表す。
 */
export type HistoryDirection = 'back' | 'forward'

/**
 * 任意値が有効な履歴方向か判定する type guard。
 * preload / renderer で未知の値（不正な IPC ペイロード等）を破棄するために使う。
 *
 * @param value 検証対象
 * @returns 'back' | 'forward' のときだけ true
 */
export function isHistoryDirection(value: unknown): value is HistoryDirection {
  return value === 'back' || value === 'forward'
}
