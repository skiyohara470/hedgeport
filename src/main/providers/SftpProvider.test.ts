import { describe, expect, it } from 'vitest'

import { sftpTimestampToIso } from './SftpProvider'

describe('sftpTimestampToIso', () => {
  it('ミリ秒のSFTP更新日時をISO文字列へ変換する', () => {
    expect(sftpTimestampToIso(1_717_000_000_000)).toBe('2024-05-29T16:26:40.000Z')
  })

  it('秒単位で返すサーバーの更新日時にも対応する', () => {
    expect(sftpTimestampToIso(1_717_000_000)).toBe('2024-05-29T16:26:40.000Z')
  })

  it('無効な更新日時は表示対象外にする', () => {
    expect(sftpTimestampToIso(0)).toBeUndefined()
  })
})
