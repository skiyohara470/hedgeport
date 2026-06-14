/**
 * main / preload / renderer が共有するアプリ設定の契約。
 * 接続レコードや一時 UI 状態とは分離した、永続化される versioned スキーマ。
 */

/** 設定スキーマのバージョン（migration 判定に使う）。 */
export const SETTINGS_VERSION = 1

export const THEMES = ['system', 'light', 'dark'] as const
export const FONT_SIZES = ['small', 'medium', 'large'] as const
export const DENSITIES = ['compact', 'comfortable'] as const
export const LANGUAGES = ['ja', 'en'] as const

export type Theme = (typeof THEMES)[number]
export type FontSize = (typeof FONT_SIZES)[number]
export type Density = (typeof DENSITIES)[number]
export type Language = (typeof LANGUAGES)[number]

/**
 * 永続化されるアプリ設定。
 */
export interface AppSettings {
  version: number
  theme: Theme
  fontSize: FontSize
  density: Density
  showHiddenFiles: boolean
  confirmBeforeDelete: boolean
  language: Language
}

/**
 * OS ロケールから初期表示言語を決める純関数。
 * ja で始まるロケールのみ日本語、それ以外は英語。
 *
 * @param locale OS ロケール（例 'ja-JP', 'en-US'）
 * @returns 'ja' または 'en'
 */
export function defaultLanguage(locale: string | undefined): Language {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

/**
 * 既定の設定を作る。language のみ OS ロケールから決定する。
 *
 * @param locale OS ロケール
 * @returns 既定の AppSettings
 */
export function createDefaultSettings(locale: string | undefined): AppSettings {
  return {
    version: SETTINGS_VERSION,
    theme: 'system',
    fontSize: 'medium',
    density: 'comfortable',
    showHiddenFiles: false,
    confirmBeforeDelete: true,
    language: defaultLanguage(locale),
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 未知 / 不正なフィールドを安全に既定へ補正して正規化する（version migration 兼用）。
 * 余分なフィールドは無視し、欠落・型不一致は fallback の値を使う。version は常に現行へ揃える。
 *
 * @param value 検証対象（永続ファイルや IPC 入力の未検証値）
 * @param fallback 既定値（language の決定に使う）
 * @returns 正規化済み AppSettings
 */
export function normalizeSettings(value: unknown, fallback: AppSettings): AppSettings {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    version: SETTINGS_VERSION,
    theme: oneOf(source.theme, THEMES, fallback.theme),
    fontSize: oneOf(source.fontSize, FONT_SIZES, fallback.fontSize),
    density: oneOf(source.density, DENSITIES, fallback.density),
    showHiddenFiles: boolOr(source.showHiddenFiles, fallback.showHiddenFiles),
    confirmBeforeDelete: boolOr(source.confirmBeforeDelete, fallback.confirmBeforeDelete),
    language: oneOf(source.language, LANGUAGES, fallback.language),
  }
}
