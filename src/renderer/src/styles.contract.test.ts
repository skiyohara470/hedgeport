import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8')

/** `:root` 系ブロック（トークン定義）を除いた本文。色のハードコード監査に使う。 */
const bodyWithoutTokenBlocks = css.replace(/:root[^{]*\{[^}]*\}/g, '')

describe('styles.css theme contract', () => {
  it('トークン定義以外にハードコードされた hex 色を残さない', () => {
    const hex = [...bodyWithoutTokenBlocks.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])
    expect(hex).toEqual([])
  })

  it('トークン定義以外の rgb() は var() ベースのみ（数値リテラル直書きを残さない）', () => {
    const literalRgb = [...bodyWithoutTokenBlocks.matchAll(/rgb\(\s*\d/g)].map((m) => m[0])
    expect(literalRgb).toEqual([])
  })

  it('connection-card / screen はセマンティックトークンを使う', () => {
    expect(css).toMatch(/\.connection-card\s*\{[^}]*background:\s*var\(--c-card-bg\)/)
    expect(css).toMatch(/\.connection-screen\s*\{[^}]*var\(--c-screen-glow\)/)
  })

  it('macOS 統合タイトルバー: 上端バーは drag、操作要素は no-drag、traffic light 余白と全画面リセットを持つ', () => {
    // 上端バーをドラッグ領域にする（mac 限定）。
    expect(css).toMatch(/\[data-platform='darwin'\][^{]*\.workspace-bar[^{]*\{[^}]*-webkit-app-region:\s*drag/)
    // 操作要素は no-drag（drag 領域内でもクリックできる）。
    expect(css).toMatch(/\[data-platform='darwin'\][^{]*button[^{]*\{[^}]*-webkit-app-region:\s*no-drag/)
    // traffic lights と重ならない左余白。
    expect(css).toMatch(/\[data-platform='darwin'\]\s*\.workspace-bar\s*\{[^}]*padding-left/)
    // 全画面では左余白を畳む。
    expect(css).toMatch(/\[data-platform='darwin'\]\[data-fullscreen='true'\]/)
  })

  it('チェックボックスは appearance:none で theme token 描画し、forced-colors で native へ戻す', () => {
    expect(css).toMatch(/\.checkbox-cell input\[type='checkbox'\]\s*\{[^}]*appearance:\s*none/)
    expect(css).toMatch(/@media \(forced-colors: active\)/)
  })

  it('light テーマが card / text / surface / 装飾トークンを上書きする', () => {
    const light = css.match(/:root\[data-theme='light'\]\s*\{([^}]*)\}/)?.[1] ?? ''
    for (const token of [
      '--c-bg',
      '--c-surface',
      '--c-text',
      '--c-card-bg',
      '--c-screen-glow',
      '--c-pane-glow',
      '--shadow-rgb',
      '--ring-rgb',
    ]) {
      expect(light).toContain(token)
    }
  })
})
