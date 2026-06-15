import type { HistoryDirection } from '../../../../shared/navigation'

/** ナビゲーション入力の発生源（IPC = main 由来、dom = renderer の補助マウスボタン）。 */
export type NavigationSource = 'ipc' | 'dom'

/** 直近に受理したナビゲーション（重複抑止の判定に使う）。 */
export interface LastNavigation {
  direction: HistoryDirection
  source: NavigationSource
  time: number
}

/** IPC と DOM が同一入力を二重通知し得る環境での dedupe 既定ウィンドウ（ms）。 */
export const NAV_DEDUPE_WINDOW_MS = 300

/**
 * DOM のマウスボタン番号を履歴方向へ写像する純関数。
 * 3 = 戻る（back）、4 = 進む（forward）、それ以外は null。
 *
 * @param button MouseEvent.button
 * @returns 'back' / 'forward' / null
 */
export function mouseButtonDirection(button: number): HistoryDirection | null {
  if (button === 3) return 'back'
  if (button === 4) return 'forward'
  return null
}

/**
 * ナビゲーション入力を受理してよいか（重複抑止）。
 * 同一物理入力が IPC と DOM の両方から来るケースのみを落とす:
 * 「同じ方向 × 異なる source × 短時間内」のときだけ拒否する。
 * 同じ source の連続入力（素早い 2 連クリック等）は常に受理する。
 *
 * @param previous 直近に受理したナビゲーション（無ければ null）
 * @param next 今回の方向と source
 * @param now 現在時刻（ms）
 * @param windowMs dedupe ウィンドウ
 * @returns 受理してよければ true
 */
export function shouldAcceptNavigation(
  previous: LastNavigation | null,
  next: { direction: HistoryDirection; source: NavigationSource },
  now: number,
  windowMs: number = NAV_DEDUPE_WINDOW_MS
): boolean {
  if (!previous) return true
  if (previous.direction !== next.direction) return true
  if (previous.source === next.source) return true
  return now - previous.time > windowMs
}

/**
 * 直近の観測入力と今回の入力から、受理可否と「次に記録すべき観測状態」を返す純関数。
 * 受理・拒否に関わらず今回の入力を観測として記録する（last を更新する）のが要点。
 * これにより二重通知を一度拒否しても、その直後に来る同 source の正規入力は、
 * 直近観測（= 拒否した入力）と同 source になるため次回は受理できる。
 *
 * @param previous 直近に観測したナビゲーション（無ければ null）
 * @param next 今回の方向と source
 * @param now 現在時刻（ms）
 * @param windowMs dedupe ウィンドウ
 * @returns accept（受理可否）と last（次に保持すべき観測状態）
 */
export function reduceNavigation(
  previous: LastNavigation | null,
  next: { direction: HistoryDirection; source: NavigationSource },
  now: number,
  windowMs: number = NAV_DEDUPE_WINDOW_MS
): { accept: boolean; last: LastNavigation } {
  return {
    accept: shouldAcceptNavigation(previous, next, now, windowMs),
    last: { direction: next.direction, source: next.source, time: now },
  }
}
