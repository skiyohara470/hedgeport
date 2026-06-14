import { createContext, useContext, useMemo, type ReactNode } from 'react'

import type { Language } from '../../../../shared/settings'
import { createTranslator, type Translator } from './translations'

interface I18nContextValue {
  language: Language
  t: Translator
}

const I18nContext = createContext<I18nContextValue | null>(null)

/**
 * 表示言語と翻訳関数を配下へ供給する Provider。
 * language が変わると translator を作り直し、再起動なしで UI へ反映する。
 */
export function I18nProvider({ language, children }: { language: Language; children: ReactNode }) {
  const value = useMemo<I18nContextValue>(() => ({ language, t: createTranslator(language) }), [language])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/**
 * 翻訳関数と現在言語を取得する。Provider 外では英語の translator にフォールバックする。
 */
export function useTranslation(): I18nContextValue {
  const value = useContext(I18nContext)
  return value ?? { language: 'en', t: createTranslator('en') }
}
