import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

const rendererRoot = dirname(fileURLToPath(import.meta.url))

/**
 * renderer 配下の .tsx を再帰列挙する（テストは除外）。
 */
function collectTsx(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectTsx(full))
    else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) out.push(full)
  }
  return out
}

/**
 * 翻訳対象外として許可する文字列（技術名・固有名・ブランド・コード断片）。
 * 誤検知を避けるための明示 allowlist。新しい技術名はここへ追加する。
 */
const ALLOWLIST = new Set<string>([
  'SFTP',
  'S3',
  'HP',
  'BOM',
  'UTF-8 BOM',
  'sftp.example.com',
  'list / read / write / delete / mkdir / rename',
])

/** 可視属性のハードコード文字列リテラル。 */
const VISIBLE_ATTRS = /(?:aria-label|title|placeholder|alt)="([^"{}]+)"/g
/** インライン JSX テキスト（2 語以上の英文。型注釈 `Promise<void>` 等は空白なしで除外）。 */
const JSX_INLINE_TEXT = />\s*([A-Za-z][A-Za-z'’.-]*(?: [A-Za-z][A-Za-z'’.,!?…/-]*)+)\s*</g
/** 行頭〜閉じタグが素テキストだけの JSX テキスト行。 */
const JSX_TEXT_LINE = /^\s*([A-Z][A-Za-z][A-Za-z ’'.…/-]*)\s*$/
/** window.confirm / alert / prompt に直書きした文字列リテラル。 */
const DIALOG_LITERAL = /window\.(?:confirm|alert|prompt)\(\s*[`'"]([^`'"]*[A-Za-z]{2,}[^`'"]*)[`'"]/g
/** 英文として直書きされた「文（語＋空白＋終止符）」の文字列リテラル（renderer fallback の検出）。 */
const SENTENCE_LITERAL = /[`'"]([A-Z][A-Za-z]+(?: [A-Za-z][A-Za-z,'’-]*)+[.?!])[`'"]/g

function isAllowed(value: string): boolean {
  const trimmed = value.trim()
  return !trimmed || ALLOWLIST.has(trimmed) || !/[A-Za-z]{2,}/.test(trimmed)
}

/** コメント行か（行コメント / ブロックコメント本体）。文中の英文誤検知を避ける。 */
function isCommentLine(line: string): boolean {
  const s = line.trim()
  return s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')
}

/**
 * ソース中の「未翻訳の疑いがあるユーザー可視文字列」を列挙する（テスト可能な純関数）。
 */
export function findOffenders(source: string): string[] {
  const offenders: string[] = []
  for (const match of source.matchAll(VISIBLE_ATTRS)) {
    if (!isAllowed(match[1])) offenders.push(`attr "${match[1]}"`)
  }
  for (const match of source.matchAll(JSX_INLINE_TEXT)) {
    if (!isAllowed(match[1])) offenders.push(`jsx "${match[1]}"`)
  }
  for (const match of source.matchAll(DIALOG_LITERAL)) {
    if (!isAllowed(match[1])) offenders.push(`dialog "${match[1]}"`)
  }
  for (const line of source.split('\n')) {
    if (isCommentLine(line)) continue
    const trimmed = JSX_TEXT_LINE.exec(line)
    if (trimmed && !isAllowed(trimmed[1])) offenders.push(`text "${trimmed[1].trim()}"`)
    for (const match of line.matchAll(SENTENCE_LITERAL)) {
      if (!isAllowed(match[1])) offenders.push(`sentence "${match[1]}"`)
    }
  }
  return offenders
}

describe('renderer i18n contract', () => {
  it('renderer の .tsx に未翻訳のユーザー可視文字列を残さない', () => {
    const offenders: string[] = []
    for (const file of collectTsx(rendererRoot)) {
      const rel = file.slice(rendererRoot.length + 1)
      for (const offender of findOffenders(readFileSync(file, 'utf8'))) offenders.push(`${rel}: ${offender}`)
    }
    expect(offenders).toEqual([])
  })

  it('既知の漏れパターン（回帰）を確実に検出する', () => {
    // 過去に実際に漏れた 3 例を fixture として検出できることを保証する。
    expect(findOffenders('<span>Local files</span>')).toContain('jsx "Local files"')
    expect(findOffenders('if (!window.confirm(`Close "${title}"?`)) return')).toEqual(
      expect.arrayContaining([expect.stringContaining('dialog')])
    )
    expect(findOffenders("setError('Could not read this directory.')")).toContain(
      'sentence "Could not read this directory."'
    )
  })

  it('技術名・正当な式は誤検知しない', () => {
    expect(findOffenders('const x: Promise<void> = run()')).toEqual([])
    expect(findOffenders("<span>{t('pane.localFiles')}</span>")).toEqual([])
    expect(findOffenders('SFTP')).toEqual([])
    expect(findOffenders('aria-label="SFTP"')).toEqual([])
  })
})
