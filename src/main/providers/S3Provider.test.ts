import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sendMock, destroyMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  destroyMock: vi.fn(),
}))

vi.mock('@aws-sdk/client-s3', () => {
  class DeleteObjectCommand {
    constructor(public readonly input: unknown) {}
  }

  class GetObjectCommand {
    constructor(public readonly input: unknown) {}
  }

  class ListObjectsV2Command {
    constructor(public readonly input: unknown) {}
  }

  class PutObjectCommand {
    constructor(public readonly input: unknown) {}
  }

  class S3Client {
    send = sendMock
    destroy = destroyMock
  }

  return {
    DeleteObjectCommand,
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
        CommonPrefixes: [
          { Prefix: 'tenant-a/files/reports/' },
          { Prefix: 'tenant-a/files/archive/' },
        ],
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
        Contents: [
          { Key: 'tenant-a/files/alpha.csv', Size: 3, LastModified: new Date('2024-05-01T00:00:00.000Z') },
        ],
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
})