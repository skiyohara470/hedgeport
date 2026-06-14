// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { createDefaultSettings } from '../../../../shared/settings'
import { applyAppearance, resolveTheme } from './appearance'

describe('resolveTheme', () => {
  it('light/dark は固定、system は prefersDark に従う', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('applyAppearance', () => {
  it('ルート要素へ data 属性と lang を反映する', () => {
    const root = document.createElement('html')
    applyAppearance(
      root,
      { ...createDefaultSettings('ja'), theme: 'system', fontSize: 'large', density: 'compact' },
      true
    )
    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(root.getAttribute('data-font-size')).toBe('large')
    expect(root.getAttribute('data-density')).toBe('compact')
    expect(root.getAttribute('lang')).toBe('ja')
  })

  it('system + prefersDark=false は light を適用する', () => {
    const root = document.createElement('html')
    applyAppearance(root, { ...createDefaultSettings('en'), theme: 'system' }, false)
    expect(root.getAttribute('data-theme')).toBe('light')
  })
})
