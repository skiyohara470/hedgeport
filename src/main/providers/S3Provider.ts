import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

import type { S3ConnectionTarget } from '../../shared/connections'
import type { StorageEntry, StorageEntryType } from '../../shared/storage'
import type { StorageProvider } from './StorageProvider'
import { joinVirtualPath, normalizeS3Prefix, normalizeVirtualPath, s3KeyForPath } from './pathUtils'

/**
 * S3 の CopySource 用に `bucket/key` を URL エンコードする。
 * key 内のスラッシュは区切りとして保持し、各セグメントだけをエンコードする（AWS 仕様）。
 */
export function encodeCopySource(bucket: string, key: string): string {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/')
  return `${bucket}/${encodedKey}`
}

const DELETE_CHUNK_SIZE = 1000

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

  /**
   * 指定 key の object がちょうど存在するか（前方一致でなく完全一致）。
   */
  private async objectExists(client: S3Client, key: string): Promise<boolean> {
    const output = await client.send(new ListObjectsV2Command({ Bucket: this.target.bucket, Prefix: key, MaxKeys: 1 }))
    return (output.Contents ?? []).some((object) => object.Key === key)
  }

  /**
   * 指定 prefix 配下に object が 1 件でもあるか。
   */
  private async anyUnderPrefix(client: S3Client, prefix: string): Promise<boolean> {
    const output = await client.send(
      new ListObjectsV2Command({ Bucket: this.target.bucket, Prefix: prefix, MaxKeys: 1 })
    )
    return (output.Contents ?? []).length > 0
  }

  /**
   * 名前衝突（ファイル key・ディレクトリ marker 配下のいずれか）を検出する。
   */
  private async existsAny(client: S3Client, path: string): Promise<boolean> {
    const fileKey = s3KeyForPath(this.target.prefix, path)
    if (await this.objectExists(client, fileKey)) return true
    return this.anyUnderPrefix(client, `${fileKey}/`)
  }

  async createDirectory(path: string): Promise<void> {
    const markerKey = `${s3KeyForPath(this.target.prefix, path)}/`
    await this.withClient(async (client) => {
      if (await this.existsAny(client, path)) {
        throw new Error('A file or directory with that name already exists.')
      }
      // S3 に実ディレクトリは無いので、末尾スラッシュの空 object を marker として置く。
      await client.send(new PutObjectCommand({ Bucket: this.target.bucket, Key: markerKey, Body: new Uint8Array() }))
    })
  }

  async rename(sourcePath: string, destinationPath: string, entryType: StorageEntryType): Promise<void> {
    await this.withClient(async (client) => {
      if (await this.existsAny(client, destinationPath)) {
        throw new Error('A file or directory with that name already exists.')
      }
      if (entryType === 'file') {
        await this.renameFile(client, sourcePath, destinationPath)
        return
      }
      await this.renameDirectory(client, sourcePath, destinationPath)
    })
  }

  /**
   * 単一 object の rename。CopyObject 成功後に元を DeleteObject する。
   */
  private async renameFile(client: S3Client, sourcePath: string, destinationPath: string): Promise<void> {
    const sourceKey = s3KeyForPath(this.target.prefix, sourcePath)
    const destinationKey = s3KeyForPath(this.target.prefix, destinationPath)
    await client.send(
      new CopyObjectCommand({
        Bucket: this.target.bucket,
        Key: destinationKey,
        CopySource: encodeCopySource(this.target.bucket, sourceKey),
      })
    )
    await client.send(new DeleteObjectCommand({ Bucket: this.target.bucket, Key: sourceKey }))
  }

  /**
   * prefix 配下を丸ごと rename する。
   * 全 copy が成功してから元を 1000 件ずつ削除する。copy 失敗時は元を消さない（データ消失防止）。
   */
  private async renameDirectory(client: S3Client, sourcePath: string, destinationPath: string): Promise<void> {
    const sourcePrefix = `${s3KeyForPath(this.target.prefix, sourcePath)}/`
    const destinationPrefix = `${s3KeyForPath(this.target.prefix, destinationPath)}/`

    const keys = await this.listKeysUnderPrefix(client, sourcePrefix)
    // marker が無くても配下 object があれば rename 可。0 件なら source 不在として明示エラー。
    if (keys.length === 0) throw new Error('Source directory not found.')

    // 全 copy を先に完了させる（途中失敗時はここで throw し、元は未削除のまま）。
    for (const key of keys) {
      const destinationKey = destinationPrefix + key.slice(sourcePrefix.length)
      await client.send(
        new CopyObjectCommand({
          Bucket: this.target.bucket,
          Key: destinationKey,
          CopySource: encodeCopySource(this.target.bucket, key),
        })
      )
    }

    // 全 copy 成功後に元を削除する。
    await this.deleteKeys(client, keys)
  }

  async deleteDirectory(path: string): Promise<void> {
    await this.withClient(async (client) => {
      const prefix = `${s3KeyForPath(this.target.prefix, path)}/`
      const keys = await this.listKeysUnderPrefix(client, prefix)
      if (keys.length === 0) throw new Error('Directory not found.')
      await this.deleteKeys(client, keys)
    })
  }

  async copyFile(sourcePath: string, destinationPath: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.send(
        new CopyObjectCommand({
          Bucket: this.target.bucket,
          Key: s3KeyForPath(this.target.prefix, destinationPath),
          CopySource: encodeCopySource(this.target.bucket, s3KeyForPath(this.target.prefix, sourcePath)),
        })
      )
    })
  }

  /**
   * prefix 配下の object key を pagination で全列挙する。
   */
  private async listKeysUnderPrefix(client: S3Client, prefix: string): Promise<string[]> {
    const keys: string[] = []
    let continuationToken: string | undefined
    do {
      const output = await client.send(
        new ListObjectsV2Command({ Bucket: this.target.bucket, Prefix: prefix, ContinuationToken: continuationToken })
      )
      for (const object of output.Contents ?? []) if (object.Key) keys.push(object.Key)
      continuationToken = output.IsTruncated ? output.NextContinuationToken : undefined
    } while (continuationToken)
    return keys
  }

  /**
   * key 群を 1000 件チャンクで削除する。
   * DeleteObjects は HTTP 200 でも個別失敗を Errors で返すため、1 件でもあれば明示エラーにする。
   */
  private async deleteKeys(client: S3Client, keys: string[]): Promise<void> {
    for (let index = 0; index < keys.length; index += DELETE_CHUNK_SIZE) {
      const chunk = keys.slice(index, index + DELETE_CHUNK_SIZE)
      const result = await client.send(
        new DeleteObjectsCommand({
          Bucket: this.target.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })) },
        })
      )
      const errors = result.Errors ?? []
      if (errors.length > 0) {
        const first = errors[0]
        throw new Error(
          `Failed to delete ${errors.length} object(s) (e.g. ${first.Key ?? '?'}: ${first.Code ?? 'Unknown'}). Please retry or verify manually.`
        )
      }
    }
  }
}
