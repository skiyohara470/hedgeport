import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

import type { S3ConnectionTarget } from '../../shared/connections'
import type { StorageEntry } from '../../shared/storage'
import type { StorageProvider } from './StorageProvider'
import { joinVirtualPath, normalizeS3Prefix, normalizeVirtualPath, s3KeyForPath } from './pathUtils'

export class S3Provider implements StorageProvider {
  constructor(private readonly target: S3ConnectionTarget) {}

  /**
   * 認証情報を接続設定から毎回組み立てる。
   * Electron main に長寿命クライアントを持たせず、使い終わったら破棄する。
   */
  private createClient(): S3Client {
    return new S3Client({
      region: this.target.region,
      credentials: {
        accessKeyId: this.target.accessKeyId,
        secretAccessKey: this.target.secretAccessKey,
        ...(this.target.sessionToken ? { sessionToken: this.target.sessionToken } : {}),
      },
      requestHandler: {
        requestTimeout: 10_000,
        connectionTimeout: 10_000,
      },
    })
  }

  private async withClient<T>(operation: (client: S3Client) => Promise<T>): Promise<T> {
    const client = this.createClient()
    try {
      return await operation(client)
    } finally {
      client.destroy()
    }
  }

  async list(path: string): Promise<StorageEntry[]> {
    const virtualPath = normalizeVirtualPath(path)
    const baseKey = s3KeyForPath(this.target.prefix, virtualPath)
    const prefix = baseKey ? `${baseKey.replace(/\/+$/, '')}/` : ''
    const configuredPrefix = normalizeS3Prefix(this.target.prefix)
    const entries = await this.withClient(async (client) => {
      const directories = new Map<string, StorageEntry>()
      const files = new Map<string, StorageEntry>()
      let continuationToken: string | undefined

      do {
        // Delimiter='/' を使って、object key を疑似ディレクトリ単位で 1 階層だけ見る。
        const output = await client.send(
          new ListObjectsV2Command({
            Bucket: this.target.bucket,
            Prefix: prefix,
            Delimiter: '/',
            ContinuationToken: continuationToken,
          })
        )

        for (const commonPrefix of output.CommonPrefixes ?? []) {
          if (!commonPrefix.Prefix) continue
          const name = commonPrefix.Prefix.slice(prefix.length).replace(/\/$/, '')
          if (name) directories.set(name, { name, path: joinVirtualPath(virtualPath, name), type: 'directory' })
        }
        for (const object of output.Contents ?? []) {
          // 自分自身の prefix marker や配下の深いキーはここでは表示しない。
          if (!object.Key || object.Key === prefix || object.Key === `${configuredPrefix}/`) continue
          const name = object.Key.slice(prefix.length)
          if (!name || name.includes('/')) continue
          files.set(name, {
            name,
            path: joinVirtualPath(virtualPath, name),
            type: 'file',
            size: object.Size,
            modifiedAt: object.LastModified?.toISOString(),
          })
        }

        continuationToken = output.IsTruncated ? output.NextContinuationToken : undefined
      } while (continuationToken)

      return [...directories.values(), ...files.values()]
    })

    return entries.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name)
    })
  }

  async read(path: string): Promise<Uint8Array> {
    return this.withClient(async (client) => {
      const output = await client.send(
        new GetObjectCommand({
          Bucket: this.target.bucket,
          Key: s3KeyForPath(this.target.prefix, path),
        })
      )
      if (!output.Body) throw new Error('S3 object has no body.')
      // AWS SDK v3 の stream helper で renderer に渡しやすい Uint8Array へ揃える。
      return output.Body.transformToByteArray()
    })
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    await this.withClient(async (client) => {
      await client.send(
        new PutObjectCommand({
          Bucket: this.target.bucket,
          Key: s3KeyForPath(this.target.prefix, path),
          Body: data,
        })
      )
    })
  }

  async delete(path: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.send(
        new DeleteObjectCommand({
          Bucket: this.target.bucket,
          Key: s3KeyForPath(this.target.prefix, path),
        })
      )
    })
  }
}
