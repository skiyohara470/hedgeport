import { describe, expect, it } from 'vitest'

import { joinSftpPath, joinVirtualPath, normalizeVirtualPath, parentVirtualPath, parseS3VirtualPath } from './pathUtils'

describe('storage path helpers', () => {
  it('仮想パスをルート起点に正規化する', () => {
    expect(normalizeVirtualPath('reports/../archive')).toBe('/archive')
    expect(joinVirtualPath('/archive', '2026')).toBe('/archive/2026')
    expect(parentVirtualPath('/archive/2026')).toBe('/archive')
    expect(parentVirtualPath('/')).toBeNull()
  })

  it('SFTPの開始パスを仮想ルートとして扱う', () => {
    expect(joinSftpPath('/srv/exports', '/')).toBe('/srv/exports')
    expect(joinSftpPath('/srv/exports', '/daily/report.csv')).toBe('/srv/exports/daily/report.csv')
  })

  it('S3 仮想パスを bucket と key に分解する', () => {
    expect(parseS3VirtualPath('/')).toEqual({ bucket: null, key: '' })
    expect(parseS3VirtualPath('/bucket-a')).toEqual({ bucket: 'bucket-a', key: '' })
    expect(parseS3VirtualPath('/bucket-a/daily/report.csv')).toEqual({
      bucket: 'bucket-a',
      key: 'daily/report.csv',
    })
  })
})
