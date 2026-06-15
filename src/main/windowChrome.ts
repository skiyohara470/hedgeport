/**
 * ウィンドウのタイトルバー外観（プラットフォーム差分）を決める純ロジック。
 * electron 非依存にして mac/non-mac の分岐を単体テストできるようにする。
 */

/**
 * BrowserWindow に渡すタイトルバー関連オプションの部分集合。
 * 値は electron の BrowserWindowConstructorOptions と互換（そのまま spread して使う）。
 */
export interface WindowChromeOptions {
  /** macOS のみ。コンテンツをタイトルバー領域へ広げつつ traffic lights を残す。 */
  titleBarStyle?: 'hiddenInset'
  /** macOS のみ。traffic lights の位置をツールバーに合わせて微調整する。 */
  trafficLightPosition?: { x: number; y: number }
}

/**
 * プラットフォームに応じたタイトルバーオプションを返す。
 * - macOS: `hiddenInset`（native traffic lights は維持）+ ツールバーに馴染む traffic light 位置。
 * - Windows / Linux: native frame を維持するため何も指定しない（mac 風ボタンを模倣しない）。
 *
 * @param platform `process.platform` 相当の値
 * @returns BrowserWindow へ spread するタイトルバーオプション
 */
export function windowChromeOptions(platform: NodeJS.Platform): WindowChromeOptions {
  if (platform === 'darwin') {
    // y はツールバー（最小高さ 40px）の縦中央付近に traffic lights を収める値。
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } }
  }
  return {}
}
