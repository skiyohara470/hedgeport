import { describe, expect, it } from 'vitest'

import { computeContentRevision } from './contentRevision'

describe('computeContentRevision', () => {
  it('同一バイト列は同一値、異なれば別値になる', () => {
    const a = computeContentRevision(new Uint8Array([1, 2, 3]))
    const b = computeContentRevision(new Uint8Array([1, 2, 3]))
    const c = computeContentRevision(new Uint8Array([1, 2, 4]))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('空ファイルも安定値を返す', () => {
    expect(computeContentRevision(new Uint8Array())).toBe(computeContentRevision(new Uint8Array()))
    // 空と非空は別値。
    expect(computeContentRevision(new Uint8Array())).not.toBe(computeContentRevision(new Uint8Array([0])))
  })

  it('16 進の SHA-256（64 文字）を返す', () => {
    expect(computeContentRevision(new Uint8Array([0x61]))).toMatch(/^[0-9a-f]{64}$/)
  })
})
