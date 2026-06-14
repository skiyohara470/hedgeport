import iconv from 'iconv-lite'

import {
  MAX_EDITABLE_TEXT_BYTES,
  TEXT_ENCODINGS,
  type ReadEncoding,
  type TextDocument,
  type TextEncoding,
} from '../shared/transfer'

/** UTF-8 BOM（EF BB BF）。 */
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const

// Shift_JIS / EUC-JP の自動判定で「明確な勝者」とみなす日本語スコア差の最小値（保守的）。
const SCORE_MARGIN = 2

/**
 * 保存用の文字コード指定を検証する。未指定は utf-8 とみなす。'auto' は不可。
 *
 * @param encoding 検証対象
 * @returns 妥当な TextEncoding
 * @throws 未対応の文字コードの場合
 */
export function resolveEncoding(encoding: unknown): TextEncoding {
  if (encoding === undefined) return 'utf-8'
  if (typeof encoding !== 'string' || !TEXT_ENCODINGS.includes(encoding as TextEncoding)) {
    throw new Error('Unsupported encoding.')
  }
  return encoding as TextEncoding
}

/**
 * 読み出し用の文字コード指定を検証する。未指定 / 'auto' は自動判定。
 *
 * @param encoding 検証対象
 * @returns 'auto' または妥当な TextEncoding
 * @throws 未対応の文字コードの場合
 */
export function resolveReadEncoding(encoding: unknown): ReadEncoding {
  if (encoding === undefined || encoding === 'auto') return 'auto'
  return resolveEncoding(encoding)
}

/**
 * 不正な UTF-8 を含まないか（fatal デコードが通るか）。
 */
function isValidUtf8(data: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
    return true
  } catch {
    return false
  }
}

/**
 * Shift_JIS として構造的に妥当なバイト列か（ASCII / 半角カナ単体 + 2 バイト文字）。
 */
function isValidShiftJis(data: Uint8Array): boolean {
  for (let i = 0; i < data.length; i += 1) {
    const b = data[i]
    if (b <= 0x7f || (b >= 0xa1 && b <= 0xdf)) continue
    if ((b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc)) {
      const trail = data[i + 1]
      if (trail === undefined || !((trail >= 0x40 && trail <= 0x7e) || (trail >= 0x80 && trail <= 0xfc))) return false
      i += 1
      continue
    }
    return false
  }
  return true
}

/**
 * EUC-JP として構造的に妥当なバイト列か（ASCII / 0x8E 半角カナ / 0x8F 補助漢字 / 2 バイト文字）。
 */
function isValidEucJp(data: Uint8Array): boolean {
  for (let i = 0; i < data.length; i += 1) {
    const b = data[i]
    if (b <= 0x7f) continue
    if (b === 0x8e) {
      const trail = data[i + 1]
      if (trail === undefined || !(trail >= 0xa1 && trail <= 0xdf)) return false
      i += 1
      continue
    }
    if (b === 0x8f) {
      const t1 = data[i + 1]
      const t2 = data[i + 2]
      if (t1 === undefined || t2 === undefined || t1 < 0xa1 || t1 > 0xfe || t2 < 0xa1 || t2 > 0xfe) return false
      i += 2
      continue
    }
    if (b >= 0xa1 && b <= 0xfe) {
      const trail = data[i + 1]
      if (trail === undefined || !(trail >= 0xa1 && trail <= 0xfe)) return false
      i += 1
      continue
    }
    return false
  }
  return true
}

/**
 * デコード結果の「日本語らしさ」スコア。SJIS/EUC のどちらで読むべきかの品質指標に使う。
 *
 * 強いシグナル（ひらがな・全角カタカナ・漢字）のみ加点する。半角カナ（0xff61-0xff9f）は
 * 誤デコード時に大量発生して指標を汚すため数えない（例: EUC バイトを SJIS と誤読すると
 * 単バイト 0xa1-0xdf が半角カナに化ける）。置換文字 U+FFFD は誤デコードの証拠として減点する。
 */
function japaneseScore(text: string): number {
  let score = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x4e00 && c <= 0x9fff)) score += 1
    else if (c === 0xfffd) score -= 1
  }
  return score
}

