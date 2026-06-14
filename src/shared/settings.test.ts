import { describe, expect, it } from 'vitest'

import {
  createDefaultSettings,
  defaultLanguage,
  normalizeSettings,
  SETTINGS_VERSION,
  type AppSettings,
} from './settings'

describe('defaultLanguage', () => {
  it('ja で始まるロケールは ja、それ以外は en', () => {
    expect(defaultLanguage('ja-JP')).toBe('ja')
    expect(defaultLanguage('ja')).toBe('ja')
    expect(defaultLanguage('en-US')).toBe('en')
    expect(defaultLanguage('fr')).toBe('en')
    expect(defaultLanguage(undefined)).toBe('en')
  })
})

describe('createDefaultSettings', () => {
  it('既定値を返し language のみロケール由来', () => {
    expect(createDefaultSettings('ja-JP')).toEqual({
      version: SETTINGS_VERSION,
      theme: 'system',
      fontSize: 'medium',
      density: 'comfortable',
      showHiddenFiles: false,
      confirmBeforeDelete: true,
      language: 'ja',
    })
    expect(createDefaultSettings('en-US').language).toBe('en')
  })
})

describe('normalizeSettings', () => {
  const fallback: AppSettings = createDefaultSettings('en-US')

  it('正常値はそのまま、version は現行へ揃える', () => {
    const value = {
      version: 999,
      theme: 'dark',
      fontSize: 'large',
      density: 'compact',
      showHiddenFiles: true,
      confirmBeforeDelete: false,
      language: 'ja',
    }
    expect(normalizeSettings(value, fallback)).toEqual({
      version: SETTINGS_VERSION,
      theme: 'dark',
      fontSize: 'large',
      density: 'compact',
      showHiddenFiles: true,
      confirmBeforeDelete: false,
      language: 'ja',
    })
  })

  it('不正 / 欠落フィールドは fallback へ補正し、未知フィールドは無視する', () => {
    const value = { theme: 'neon', fontSize: 123, language: 'de', extra: 'x' }
    expect(normalizeSettings(value, fallback)).toEqual(fallback)
  })

  it('object でない入力は全て fallback', () => {
    expect(normalizeSettings(null, fallback)).toEqual(fallback)
    expect(normalizeSettings('nope', fallback)).toEqual(fallback)
  })
})
