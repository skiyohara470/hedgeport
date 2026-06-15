// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { applyFullScreen, applyPlatform } from './platform'

afterEach(() => {
  document.documentElement.removeAttribute('data-platform')
  document.documentElement.removeAttribute('data-fullscreen')
})

describe('applyPlatform', () => {
  it('platform があれば data-platform を設定する', () => {
    applyPlatform(document.documentElement, 'darwin')
    expect(document.documentElement.getAttribute('data-platform')).toBe('darwin')
  })

  it('未指定なら data-platform を外す（mac 専用スタイルを無効化）', () => {
    document.documentElement.setAttribute('data-platform', 'darwin')
    applyPlatform(document.documentElement, undefined)
    expect(document.documentElement.hasAttribute('data-platform')).toBe(false)
  })
})

describe('applyFullScreen', () => {
  it('全画面で data-fullscreen=true、解除で属性を外す', () => {
    applyFullScreen(document.documentElement, true)
    expect(document.documentElement.getAttribute('data-fullscreen')).toBe('true')
    applyFullScreen(document.documentElement, false)
    expect(document.documentElement.hasAttribute('data-fullscreen')).toBe(false)
  })
})
