import { describe, expect, it } from 'vitest'

import {
  MAX_MATCHES,
  buildSegments,
  clampActiveIndex,
  nextMatchIndex,
  prevMatchIndex,
  searchText,
} from './previewSearch'

describe('searchText', () => {
  it('空 query は 0 件', () => {
    expect(searchText('abcabc', '', false)).toEqual({ matches: [], truncated: false })
  })

  it('case sensitive: 一致のみ', () => {
    expect(searchText('Abc abc ABC', 'abc', true).matches).toEqual([4])
  })

  it('case insensitive: index は元本文に対応する', () => {
    // 大文字小文字混在でも index は原文基準（0, 4, 8）。
    expect(searchText('Abc abc ABC', 'abc', false).matches).toEqual([0, 4, 8])
  })

  it('非重複で列挙する（重なりを数えない）', () => {
    // 'aa' を 'aaaa' から探すと 0,2 の 2 件（重複 1 を含めない）。
    expect(searchText('aaaa', 'aa', true).matches).toEqual([0, 2])
  })

  it('0 件 / 1 件 / 複数件', () => {
    expect(searchText('hello', 'zzz', false).matches).toEqual([])
    expect(searchText('hello', 'ell', false).matches).toEqual([1])
    expect(searchText('a.a.a', 'a', false).matches).toEqual([0, 2, 4])
  })

  it('日本語（case 概念なし）でも index 整合', () => {
    expect(searchText('あいうあい', 'あい', false).matches).toEqual([0, 3])
  })

  it('MAX_MATCHES を超えると truncated', () => {
    const text = 'a'.repeat(MAX_MATCHES + 50)
    const result = searchText(text, 'a', true)
    expect(result.matches.length).toBe(MAX_MATCHES)
    expect(result.truncated).toBe(true)
  })

  it('ちょうど MAX_MATCHES 件なら truncated でない', () => {
    const text = 'a'.repeat(MAX_MATCHES)
    const result = searchText(text, 'a', true)
    expect(result.matches.length).toBe(MAX_MATCHES)
    expect(result.truncated).toBe(false)
  })
})

describe('buildSegments', () => {
  it('match なしは単一セグメント', () => {
    expect(buildSegments('hello', [], 3, -1)).toEqual([{ text: 'hello', highlight: 'none' }])
  })

  it('active と通常 match を分ける（slice は元本文の casing を保持）', () => {
    // 'Abc abc' から 'abc'(ci) → index 0,4。active=1。
    const matches = searchText('Abc abc', 'abc', false).matches
    expect(buildSegments('Abc abc', matches, 3, 1)).toEqual([
      { text: 'Abc', highlight: 'match' },
      { text: ' ', highlight: 'none' },
      { text: 'abc', highlight: 'active' },
    ])
  })

  it('末尾テキストも none セグメントとして残す', () => {
    expect(buildSegments('xaby', [1], 2, 0)).toEqual([
      { text: 'x', highlight: 'none' },
      { text: 'ab', highlight: 'active' },
      { text: 'y', highlight: 'none' },
    ])
  })
})

describe('nextMatchIndex / prevMatchIndex（wrap）', () => {
  it('次は末尾→先頭へ wrap', () => {
    expect(nextMatchIndex(0, 3)).toBe(1)
    expect(nextMatchIndex(2, 3)).toBe(0)
  })

  it('前は先頭→末尾へ wrap', () => {
    expect(prevMatchIndex(2, 3)).toBe(1)
    expect(prevMatchIndex(0, 3)).toBe(2)
  })

  it('0 件は -1', () => {
    expect(nextMatchIndex(0, 0)).toBe(-1)
    expect(prevMatchIndex(0, 0)).toBe(-1)
  })
})

describe('clampActiveIndex（再読込・再検索の reconcile）', () => {
  it('範囲外は端へ寄せ、0 件は -1', () => {
    expect(clampActiveIndex(5, 3)).toBe(2)
    expect(clampActiveIndex(-1, 3)).toBe(0)
    expect(clampActiveIndex(1, 3)).toBe(1)
    expect(clampActiveIndex(2, 0)).toBe(-1)
  })
})
