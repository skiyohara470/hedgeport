import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sendMock, destroyMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  destroyMock: vi.fn(),
}))

vi.mock('@aws-sdk/client-s3', () => {
  class CopyObjectCommand {
    constructor(public readonly input: { Key: string; CopySource: string; Bucket: string }) {}
  }

  class DeleteObjectCommand {
    constructor(public readonly input: { Key: string; Bucket: string }) {}
  }

  class DeleteObjectsCommand {
    constructor(public readonly input: { Bucket: string; Delete: { Objects: Array<{ Key: string }> } }) {}
  }

  class GetObjectCommand {
    constructor(public readonly input: unknown) {}
  }

  class GetBucketLocationCommand {
    constructor(public readonly input: { Bucket: string }) {}
  }

  class ListBucketsCommand {
    constructor(public readonly input: { ContinuationToken?: string }) {}
  }

  class ListObjectsV2Command {
    constructor(public readonly input: { Bucket?: string; Prefix?: string; ContinuationToken?: string }) {}
  }

  class PutObjectCommand {
    constructor(public readonly input: { Key: string; Body: unknown; Bucket: string }) {}
  }

  class S3Client {
    send = sendMock
    destroy = destroyMock
  }

  return {
    CopyObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    GetBucketLocationCommand,
    ListBucketsCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
  }
})

import { encodeCopySource, normalizeBucketRegion, S3Provider } from './S3Provider'

const target = {
  id: 's3-1',
  name: 'S3',
  kind: 's3' as const,
  region: 'ap-northeast-1',
  accessKeyId: 'AKIA...',
  secretAccessKey: 'secret',
  sessionToken: '',
}

/**
 * 送信されたコマンドのうち、指定クラス名のものだけを取り出す。
 */
const sentOfType = (typeName: string): Array<{ input: Record<string, unknown> }> =>
  sendMock.mock.calls.map((call) => call[0]).filter((command) => command.constructor.name === typeName)

describe('encodeCopySource', () => {
  it('key のスラッシュは保持しセグメントだけエンコードする', () => {
    expect(encodeCopySource('bucket-a', 'reports/2026/a b.csv')).toBe('bucket-a/reports/2026/a%20b.csv')
  })
})

describe('normalizeBucketRegion', () => {
  it('空は us-east-1、EU は eu-west-1、それ以外は透過', () => {
    expect(normalizeBucketRegion(undefined)).toBe('us-east-1')
    expect(normalizeBucketRegion('EU')).toBe('eu-west-1')
    expect(normalizeBucketRegion('ap-northeast-1')).toBe('ap-northeast-1')
  })
})

