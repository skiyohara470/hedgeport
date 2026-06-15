import type { HistoryDirection } from '../shared/navigation'

/**
 * Windows / Linux の WebContents app-command 名を履歴方向へ写像する純関数。
 * 戻る/進む以外（音量・検索等）は null（無視）。
 *
 * @param command Electron の 'app-command' で渡るコマンド名
 * @returns 'back' / 'forward' / null
 */
export function mapAppCommand(command: string): HistoryDirection | null {
  if (command === 'browser-backward') return 'back'
  if (command === 'browser-forward') return 'forward'
  return null
}

/**
 * macOS のトラックパッド 3 本指スワイプ方向を履歴方向へ写像する純関数。
 * 右スワイプ=戻る、左スワイプ=進む。上下は null（無視）。
 *
 * @param direction Electron の 'swipe' で渡る方向（'left' | 'right' | 'up' | 'down'）
 * @returns 'back' / 'forward' / null
 */
export function mapSwipeDirection(direction: string): HistoryDirection | null {
  if (direction === 'right') return 'back'
  if (direction === 'left') return 'forward'
  return null
}

/**
 * app-command を受けて、戻る/進むのときだけ Chromium 既定動作を抑止し renderer へ送るアダプタ。
 * テスト可能なように副作用（preventDefault / send）を注入する。
 *
 * @param command app-command 名
 * @param actions preventDefault と send（'history:navigate' 相当）
 * @returns 送信した方向。無視した場合は null
 */
export function handleAppCommand(
  command: string,
  actions: { preventDefault: () => void; send: (direction: HistoryDirection) => void }
): HistoryDirection | null {
  const direction = mapAppCommand(command)
  if (!direction) return null
  // 1 入力 = 1 遷移にするため、Chromium 既定のページ履歴移動を止めてから renderer へ委譲する。
  actions.preventDefault()
  actions.send(direction)
  return direction
}

/**
 * swipe を受けて renderer へ送るアダプタ（swipe は preventDefault 不要）。
 *
 * @param direction swipe 方向
 * @param send 送信関数
 * @returns 送信した方向。無視した場合は null
 */
export function handleSwipe(direction: string, send: (direction: HistoryDirection) => void): HistoryDirection | null {
  const mapped = mapSwipeDirection(direction)
  if (!mapped) return null
  send(mapped)
  return mapped
}
