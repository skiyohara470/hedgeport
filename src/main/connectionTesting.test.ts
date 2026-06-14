import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sendMock, destroyMock, connectMock, listMock, endMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  destroyMock: vi.fn(),
  connectMock: vi.fn(),
  listMock: vi.fn(),
  endMock: vi.fn(),
}))

vi.mock('@aws-sdk/client-s3', () => {
  class ListBucketsCommand {
    constructor(public readonly input: { ContinuationToken?: string }) {}
  }

  class GetBucketLocationCommand {
    constructor(public readonly input: { Bucket: string }) {}
  }

  class S3Client {
    send = sendMock
    destroy = destroyMock
  }

  return {
    GetBucketLocationCommand,
    ListBucketsCommand,
    S3Client,
  }
})

vi.mock('ssh2-sftp-client', () => ({
  default: class SftpClient {
    connect = connectMock
    list = listMock
    end = endMock
  },
}))

import { testConnection } from './connectionTesting'

describe('testConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    destroyMock.mockReturnValue(undefined)
    connectMock.mockResolvedValue(undefined)
    listMock.mockResolvedValue([])
    endMock.mockResolvedValue(undefined)
  })

  it('不正な SFTP 設定を失敗結果で返す', async () => {
    await expect(
      testConnection({
        id: 'sftp-1',
        name: 'Broken SFTP',
        kind: 'sftp',
        host: 'example.com',
        username: 'alice',
        password: 'secret',
        rootPath: '/exports',
      } as unknown as Parameters<typeof testConnection>[0])
    ).resolves.toEqual({ ok: false, message: 'Invalid connection settings.' })
  })

  it('不正な S3 設定（sessionToken 欠落）を失敗結果で返す', async () => {
    await expect(
      testConnection({
        id: 's3-1',
        name: 'Broken S3',
        kind: 's3',
        region: 'ap-northeast-1',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
      } as unknown as Parameters<typeof testConnection>[0])
    ).resolves.toEqual({ ok: false, message: 'Invalid connection settings.' })
  })

  it('SFTP 接続成功時に成功結果を返す', async () => {
    await expect(
      testConnection({
        id: 'sftp-1',
        name: 'SFTP',
        kind: 'sftp',
        host: 'example.com',
        port: 22,
        username: 'alice',
        password: 'secret',
        rootPath: '/exports',
      })
    ).resolves.toEqual({ ok: true, message: 'Connected to example.com:22.' })

    expect(connectMock).toHaveBeenCalledWith({
      host: 'example.com',
      port: 22,
      username: 'alice',
      password: 'secret',
      readyTimeout: 10_000,
    })
    expect(listMock).toHaveBeenCalledWith('/exports')
    expect(endMock).toHaveBeenCalledTimes(1)
  })

  it('S3 は ListBuckets + region 解決で成功し、region 内 bucket 数を報告する', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string }; input: { Bucket?: string } }) => {
      if (command.constructor.name === 'ListBucketsCommand') {
        return { Buckets: [{ Name: 'a-bucket' }, { Name: 'eu-bucket' }, { Name: 'z-bucket' }] }
      }
      // a / z は設定 region に一致、eu は別 region。
      if (command.input.Bucket === 'eu-bucket') return { LocationConstraint: 'EU' }
      return { LocationConstraint: 'ap-northeast-1' }
    })

    await expect(
      testConnection({
        id: 's3-1',
        name: 'S3',
        kind: 's3',
        region: 'ap-northeast-1',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: '',
      })
    ).resolves.toEqual({ ok: true, message: 'Connected to S3 (ap-northeast-1): 2 accessible bucket(s).' })

    expect(destroyMock).toHaveBeenCalledTimes(1)
  })

  it('S3 の権限エラーは失敗結果として surface する', async () => {
    sendMock.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'ListBucketsCommand') throw new Error('AccessDenied')
      return {}
    })

    await expect(
      testConnection({
        id: 's3-1',
        name: 'S3',
        kind: 's3',
        region: 'ap-northeast-1',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: '',
      })
    ).resolves.toEqual({ ok: false, message: 'AccessDenied' })
    expect(destroyMock).toHaveBeenCalledTimes(1)
  })
})
