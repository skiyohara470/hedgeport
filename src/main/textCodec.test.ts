import { describe, expect, it } from 'vitest'

import { decodeTextDocument, encodeTextDocument, resolveEncoding } from './textCodec'

describe('resolveEncoding', () => {
  it('未指定は utf-8、対応エンコードは透過、未対応は弾く', () => {
    expect(resolveEncoding(undefined)).toBe('utf-8')
    expect(resolveEncoding('shift_jis')).toBe('shift_jis')
    expect(() => resolveEncoding('utf-16')).toThrow('Unsupported encoding')
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
