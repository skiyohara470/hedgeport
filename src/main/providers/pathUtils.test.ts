import { describe, expect, it } from 'vitest'

import {
  joinSftpPath,
  joinVirtualPath,
  normalizeS3Prefix,
  normalizeVirtualPath,
  parentVirtualPath,
  s3KeyForPath,
} from './pathUtils'

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

  it('S3 Prefixを仮想ルートとして扱う', () => {
    expect(normalizeS3Prefix('/tenant-a/files/')).toBe('tenant-a/files')
    expect(s3KeyForPath('/tenant-a/files/', '/')).toBe('tenant-a/files')
    expect(s3KeyForPath('/tenant-a/files/', '/daily/report.csv')).toBe(
      'tenant-a/files/daily/report.csv'
    )
  })
})
