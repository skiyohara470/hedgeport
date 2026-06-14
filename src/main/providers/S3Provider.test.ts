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
    constructor(public readonly input: { Key: string }) {}
  }

  class DeleteObjectsCommand {
    constructor(public readonly input: { Delete: { Objects: Array<{ Key: string }> } }) {}
  }

  class GetObjectCommand {
    constructor(public readonly input: unknown) {}
  }

  class ListObjectsV2Command {
    constructor(public readonly input: { Prefix?: string; ContinuationToken?: string }) {}
  }

  class PutObjectCommand {
    constructor(public readonly input: { Key: string; Body: unknown }) {}
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
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
  }
})

import { S3Provider } from './S3Provider'

const target = {
  id: 's3-1',
  name: 'S3',
  kind: 's3' as const,
  region: 'ap-northeast-1',
  bucket: 'bucket-a',
  prefix: '/tenant-a/files/',
  accessKeyId: 'AKIA...',
  secretAccessKey: 'secret',
  sessionToken: '',
}

describe('S3Provider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    destroyMock.mockReturnValue(undefined)
  })

  it('list は疑似ディレクトリと直下ファイルだけを集約して返す', async () => {
    sendMock
      .mockResolvedValueOnce({
        CommonPrefixes: [{ Prefix: 'tenant-a/files/reports/' }, { Prefix: 'tenant-a/files/archive/' }],
        Contents: [
          { Key: 'tenant-a/files/', Size: 0 },
          { Key: 'tenant-a/files/zeta.csv', Size: 9, LastModified: new Date('2024-06-01T00:00:00.000Z') },
          { Key: 'tenant-a/files/archive/old.csv', Size: 5 },
        ],
        IsTruncated: true,
        NextContinuationToken: 'page-2',
      })
      .mockResolvedValueOnce({
        CommonPrefixes: [{ Prefix: 'tenant-a/files/archive/' }],
        Contents: [{ Key: 'tenant-a/files/alpha.csv', Size: 3, LastModified: new Date('2024-05-01T00:00:00.000Z') }],
        IsTruncated: false,
      })

    const provider = new S3Provider(target)

    await expect(provider.list('/')).resolves.toEqual([
      { name: 'archive', path: '/archive', type: 'directory' },
      { name: 'reports', path: '/reports', type: 'directory' },
      {
        name: 'alpha.csv',
        path: '/alpha.csv',
        type: 'file',
        size: 3,
        modifiedAt: '2024-05-01T00:00:00.000Z',
      },
      {
        name: 'zeta.csv',
        path: '/zeta.csv',
        type: 'file',
        size: 9,
        modifiedAt: '2024-06-01T00:00:00.000Z',
      },
    ])

    expect(sendMock).toHaveBeenCalledTimes(2)
    expect(sendMock.mock.calls[0][0].input).toEqual({
      Bucket: 'bucket-a',
      Prefix: 'tenant-a/files/',
      Delimiter: '/',
      ContinuationToken: undefined,
    })
    expect(sendMock.mock.calls[1][0].input).toEqual({
      Bucket: 'bucket-a',
      Prefix: 'tenant-a/files/',
      Delimiter: '/',
      ContinuationToken: 'page-2',
    })
    expect(destroyMock).toHaveBeenCalledTimes(1)
  })

  it('list はネストした仮想パスを対応する prefix に変換する', async () => {
    sendMock.mockResolvedValue({ CommonPrefixes: [], Contents: [], IsTruncated: false })

    const provider = new S3Provider(target)
    await provider.list('/reports/2026')

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          Bucket: 'bucket-a',
          Prefix: 'tenant-a/files/reports/2026/',
          Delimiter: '/',
          ContinuationToken: undefined,
        },
      })
    )
  })

  it('read は Body を Uint8Array として返す', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    sendMock.mockResolvedValue({
      Body: {
        transformToByteArray: vi.fn().mockResolvedValue(bytes),
      },
    })

    const provider = new S3Provider(target)

    await expect(provider.read('/reports/a.csv')).resolves.toEqual(bytes)
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          Bucket: 'bucket-a',
          Key: 'tenant-a/files/reports/a.csv',
        },
      })
    )
    expect(destroyMock).toHaveBeenCalledTimes(1)
  })

  it('read は Body が無いと例外を投げる', async () => {
    sendMock.mockResolvedValue({ Body: undefined })

    const provider = new S3Provider(target)

    await expect(provider.read('/reports/a.csv')).rejects.toThrow('S3 object has no body.')
    expect(destroyMock).toHaveBeenCalledTimes(1)
  })

  it('write と delete は対応する object key を送る', async () => {
    sendMock.mockResolvedValue({})
    const provider = new S3Provider(target)
    const bytes = new Uint8Array([9, 8, 7])

    await provider.write('/reports/a.csv', bytes)
    await provider.delete('/reports/a.csv')

    expect(sendMock.mock.calls[0][0].input).toEqual({
      Bucket: 'bucket-a',
      Key: 'tenant-a/files/reports/a.csv',
      Body: bytes,
    })
    expect(sendMock.mock.calls[1][0].input).toEqual({
      Bucket: 'bucket-a',
      Key: 'tenant-a/files/reports/a.csv',
    })
    expect(destroyMock).toHaveBeenCalledTimes(2)
  })

  /**
   * 送信されたコマンドのうち、指定クラス名のものだけを取り出す。
   */
  const sentOfType = (typeName: string): Array<{ input: Record<string, unknown> }> =>
    sendMock.mock.calls.map((call) => call[0]).filter((command) => command.constructor.name === typeName)

  it('createDirectory は末尾スラッシュ marker を PutObject する', async () => {
    sendMock.mockResolvedValue({ Contents: [], IsTruncated: false })
    const provider = new S3Provider(target)

    await provider.createDirectory('/reports/2027')

    const puts = sentOfType('PutObjectCommand')
    expect(puts).toHaveLength(1)
    expect(puts[0].input.Key).toBe('tenant-a/files/reports/2027/')
    expect(puts[0].input.Body).toEqual(new Uint8Array())
  })

  it('createDirectory は既存名衝突を弾き marker を書かない', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string }; input: { Prefix?: string } }) => {
      if (command.constructor.name === 'ListObjectsV2Command') {
        return { Contents: [{ Key: 'tenant-a/files/reports/dup' }] }
      }
      return {}
    })
    const provider = new S3Provider(target)

    await expect(provider.createDirectory('/reports/dup')).rejects.toThrow('already exists')
    expect(sentOfType('PutObjectCommand')).toHaveLength(0)
  })

  it('file rename は CopyObject 成功後に DeleteObject する', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string } }) =>
      command.constructor.name === 'ListObjectsV2Command' ? { Contents: [] } : {}
    )
    const provider = new S3Provider(target)

    await provider.rename('/reports/a.csv', '/reports/b.csv', 'file')

    const copies = sentOfType('CopyObjectCommand')
    expect(copies).toHaveLength(1)
    expect(copies[0].input.Key).toBe('tenant-a/files/reports/b.csv')
    expect(copies[0].input.CopySource).toBe('bucket-a/tenant-a/files/reports/a.csv')
    const deletes = sentOfType('DeleteObjectCommand')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].input.Key).toBe('tenant-a/files/reports/a.csv')
  })

  it('directory rename は全 copy 後に DeleteObjects(chunk) する', async () => {
    sendMock.mockImplementation(
      async (command: { constructor: { name: string }; input: { Prefix?: string; ContinuationToken?: string } }) => {
        if (command.constructor.name !== 'ListObjectsV2Command') return {}
        const prefix = command.input.Prefix ?? ''
        // dest 存在チェックは空。
        if (prefix.startsWith('tenant-a/files/archive')) return { Contents: [] }
        // source 配下を 2 ページで列挙。
        if (command.input.ContinuationToken === undefined) {
          return {
            Contents: [{ Key: 'tenant-a/files/reports/' }, { Key: 'tenant-a/files/reports/a.csv' }],
            IsTruncated: true,
            NextContinuationToken: 'p2',
          }
        }
        return { Contents: [{ Key: 'tenant-a/files/reports/sub/b.csv' }], IsTruncated: false }
      }
    )
    const provider = new S3Provider(target)

    await provider.rename('/reports', '/archive', 'directory')

    const copies = sentOfType('CopyObjectCommand')
    expect(copies.map((command) => command.input.Key)).toEqual([
      'tenant-a/files/archive/',
      'tenant-a/files/archive/a.csv',
      'tenant-a/files/archive/sub/b.csv',
    ])
    expect(copies[1].input.CopySource).toBe('bucket-a/tenant-a/files/reports/a.csv')
    const deletes = sentOfType('DeleteObjectsCommand')
    expect(deletes).toHaveLength(1)
    expect(
      (deletes[0].input.Delete as { Objects: Array<{ Key: string }> }).Objects.map((object) => object.Key)
    ).toEqual(['tenant-a/files/reports/', 'tenant-a/files/reports/a.csv', 'tenant-a/files/reports/sub/b.csv'])
  })

  it('directory rename は copy 失敗時に元を削除しない', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string }; input: { Prefix?: string } }) => {
      const name = command.constructor.name
      if (name === 'ListObjectsV2Command') {
        const prefix = command.input.Prefix ?? ''
        if (prefix.startsWith('tenant-a/files/archive')) return { Contents: [] }
        return { Contents: [{ Key: 'tenant-a/files/reports/a.csv' }], IsTruncated: false }
      }
      if (name === 'CopyObjectCommand') throw new Error('copy failed')
      return {}
    })
    const provider = new S3Provider(target)

    await expect(provider.rename('/reports', '/archive', 'directory')).rejects.toThrow('copy failed')
    expect(sentOfType('DeleteObjectsCommand')).toHaveLength(0)
  })

  it('directory rename は DeleteObjects が Errors を返したら明示エラー', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string }; input: { Prefix?: string } }) => {
      const name = command.constructor.name
      if (name === 'ListObjectsV2Command') {
        const prefix = command.input.Prefix ?? ''
        if (prefix.startsWith('tenant-a/files/archive')) return { Contents: [] }
        return { Contents: [{ Key: 'tenant-a/files/reports/a.csv' }], IsTruncated: false }
      }
      if (name === 'DeleteObjectsCommand') {
        // HTTP 200 でも個別失敗を Errors で返すケース。
        return { Errors: [{ Key: 'tenant-a/files/reports/a.csv', Code: 'AccessDenied' }] }
      }
      return {}
    })
    const provider = new S3Provider(target)

    await expect(provider.rename('/reports', '/archive', 'directory')).rejects.toThrow('AccessDenied')
  })

  it('directory rename は source が空（0件）なら明示エラー', async () => {
    // dest 存在チェックも source 列挙もすべて空。
    sendMock.mockImplementation(async (command: { constructor: { name: string } }) =>
      command.constructor.name === 'ListObjectsV2Command' ? { Contents: [], IsTruncated: false } : {}
    )
    const provider = new S3Provider(target)

    await expect(provider.rename('/missing', '/archive', 'directory')).rejects.toThrow('not found')
    expect(sentOfType('CopyObjectCommand')).toHaveLength(0)
    expect(sentOfType('DeleteObjectsCommand')).toHaveLength(0)
  })

  it('deleteDirectory は prefix 配下を列挙して DeleteObjects する', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string } }) =>
      command.constructor.name === 'ListObjectsV2Command'
        ? {
            Contents: [{ Key: 'tenant-a/files/reports/' }, { Key: 'tenant-a/files/reports/a.csv' }],
            IsTruncated: false,
          }
        : {}
    )
    const provider = new S3Provider(target)

    await provider.deleteDirectory('/reports')

    const deletes = sentOfType('DeleteObjectsCommand')
    expect(deletes).toHaveLength(1)
    expect((deletes[0].input.Delete as { Objects: Array<{ Key: string }> }).Objects.map((o) => o.Key)).toEqual([
      'tenant-a/files/reports/',
      'tenant-a/files/reports/a.csv',
    ])
  })

  it('deleteDirectory は空（0件）なら明示エラー', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string } }) =>
      command.constructor.name === 'ListObjectsV2Command' ? { Contents: [] } : {}
    )
    const provider = new S3Provider(target)

    await expect(provider.deleteDirectory('/missing')).rejects.toThrow('not found')
    expect(sentOfType('DeleteObjectsCommand')).toHaveLength(0)
  })

  it('copyFile は CopyObject を送る（元は残す）', async () => {
    sendMock.mockResolvedValue({})
    const provider = new S3Provider(target)

    await provider.copyFile('/reports/a.csv', '/reports/a copy.csv')

    const copies = sentOfType('CopyObjectCommand')
    expect(copies).toHaveLength(1)
    expect(copies[0].input.Key).toBe('tenant-a/files/reports/a copy.csv')
    expect(copies[0].input.CopySource).toBe('bucket-a/tenant-a/files/reports/a.csv')
    expect(sentOfType('DeleteObjectCommand')).toHaveLength(0)
  })
})
