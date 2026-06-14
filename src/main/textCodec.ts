import iconv from 'iconv-lite'

import { MAX_EDITABLE_TEXT_BYTES, TEXT_ENCODINGS, type TextDocument, type TextEncoding } from '../shared/transfer'

/** UTF-8 BOM（EF BB BF）。 */
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const

/**
 * 文字コード指定を検証する。未指定は utf-8 とみなす。
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
 * バイト列をテキストへデコードして TextDocument にする。
 * 大容量 / NUL（バイナリ）は弾く。utf-8 は BOM 有無を保持し、不正時は文字コード選択を促す。
 *
 * @param data 生バイト列
 * @param encoding 文字コード
 * @returns text / encoding / bom
 * @throws サイズ超過・バイナリ・不正 UTF-8 の場合
 */
export function decodeTextDocument(data: Uint8Array, encoding: TextEncoding): TextDocument {
  if (data.byteLength > MAX_EDITABLE_TEXT_BYTES) {
    throw new Error(`File is too large to edit as text (limit ${MAX_EDITABLE_TEXT_BYTES} bytes).`)
  }
  // NUL を含む場合はバイナリ扱い（日本語 SJIS/EUC は NUL を含まない）。
  if (data.includes(0)) {
    throw new Error('File looks binary (contains NUL) and cannot be edited as text.')
  }
  if (encoding === 'utf-8') {
    const bom = data.length >= 3 && data[0] === UTF8_BOM[0] && data[1] === UTF8_BOM[1] && data[2] === UTF8_BOM[2]
    try {
      // TextDecoder は先頭 BOM を自動で剥がす。fatal:true で不正 UTF-8 を検出する。
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(data), encoding: 'utf-8', bom }
    } catch {
      throw new Error('This file is not valid UTF-8. Choose another encoding.')
    }
  }
  // SJIS / EUC-JP は iconv-lite で寛容にデコードする（BOM 概念なし）。
  return { text: iconv.decode(Buffer.from(data), encoding), encoding, bom: false }
}

/**
 * テキストを指定文字コードでエンコードする。
 * SJIS/EUC は encode→decode の厳密 roundtrip で表現不能文字（'?' 置換）を検出して弾く。
 * utf-8 は bom=true なら BOM を付与する。
 *
 * @param text 保存するテキスト
 * @param encoding 文字コード
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
