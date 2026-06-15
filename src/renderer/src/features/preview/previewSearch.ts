/**
 * プレビューウィンドウ内検索の純ロジック。
 * Chromium の `webContents.findInPage` には依存せず、文字列リテラル検索（正規表現ではない）を
 * 提供する。renderer の UI からは独立してテストできる。
 */

/** 検索 match 数の安全上限（巨大ファイルでの過剰な DOM 化を防ぐ）。 */
export const MAX_MATCHES = 10000

/** 検索結果。matches は元本文中の match 開始 index（非重複・先頭順）。 */
export interface SearchResult {
  matches: number[]
  /** 上限（MAX_MATCHES）超過で列挙を打ち切ったか。 */
  truncated: boolean
}

/** 描画用セグメント。highlight が none の連続テキストと、match / active な部分に分かれる。 */
export interface SearchSegment {
  text: string
  highlight: 'none' | 'match' | 'active'
}

/**
 * 長さを保つ簡易 case folding（ASCII / 日本語中心の想定）。
 * UTF-16 コードユニット単位で小文字化し、結果が 1 ユニットに収まる場合だけ畳む。
 * これにより folding 後も index が元本文に 1:1 対応し、case-insensitive 検索でも
 * match index を原文へ正しく射影できる。
 *
 * 対応範囲の限界（意図的）:
 * - 小文字化で長さが変わる文字（例: 'İ' → 'i̇'）は畳まず、その文字は大小区別されたまま扱う。
 * - astral（サロゲートペア）文字は code unit 単位で素通しし、case folding しない。
 * 一般 Unicode の完全な大文字小文字無視は目的としない（日本語に case 概念は無く、ASCII は完全に対応）。
 *
 * @param value 対象文字列
 * @returns 長さ不変の folding 済み文字列
 */
function foldCaseLengthPreserving(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    const lower = ch.toLowerCase()
    out += lower.length === 1 ? lower : ch
  }
  return out
}

/**
 * 文字列リテラル検索。非重複の match を先頭から列挙する。
 * case-insensitive 時も match index は元本文に対応する。空 query は 0 件扱い。
 *
 * @param text 本文
 * @param query 検索語
 * @param caseSensitive 大文字小文字を区別するか
 * @returns match 開始 index 配列と truncated フラグ
 */
export function searchText(text: string, query: string, caseSensitive: boolean): SearchResult {
  if (query.length === 0) return { matches: [], truncated: false }
  const haystack = caseSensitive ? text : foldCaseLengthPreserving(text)
  const needle = caseSensitive ? query : foldCaseLengthPreserving(query)
  const matches: number[] = []
  let from = 0
  let truncated = false
  for (;;) {
    const index = haystack.indexOf(needle, from)
    if (index === -1) break
    if (matches.length >= MAX_MATCHES) {
      truncated = true
      break
    }
    matches.push(index)
    // 非重複で次へ進む（match 長ぶんスキップ）。
    from = index + needle.length
  }
  return { matches, truncated }
}

/**
 * 本文を描画用セグメントへ分割する。
 * query なし / match なしのときは本文を単一セグメントとして返す（単一 text node 描画用）。
 * match ありのときだけ、間のテキストと match 部分（active / それ以外）に刻む。
 *
 * @param text 本文
 * @param matches match 開始 index 配列（searchText の結果）
 * @param queryLength 検索語の長さ（match の長さ）
 * @param activeIndex 現在アクティブな match の添字（-1 で無し）
 * @returns 描画用セグメント配列
 */
export function buildSegments(
  text: string,
  matches: number[],
  queryLength: number,
  activeIndex: number
): SearchSegment[] {
  if (matches.length === 0 || queryLength <= 0) return [{ text, highlight: 'none' }]
  const segments: SearchSegment[] = []
  let cursor = 0
  matches.forEach((start, i) => {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), highlight: 'none' })
    const end = start + queryLength
    segments.push({ text: text.slice(start, end), highlight: i === activeIndex ? 'active' : 'match' })
    cursor = end
  })
  if (cursor < text.length) segments.push({ text: text.slice(cursor), highlight: 'none' })
  return segments
}

/**
 * 次の match 添字（末尾→先頭へ wrap）。match が無ければ -1。
 *
 * @param active 現在の添字
 * @param count match 件数
 */
export function nextMatchIndex(active: number, count: number): number {
  if (count <= 0) return -1
  return (active + 1) % count
}

/**
 * 前の match 添字（先頭→末尾へ wrap）。match が無ければ -1。
 *
 * @param active 現在の添字
 * @param count match 件数
 */
export function prevMatchIndex(active: number, count: number): number {
  if (count <= 0) return -1
  return (active - 1 + count) % count
}

/**
 * match 件数の変化（再検索・再読込）に合わせて active 添字を妥当な範囲へ補正する。
 * 件数 0 なら -1、範囲外なら端へ寄せる。query を保持したまま encoding 再読込した場合などに使う。
 *
 * @param active 補正前の添字
 * @param count 新しい match 件数
 */
export function clampActiveIndex(active: number, count: number): number {
  if (count <= 0) return -1
  if (active < 0) return 0
  return Math.min(active, count - 1)
}
