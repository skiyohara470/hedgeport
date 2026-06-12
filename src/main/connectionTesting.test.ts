import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  sendMock,
  destroyMock,
  connectMock,
  listMock,
  endMock,
} = vi.hoisted(() => ({
  sendMock: vi.fn(),
  destroyMock: vi.fn(),
  connectMock: vi.fn(),
  listMock: vi.fn(),
  endMock: vi.fn(),
}))

vi.mock('@aws-sdk/client-s3', () => {
  class ListBucketsCommand {
    constructor(public readonly input: unknown) {}
  }

  class GetBucketLocationCommand {
    constructor(public readonly input: unknown) {}
  }

  class HeadBucketCommand {
    constructor(public readonly input: unknown) {}
  }

  class S3Client {
    send = sendMock
    destroy = destroyMock
  }

  return {
    GetBucketLocationCommand,
    HeadBucketCommand,
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

import { listS3Buckets, testConnection } from './connectionTesting'

describe('connectionTesting input validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    destroyMock.mockReturnValue(undefined)
    connectMock.mockResolvedValue(undefined)
    listMock.mockResolvedValue([])
    endMock.mockResolvedValue(undefined)
  })

  it('listS3Buckets は不正な S3 認証入力を拒否する', async () => {
    await expect(
      listS3Buckets({
        region: 'ap-northeast-1',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 123 as unknown as string,
      })
    ).rejects.toThrow('Invalid S3 credentials.')
  })

  it('testConnection は不正な SFTP 設定を失敗結果で返す', async () => {
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
    ).resolves.toEqual({
      ok: false,
      message: 'Invalid connection settings.',
    })
  })

  it('testConnection は不正な S3 設定を失敗結果で返す', async () => {
    await expect(
      testConnection({
        id: 's3-1',
        name: 'Broken S3',
        kind: 's3',
        region: 'ap-northeast-1',
        bucket: 'bucket-a',
        prefix: 'daily',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
      } as unknown as Parameters<typeof testConnection>[0])
    ).resolves.toEqual({
      ok: false,
      message: 'Invalid connection settings.',
    })
  })

  it('listS3Buckets は同一リージョンの bucket だけを名前順で返す', async () => {
    sendMock.mockImplementation(async (command: { input: { Bucket?: string } }) => {
      if (!('Bucket' in command.input)) {
        return {
          Buckets: [{ Name: 'z-bucket' }, { Name: 'eu-bucket' }, { Name: 'a-bucket' }],
        }
      }

      if (command.input.Bucket === 'z-bucket') return { LocationConstraint: 'ap-northeast-1' }
      if (command.input.Bucket === 'eu-bucket') return { LocationConstraint: 'EU' }
      return { LocationConstraint: undefined }
    })

    await expect(
      listS3Buckets({
        region: 'ap-northeast-1',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: '',
      })
    ).resolves.toEqual(['z-bucket'])

    expect(destroyMock).toHaveBeenCalledTimes(1)
  })

  it('testConnection は SFTP 接続成功時に成功結果を返す', async () => {
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
    ).resolves.toEqual({
      ok: true,
      message: 'Connected to example.com:22.',
    })

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

  it('testConnection は S3 接続成功時に成功結果を返す', async () => {
    sendMock.mockResolvedValue({})

    await expect(
      testConnection({
        id: 's3-1',
        name: 'S3',
        kind: 's3',
        region: 'ap-northeast-1',
        bucket: 'bucket-a',
        prefix: 'daily',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: '',
      })
    ).resolves.toEqual({
      ok: true,
      message: 'Connected to s3://bucket-a.',
    })

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(destroyMock).toHaveBeenCalledTimes(1)
  })
})