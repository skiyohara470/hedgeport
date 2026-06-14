import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'

import {
  decodeTextDocument,
  detectEncoding,
  encodeTextDocument,
  resolveEncoding,
  resolveReadEncoding,
} from './textCodec'

describe('resolveEncoding', () => {
  it('未指定は utf-8、対応エンコードは透過、未対応は弾く', () => {
    expect(resolveEncoding(undefined)).toBe('utf-8')
    expect(resolveEncoding('shift_jis')).toBe('shift_jis')
    expect(() => resolveEncoding('utf-16')).toThrow('Unsupported encoding')
  })
})

describe('resolveReadEncoding', () => {
  it('未指定 / auto は auto、concrete は透過、未対応は弾く', () => {
    expect(resolveReadEncoding(undefined)).toBe('auto')
    expect(resolveReadEncoding('auto')).toBe('auto')
    expect(resolveReadEncoding('shift_jis')).toBe('shift_jis')
    expect(() => resolveReadEncoding('utf-16')).toThrow('Unsupported encoding')
  })
})

describe('detectEncoding', () => {
  it('UTF-8 BOM は utf-8', () => {
    expect(detectEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('utf-8')
  })

  it('ASCII / 空は utf-8', () => {
    expect(detectEncoding(new TextEncoder().encode('hello'))).toBe('utf-8')
    expect(detectEncoding(new Uint8Array([]))).toBe('utf-8')
  })

  it('UTF-8 の日本語は utf-8', () => {
    expect(detectEncoding(new TextEncoder().encode('日本語テキスト'))).toBe('utf-8')
  })

  it('Shift_JIS の日本語は shift_jis', () => {
    expect(detectEncoding(new Uint8Array(iconv.encode('日本語のテキストです', 'shift_jis')))).toBe('shift_jis')
  })

  it('EUC-JP の日本語は euc-jp', () => {
    expect(detectEncoding(new Uint8Array(iconv.encode('日本語のテキストです', 'euc-jp')))).toBe('euc-jp')
  })

  it('曖昧で明確差がない場合は手動選択を促す', () => {
    // [0xa4, 0xa2] は SJIS / EUC-JP 双方で構造妥当かつ日本語スコア差が小さく確定できない。
    expect(() => detectEncoding(new Uint8Array([0xa4, 0xa2]))).toThrow('Choose another encoding')
  })
})

describe('decodeTextDocument', () => {
  it('UTF-8 BOM を保持し本文から除く', () => {
    const data = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('hi')])
    expect(decodeTextDocument(data, 'utf-8')).toEqual({ text: 'hi', encoding: 'utf-8', bom: true })
  })

  it('NUL はバイナリ扱い、不正 UTF-8 は文字コード選択を促す', () => {
    expect(() => decodeTextDocument(new Uint8Array([0x61, 0x00]), 'utf-8')).toThrow('binary')
    expect(() => decodeTextDocument(new Uint8Array([0xff, 0xfe]), 'utf-8')).toThrow('Choose another encoding')
  })

  it('shift_jis をデコードできる', () => {
    expect(decodeTextDocument(new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]), 'shift_jis')).toEqual({
      text: '日本語',
      encoding: 'shift_jis',
      bom: false,
    })
  })

  it('auto は検出した concrete encoding を返す（utf-8 BOM）', () => {
    const data = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('hi')])
    expect(decodeTextDocument(data, 'auto')).toEqual({ text: 'hi', encoding: 'utf-8', bom: true })
  })

  it('auto は UTF-8 日本語を utf-8 として返す', () => {
    expect(decodeTextDocument(new TextEncoder().encode('日本語'), 'auto')).toEqual({
      text: '日本語',
      encoding: 'utf-8',
      bom: false,
    })
  })

  it('auto は Shift_JIS 日本語を shift_jis として返す（保存用に concrete）', () => {
    const data = new Uint8Array(iconv.encode('日本語のテキスト', 'shift_jis'))
    expect(decodeTextDocument(data, 'auto')).toEqual({ text: '日本語のテキスト', encoding: 'shift_jis', bom: false })
  })

  it('auto は EUC-JP 日本語を euc-jp として返す', () => {
    const data = new Uint8Array(iconv.encode('日本語のテキスト', 'euc-jp'))
    expect(decodeTextDocument(data, 'auto')).toEqual({ text: '日本語のテキスト', encoding: 'euc-jp', bom: false })
  })

  it('auto は NUL バイナリ / 判定不能を弾く', () => {
    expect(() => decodeTextDocument(new Uint8Array([0x61, 0x00]), 'auto')).toThrow('binary')
    expect(() => decodeTextDocument(new Uint8Array([0xa4, 0xa2]), 'auto')).toThrow('Choose another encoding')
  })
})

describe('encodeTextDocument', () => {
  it('utf-8 は bom 指定で BOM を付与', () => {
    expect(encodeTextDocument('hi', 'utf-8', true)).toEqual(
      new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('hi')])
    )
  })

  it('shift_jis で表現不能な文字は roundtrip 不一致で弾く', () => {
    expect(() => encodeTextDocument('emoji 😀', 'shift_jis', false)).toThrow('cannot represent some characters')
  })
})
