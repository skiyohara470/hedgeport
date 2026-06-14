import { useEffect } from 'react'

import {
  DENSITIES,
  FONT_SIZES,
  LANGUAGES,
  THEMES,
  type AppSettings,
  type Density,
  type FontSize,
  type Language,
  type Theme,
} from '../../../../shared/settings'
import { useTranslation } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

interface SettingsDialogProps {
  /** 編集中の設定（ドラフト）。即時プレビューのため親が反映する。 */
  value: AppSettings
  /** 項目変更時に呼ばれる（ドラフト更新）。 */
  onChange: (next: AppSettings) => void
  /** 保存。 */
  onSave: () => void
  /** キャンセル（ドラフトを破棄して閉じる）。 */
  onCancel: () => void
  /** 保存中（二重操作防止）。 */
  saving?: boolean
  /** 保存失敗などのエラー文言。 */
  error?: string | null
}

/** 設定項目の選択肢ごとの翻訳キー。 */
const THEME_LABELS: Record<Theme, TranslationKey> = {
  system: 'settings.theme.system',
  light: 'settings.theme.light',
  dark: 'settings.theme.dark',
}
const FONT_SIZE_LABELS: Record<FontSize, TranslationKey> = {
  small: 'settings.fontSize.small',
  medium: 'settings.fontSize.medium',
  large: 'settings.fontSize.large',
}
const DENSITY_LABELS: Record<Density, TranslationKey> = {
  compact: 'settings.density.compact',
  comfortable: 'settings.density.comfortable',
}
const LANGUAGE_LABELS: Record<Language, TranslationKey> = {
  ja: 'settings.language.ja',
  en: 'settings.language.en',
}

/**
 * テーマ / 言語 / 文字サイズ / 表示密度 / 隠しファイル / 削除確認を編集する設定モーダル。
 * Save / Cancel 方式。変更は即時プレビューされ、Cancel で元へ戻せる（親が制御）。
 * Escape で Cancel、保存中は操作不可。
 */
export function SettingsDialog({
  value,
  onChange,
  onSave,
  onCancel,
  saving = false,
  error = null,
}: SettingsDialogProps) {
  const { t } = useTranslation()

  // Escape は window で一度だけ購読する（dialog onKeyDown と二重発火させない）。
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  return (
    <div className="editor-overlay" role="dialog" aria-modal="true" aria-label={t('settings.title')}>
      <div className="settings-modal">
        <header className="editor-header">
          <h2>{t('settings.title')}</h2>
          <button className="compact-button" type="button" aria-label={t('common.close')} onClick={onCancel}>
            {t('common.close')}
          </button>
        </header>

        <section className="settings-section">
          <h3>{t('settings.appearance')}</h3>
          <label className="settings-field">
            <span>{t('settings.theme')}</span>
            <select
              aria-label={t('settings.theme')}
              value={value.theme}
              disabled={saving}
              onChange={(event) => onChange({ ...value, theme: event.target.value as Theme })}
            >
              {THEMES.map((theme) => (
                <option key={theme} value={theme}>
                  {t(THEME_LABELS[theme])}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span>{t('settings.language')}</span>
            <select
              aria-label={t('settings.language')}
              value={value.language}
              disabled={saving}
              onChange={(event) => onChange({ ...value, language: event.target.value as Language })}
            >
              {LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {t(LANGUAGE_LABELS[language])}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span>{t('settings.fontSize')}</span>
            <select
              aria-label={t('settings.fontSize')}
              value={value.fontSize}
              disabled={saving}
              onChange={(event) => onChange({ ...value, fontSize: event.target.value as FontSize })}
            >
              {FONT_SIZES.map((fontSize) => (
                <option key={fontSize} value={fontSize}>
                  {t(FONT_SIZE_LABELS[fontSize])}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span>{t('settings.density')}</span>
            <select
              aria-label={t('settings.density')}
              value={value.density}
              disabled={saving}
              onChange={(event) => onChange({ ...value, density: event.target.value as Density })}
            >
              {DENSITIES.map((density) => (
                <option key={density} value={density}>
                  {t(DENSITY_LABELS[density])}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="settings-section">
          <h3>{t('settings.files')}</h3>
          <label className="settings-check">
            <input
              type="checkbox"
              aria-label={t('settings.showHiddenFiles')}
              checked={value.showHiddenFiles}
              disabled={saving}
              onChange={(event) => onChange({ ...value, showHiddenFiles: event.target.checked })}
            />
            <span>{t('settings.showHiddenFiles')}</span>
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              aria-label={t('settings.confirmBeforeDelete')}
              checked={value.confirmBeforeDelete}
              disabled={saving}
              onChange={(event) => onChange({ ...value, confirmBeforeDelete: event.target.checked })}
            />
            <span>{t('settings.confirmBeforeDelete')}</span>
          </label>
        </section>

        {error && (
          <p className="connection-result error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <div className="form-primary-actions">
            <button className="secondary-action-button" type="button" disabled={saving} onClick={onCancel}>
              {t('common.cancel')}
            </button>
            <button className="primary-button" type="button" disabled={saving} onClick={onSave}>
              {saving ? t('settings.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
