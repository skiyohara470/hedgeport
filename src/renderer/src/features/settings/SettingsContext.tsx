import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react'

import type { AppSettings } from '../../../../shared/settings'
import { applyAppearance } from './appearance'

const SettingsContext = createContext<AppSettings | null>(null)

/**
 * 現在の設定を配下へ供給し、外観（テーマ / 文字サイズ / 密度 / 言語）をルート要素へ反映する Provider。
 * 初回ペイント前に属性を反映して dark/light 混在フレームを避けるため useLayoutEffect を使う。
 * theme=system のときは matchMedia の変更に追従し、listener は cleanup する。
 */
export function SettingsProvider({ settings, children }: { settings: AppSettings; children: ReactNode }) {
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => applyAppearance(document.documentElement, settings, media.matches)
    apply()
    // system のときだけ OS テーマ変更へ追従すればよいが、常時購読しても apply は冪等。
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings])

  return <SettingsContext.Provider value={settings}>{children}</SettingsContext.Provider>
}

/**
 * 現在の設定を取得する。Provider 外で使うと例外。
 */
export function useSettings(): AppSettings {
  const value = useContext(SettingsContext)
  if (!value) throw new Error('useSettings must be used within a SettingsProvider')
  return value
}