describe('S3Provider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    destroyMock.mockReturnValue(undefined)
  })

  it('list(/) は region 内の bucket を pagination 込みでディレクトリ列挙する', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string }; input: { Bucket?: string } }) => {
      const name = command.constructor.name
      if (name === 'ListBucketsCommand') {
        // pagination: 2 ページに分けて返す。
        const token = (command.input as { ContinuationToken?: string }).ContinuationToken
        if (token === undefined) {
          return { Buckets: [{ Name: 'bucket-a' }, { Name: 'bucket-z' }], ContinuationToken: 'p2' }
        }
        return { Buckets: [{ Name: 'bucket-m' }] }
      }
      if (name === 'GetBucketLocationCommand') {
        // bucket-z だけ別 region（us-east-1）。a / m は設定 region に一致。
        const bucket = command.input.Bucket
        if (bucket === 'bucket-z') return { LocationConstraint: undefined }
        return { LocationConstraint: 'ap-northeast-1' }
      }
      return {}
    })
    const provider = new S3Provider(target)

    await expect(provider.list('/')).resolves.toEqual([
      { name: 'bucket-a', path: '/bucket-a', type: 'directory' },
      { name: 'bucket-m', path: '/bucket-m', type: 'directory' },
    ])
    // ListBuckets は continuation で 2 回。
    expect(sentOfType('ListBucketsCommand')).toHaveLength(2)
    expect(destroyMock).toHaveBeenCalledTimes(1)
  })

  it('list(/bucket) は bucket ルート（Prefix 空）を列挙する', async () => {
    sendMock.mockResolvedValue({ CommonPrefixes: [], Contents: [], IsTruncated: false })
    const provider = new S3Provider(target)

    await provider.list('/bucket-a')

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { Bucket: 'bucket-a', Prefix: '', Delimiter: '/', ContinuationToken: undefined },
      })
    )
  })

  it('list は疑似ディレクトリと直下ファイルだけを集約し pagination する', async () => {
    sendMock
      .mockResolvedValueOnce({
        CommonPrefixes: [{ Prefix: 'reports/sub/' }],
        Contents: [
          { Key: 'reports/', Size: 0 },
          { Key: 'reports/zeta.csv', Size: 9, LastModified: new Date('2024-06-01T00:00:00.000Z') },
          { Key: 'reports/sub/old.csv', Size: 5 },
        ],
        IsTruncated: true,
        NextContinuationToken: 'page-2',
      })
      .mockResolvedValueOnce({
        CommonPrefixes: [{ Prefix: 'reports/sub/' }],
        Contents: [{ Key: 'reports/alpha.csv', Size: 3, LastModified: new Date('2024-05-01T00:00:00.000Z') }],
        IsTruncated: false,
      })
    const provider = new S3Provider(target)

    await expect(provider.list('/bucket-a/reports')).resolves.toEqual([
      { name: 'sub', path: '/bucket-a/reports/sub', type: 'directory' },
      {
        name: 'alpha.csv',
        path: '/bucket-a/reports/alpha.csv',
        type: 'file',
        size: 3,
        modifiedAt: '2024-05-01T00:00:00.000Z',
      },
      {
        name: 'zeta.csv',
        path: '/bucket-a/reports/zeta.csv',
        type: 'file',
        size: 9,
        modifiedAt: '2024-06-01T00:00:00.000Z',
      },
    ])
    expect(sendMock.mock.calls[0][0].input).toEqual({
      Bucket: 'bucket-a',
      Prefix: 'reports/',
      Delimiter: '/',
      ContinuationToken: undefined,
    })
    expect(sendMock.mock.calls[1][0].input).toEqual({
      Bucket: 'bucket-a',
      Prefix: 'reports/',
      Delimiter: '/',
      ContinuationToken: 'page-2',
    })
  })

  it('list はネストした仮想パスを bucket と prefix に変換する', async () => {
    sendMock.mockResolvedValue({ CommonPrefixes: [], Contents: [], IsTruncated: false })
    const provider = new S3Provider(target)

    await provider.list('/bucket-a/reports/2026')

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { Bucket: 'bucket-a', Prefix: 'reports/2026/', Delimiter: '/', ContinuationToken: undefined },
      })
    )
  })

  it('read は path から bucket / key を導出して取得する', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    sendMock.mockResolvedValue({ Body: { transformToByteArray: vi.fn().mockResolvedValue(bytes) } })
    const provider = new S3Provider(target)

    await expect(provider.read('/bucket-a/reports/a.csv')).resolves.toEqual(bytes)
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ input: { Bucket: 'bucket-a', Key: 'reports/a.csv' } })
    )
  })

  it('read は Body が無いと例外を投げる', async () => {
    sendMock.mockResolvedValue({ Body: undefined })
    const provider = new S3Provider(target)

    await expect(provider.read('/bucket-a/reports/a.csv')).rejects.toThrow('S3 object has no body.')
  })

  it('write と delete は path から bucket / key を導出する', async () => {
    sendMock.mockResolvedValue({})
    const provider = new S3Provider(target)
    const bytes = new Uint8Array([9, 8, 7])

    await provider.write('/bucket-a/reports/a.csv', bytes)
    await provider.delete('/bucket-a/reports/a.csv')

    expect(sendMock.mock.calls[0][0].input).toEqual({ Bucket: 'bucket-a', Key: 'reports/a.csv', Body: bytes })
    expect(sendMock.mock.calls[1][0].input).toEqual({ Bucket: 'bucket-a', Key: 'reports/a.csv' })
  })

  it('ルート / bare bucket への object 操作は明示エラーで弾く', async () => {
    const provider = new S3Provider(target)
    // key を要する操作はルート（bucket 無し）と bare bucket（key 無し）を拒否する。
    await expect(provider.read('/')).rejects.toThrow('requires a bucket path')
    await expect(provider.read('/bucket-a')).rejects.toThrow('bucket root')
    await expect(provider.write('/bucket-a', new Uint8Array())).rejects.toThrow('bucket root')
    await expect(provider.delete('/bucket-a')).rejects.toThrow('bucket root')
    await expect(provider.createDirectory('/bucket-a')).rejects.toThrow('bucket root')
    await expect(provider.deleteDirectory('/bucket-a')).rejects.toThrow('bucket root')
    await expect(provider.rename('/bucket-a', '/bucket-a/x', 'file')).rejects.toThrow('bucket root')
    await expect(provider.copyFile('/bucket-a', '/bucket-a/x')).rejects.toThrow('bucket root')
    // bare bucket への mutation で S3 へ Put/Delete は飛ばさない。
    expect(sentOfType('PutObjectCommand')).toHaveLength(0)
    expect(sentOfType('DeleteObjectCommand')).toHaveLength(0)
  })

  it('createDirectory は末尾スラッシュ marker を PutObject する', async () => {
    sendMock.mockResolvedValue({ Contents: [], IsTruncated: false })
    const provider = new S3Provider(target)

    await provider.createDirectory('/bucket-a/reports/2027')

    const puts = sentOfType('PutObjectCommand')
    expect(puts).toHaveLength(1)
    expect(puts[0].input.Bucket).toBe('bucket-a')
    expect(puts[0].input.Key).toBe('reports/2027/')
    expect(puts[0].input.Body).toEqual(new Uint8Array())
  })

  it('createDirectory は既存名衝突を弾き marker を書かない', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string } }) =>
      command.constructor.name === 'ListObjectsV2Command' ? { Contents: [{ Key: 'reports/dup' }] } : {}
    )
    const provider = new S3Provider(target)

    await expect(provider.createDirectory('/bucket-a/reports/dup')).rejects.toThrow('already exists')
    expect(sentOfType('PutObjectCommand')).toHaveLength(0)
  })

  it('file rename(同一 bucket) は CopyObject 後に DeleteObject する', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string } }) =>
      command.constructor.name === 'ListObjectsV2Command' ? { Contents: [] } : {}
    )
    const provider = new S3Provider(target)

    await provider.rename('/bucket-a/reports/a.csv', '/bucket-a/reports/b.csv', 'file')

    const copies = sentOfType('CopyObjectCommand')
    expect(copies).toHaveLength(1)
    expect(copies[0].input).toMatchObject({
      Bucket: 'bucket-a',
      Key: 'reports/b.csv',
      CopySource: 'bucket-a/reports/a.csv',
    })
    const deletes = sentOfType('DeleteObjectCommand')
    expect(deletes[0].input).toEqual({ Bucket: 'bucket-a', Key: 'reports/a.csv' })
  })

  it('file rename(別 bucket) は source bucket を CopySource に、dest bucket へ copy し source を削除する', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string } }) =>
      command.constructor.name === 'ListObjectsV2Command' ? { Contents: [] } : {}
    )
    const provider = new S3Provider(target)

    await provider.rename('/bucket-a/a.csv', '/bucket-b/b.csv', 'file')

    const copies = sentOfType('CopyObjectCommand')
    expect(copies[0].input).toMatchObject({ Bucket: 'bucket-b', Key: 'b.csv', CopySource: 'bucket-a/a.csv' })
    const deletes = sentOfType('DeleteObjectCommand')
    expect(deletes[0].input).toEqual({ Bucket: 'bucket-a', Key: 'a.csv' })
  })

  it('directory rename は全 copy 後に DeleteObjects(chunk) する', async () => {
    sendMock.mockImplementation(
      async (command: { constructor: { name: string }; input: { Prefix?: string; ContinuationToken?: string } }) => {
        if (command.constructor.name !== 'ListObjectsV2Command') return {}
        const prefix = command.input.Prefix ?? ''
        if (prefix.startsWith('archive')) return { Contents: [] } // dest 存在チェックは空。
        if (command.input.ContinuationToken === undefined) {
          return {
            Contents: [{ Key: 'reports/' }, { Key: 'reports/a.csv' }],
            IsTruncated: true,
            NextContinuationToken: 'p2',
          }
        }
        return { Contents: [{ Key: 'reports/sub/b.csv' }], IsTruncated: false }
      }
    )
    const provider = new S3Provider(target)

    await provider.rename('/bucket-a/reports', '/bucket-a/archive', 'directory')

    const copies = sentOfType('CopyObjectCommand')
    expect(copies.map((command) => command.input.Key)).toEqual(['archive/', 'archive/a.csv', 'archive/sub/b.csv'])
    expect(copies[1].input.CopySource).toBe('bucket-a/reports/a.csv')
    const deletes = sentOfType('DeleteObjectsCommand')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].input.Bucket).toBe('bucket-a')
    expect((deletes[0].input.Delete as { Objects: Array<{ Key: string }> }).Objects.map((o) => o.Key)).toEqual([
      'reports/',
      'reports/a.csv',
      'reports/sub/b.csv',
    ])
  })

  it('directory rename(別 bucket) は dest bucket へ copy し source bucket を削除する', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string }; input: { Prefix?: string } }) => {
      if (command.constructor.name !== 'ListObjectsV2Command') return {}
      const prefix = command.input.Prefix ?? ''
      if (prefix.startsWith('archive')) return { Contents: [] }
      return { Contents: [{ Key: 'reports/a.csv' }], IsTruncated: false }
    })
    const provider = new S3Provider(target)

    await provider.rename('/bucket-a/reports', '/bucket-b/archive', 'directory')

    const copies = sentOfType('CopyObjectCommand')
    expect(copies[0].input).toMatchObject({
      Bucket: 'bucket-b',
      Key: 'archive/a.csv',
      CopySource: 'bucket-a/reports/a.csv',
    })
    const deletes = sentOfType('DeleteObjectsCommand')
    expect(deletes[0].input.Bucket).toBe('bucket-a')
  })

  it('directory rename は copy 失敗時に元を削除しない', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string }; input: { Prefix?: string } }) => {
      const name = command.constructor.name
      if (name === 'ListObjectsV2Command') {
        const prefix = command.input.Prefix ?? ''
        if (prefix.startsWith('archive')) return { Contents: [] }
        return { Contents: [{ Key: 'reports/a.csv' }], IsTruncated: false }
      }
      if (name === 'CopyObjectCommand') throw new Error('copy failed')
      return {}
    })
    const provider = new S3Provider(target)

    await expect(provider.rename('/bucket-a/reports', '/bucket-a/archive', 'directory')).rejects.toThrow('copy failed')
    expect(sentOfType('DeleteObjectsCommand')).toHaveLength(0)
  })

  it('directory rename は DeleteObjects が Errors を返したら明示エラー', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string }; input: { Prefix?: string } }) => {
      const name = command.constructor.name
      if (name === 'ListObjectsV2Command') {
        const prefix = command.input.Prefix ?? ''
        if (prefix.startsWith('archive')) return { Contents: [] }
        return { Contents: [{ Key: 'reports/a.csv' }], IsTruncated: false }
      }
      if (name === 'DeleteObjectsCommand') return { Errors: [{ Key: 'reports/a.csv', Code: 'AccessDenied' }] }
      return {}
    })
    const provider = new S3Provider(target)

    await expect(provider.rename('/bucket-a/reports', '/bucket-a/archive', 'directory')).rejects.toThrow('AccessDenied')
  })

  it('directory rename は source が空（0件）なら明示エラー', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string } }) =>
      command.constructor.name === 'ListObjectsV2Command' ? { Contents: [], IsTruncated: false } : {}
    )
    const provider = new S3Provider(target)

    await expect(provider.rename('/bucket-a/missing', '/bucket-a/archive', 'directory')).rejects.toThrow('not found')
    expect(sentOfType('CopyObjectCommand')).toHaveLength(0)
  })

  it('deleteDirectory は prefix 配下を列挙して DeleteObjects する', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string } }) =>
      command.constructor.name === 'ListObjectsV2Command'
        ? { Contents: [{ Key: 'reports/' }, { Key: 'reports/a.csv' }], IsTruncated: false }
        : {}
    )
    const provider = new S3Provider(target)

    await provider.deleteDirectory('/bucket-a/reports')

    const deletes = sentOfType('DeleteObjectsCommand')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].input.Bucket).toBe('bucket-a')
    expect((deletes[0].input.Delete as { Objects: Array<{ Key: string }> }).Objects.map((o) => o.Key)).toEqual([
      'reports/',
      'reports/a.csv',
    ])
  })

  it('deleteDirectory は空（0件）なら明示エラー', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string } }) =>
      command.constructor.name === 'ListObjectsV2Command' ? { Contents: [] } : {}
    )
    const provider = new S3Provider(target)

    await expect(provider.deleteDirectory('/bucket-a/missing')).rejects.toThrow('not found')
    expect(sentOfType('DeleteObjectsCommand')).toHaveLength(0)
  })

  it('copyFile は CopyObject を送る（元は残す、cross-bucket 対応）', async () => {
    sendMock.mockResolvedValue({})
    const provider = new S3Provider(target)

    await provider.copyFile('/bucket-a/reports/a.csv', '/bucket-b/reports/a copy.csv')

    const copies = sentOfType('CopyObjectCommand')
    expect(copies).toHaveLength(1)
    expect(copies[0].input).toMatchObject({
      Bucket: 'bucket-b',
      Key: 'reports/a copy.csv',
      CopySource: 'bucket-a/reports/a.csv',
    })
    expect(sentOfType('DeleteObjectCommand')).toHaveLength(0)
  })
})
