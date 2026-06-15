/**
 * プラットフォーム / 全画面状態をルート要素の data 属性へ反映する純関数。
 * macOS 統合タイトルバー（ドラッグ領域・traffic light 用の左余白）の CSS 出し分けに使う。
 * テスト可能なように対象要素を引数で受け取る。
 */

/**
 * ルート要素へ OS 種別を反映する（`data-platform`）。
 * 値が無い場合（preload 未公開・テスト）は属性を外し、mac 専用スタイルを無効化する。
 *
 * @param root 反映先（通常は document.documentElement）
 * @param platform `process.platform` 相当の値、または未指定
 */
export function applyPlatform(root: HTMLElement, platform: string | undefined): void {
  if (platform) root.setAttribute('data-platform', platform)
  else root.removeAttribute('data-platform')
}

/**
 * ルート要素へ全画面状態を反映する（`data-fullscreen`）。
 * 全画面では traffic lights が消えるため、左余白を畳むスタイルへ切り替える。
 *
 * @param root 反映先（通常は document.documentElement）
 * @param fullScreen 全画面なら true
 */
export function applyFullScreen(root: HTMLElement, fullScreen: boolean): void {
  if (fullScreen) root.setAttribute('data-fullscreen', 'true')
  else root.removeAttribute('data-fullscreen')
}
