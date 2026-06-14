import type { AppSettings, Theme } from '../../../../shared/settings'

/** 実際に適用するテーマ（system を解決した結果）。 */
export type ResolvedTheme = 'light' | 'dark'

/**
 * テーマ設定と OS の dark 設定から、実際に適用するテーマを解決する純関数。
 *
 * @param theme 設定値（system / light / dark）
 * @param prefersDark OS が dark を好むか（matchMedia の結果）
 * @returns 'light' または 'dark'
 */
export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === 'light') return 'light'
  if (theme === 'dark') return 'dark'
  return prefersDark ? 'dark' : 'light'
}

/**
 * ルート要素へ外観の data 属性（テーマ / 文字サイズ / 密度）と言語を反映する。
 * テスト可能なように対象要素を引数で受け取る。
 *
 * @param root 反映先（通常は document.documentElement）
 * @param settings 適用する設定
 * @param prefersDark OS が dark を好むか
 */
export function applyAppearance(root: HTMLElement, settings: AppSettings, prefersDark: boolean): void {
  root.setAttribute('data-theme', resolveTheme(settings.theme, prefersDark))
  root.setAttribute('data-font-size', settings.fontSize)
  root.setAttribute('data-density', settings.density)
  root.setAttribute('lang', settings.language)
}