/**
 * バイト列の文字コードを自動判定する（concrete を返す）。
 * 方針: BOM→utf-8、妥当な UTF-8（ASCII / 空含む）→utf-8、そうでなければ SJIS / EUC-JP を構造検証し、
 * 妥当な候補が 1 つだけならそれ、両方妥当なら日本語スコアに明確差があるときだけ採用、
 * それ以外（曖昧 / どちらも不正）は手動選択を促す例外を投げる。低確信で黙って選ばない。
 *
 * @param data 生バイト列（NUL / サイズチェックは呼び出し側で済ませる前提）
 * @returns 判定した TextEncoding
 * @throws 判定できない / 曖昧な場合
 */
export function detectEncoding(data: Uint8Array): TextEncoding {
  if (data.length >= 3 && data[0] === UTF8_BOM[0] && data[1] === UTF8_BOM[1] && data[2] === UTF8_BOM[2]) {
    return 'utf-8'
  }
  if (isValidUtf8(data)) return 'utf-8'

  const sjisOk = isValidShiftJis(data)
  const eucOk = isValidEucJp(data)
  if (sjisOk && !eucOk) return 'shift_jis'
  if (eucOk && !sjisOk) return 'euc-jp'
  if (sjisOk && eucOk) {
    const sjisScore = japaneseScore(iconv.decode(Buffer.from(data), 'shift_jis'))
    const eucScore = japaneseScore(iconv.decode(Buffer.from(data), 'euc-jp'))
    if (sjisScore - eucScore >= SCORE_MARGIN) return 'shift_jis'
    if (eucScore - sjisScore >= SCORE_MARGIN) return 'euc-jp'
  }
  throw new Error('Could not detect the text encoding. Choose another encoding manually.')
}

/**
 * バイト列をテキストへデコードして TextDocument にする。
 * 'auto' は自動判定し、返す encoding は常に concrete。
 * 大容量 / NUL（バイナリ）は弾く。utf-8 は BOM 有無を保持し、不正時は文字コード選択を促す。
 *
 * @param data 生バイト列
 * @param encoding 文字コード（'auto' で自動判定）
 * @returns text / 検出した concrete encoding / bom
 * @throws サイズ超過・バイナリ・不正 UTF-8・判定不能の場合
 */
export function decodeTextDocument(data: Uint8Array, encoding: ReadEncoding): TextDocument {
  if (data.byteLength > MAX_EDITABLE_TEXT_BYTES) {
    throw new Error(`File is too large to edit as text (limit ${MAX_EDITABLE_TEXT_BYTES} bytes).`)
  }
  // NUL を含む場合はバイナリ扱い（日本語 SJIS/EUC は NUL を含まない）。
  if (data.includes(0)) {
    throw new Error('File looks binary (contains NUL) and cannot be edited as text.')
  }

  const concrete = encoding === 'auto' ? detectEncoding(data) : encoding
  if (concrete === 'utf-8') {
    const bom = data.length >= 3 && data[0] === UTF8_BOM[0] && data[1] === UTF8_BOM[1] && data[2] === UTF8_BOM[2]
    try {
      // TextDecoder は先頭 BOM を自動で剥がす。fatal:true で不正 UTF-8 を検出する。
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(data), encoding: 'utf-8', bom }
    } catch {
      throw new Error('This file is not valid UTF-8. Choose another encoding.')
    }
  }
  // SJIS / EUC-JP は iconv-lite でデコードする（BOM 概念なし）。
  return { text: iconv.decode(Buffer.from(data), concrete), encoding: concrete, bom: false }
}

/**
 * テキストを指定文字コードでエンコードする。
 * SJIS/EUC は encode→decode の厳密 roundtrip で表現不能文字（'?' 置換）を検出して弾く。
 * utf-8 は bom=true なら BOM を付与する。
 *
 * @param text 保存するテキスト
 * @param encoding 文字コード（concrete）
 * @param bom utf-8 の BOM 付与有無
 * @returns 書き込むバイト列
 * @throws 表現不能文字・サイズ超過の場合
 */
export function encodeTextDocument(text: string, encoding: TextEncoding, bom: boolean): Uint8Array {
  let data: Uint8Array
  if (encoding === 'utf-8') {
    const encoded = new TextEncoder().encode(text)
    data = bom ? new Uint8Array([...UTF8_BOM, ...encoded]) : encoded
  } else {
    const encoded = iconv.encode(text, encoding)
    if (iconv.decode(encoded, encoding) !== text) {
      throw new Error('The selected encoding cannot represent some characters in this file.')
    }
    data = new Uint8Array(encoded)
  }
  if (data.byteLength > MAX_EDITABLE_TEXT_BYTES) {
    throw new Error(`Text is too large to save (limit ${MAX_EDITABLE_TEXT_BYTES} bytes).`)
  }
  return data
}
