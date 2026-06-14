import { useEffect, useState } from 'react'

import { createDefaultSettings, type AppSettings } from '../../../../shared/settings'
import { I18nProvider } from '../i18n/I18nContext'
import { useTranslation } from '../i18n/I18nContext'
import { SettingsProvider } from '../settings/SettingsContext'

/**
 * プレビュー画面の本文。設定（言語）に応じて文言を出し分ける。
 */
function PreviewContent() {
  const { t } = useTranslation()
  return (
    <main className="preview-window">
      <header>
        <div>
          <p className="eyebrow">{t('preview.eyebrow')}</p>
          <h1>{t('preview.noFile')}</h1>
        </div>
        <span className="preview-badge">{t('preview.futureBadge')}</span>
      </header>
      <section className="preview-canvas">
        <p>{t('preview.hint1')}</p>
        <p>{t('preview.hint2')}</p>
      </section>
    </main>
  )
}

/**
 * 別ウィンドウのプレビュー画面。
 * メインウィンドウと同じ設定をロードし、テーマ / 文字サイズ / 密度 / 言語を適用する。
 */
export function PreviewWindow() {
  const [settings, setSettings] = useState<AppSettings>(() => createDefaultSettings(navigator.language))

  useEffect(() => {
    void window.hedgeport
      .loadSettings()
      .then(setSettings)
      .catch(() => undefined)
  }, [])

  return (
    <SettingsProvider settings={settings}>
      <I18nProvider language={settings.language}>
        <PreviewContent />
      </I18nProvider>
    </SettingsProvider>
  )
}
