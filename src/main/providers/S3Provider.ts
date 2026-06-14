import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketLocationCommand,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

import type { S3ConnectionTarget } from '../../shared/connections'
import type { StorageEntry, StorageEntryType } from '../../shared/storage'
import type { StorageProvider } from './StorageProvider'
import { joinVirtualPath, normalizeVirtualPath, parseS3VirtualPath } from './pathUtils'

/**
 * S3 の CopySource 用に `bucket/key` を URL エンコードする。
 * key 内のスラッシュは区切りとして保持し、各セグメントだけをエンコードする（AWS 仕様）。
 */
export function encodeCopySource(bucket: string, key: string): string {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/')
  return `${bucket}/${encodedKey}`
}

/**
 * GetBucketLocation の LocationConstraint を通常のリージョン名へ正規化する。
 * 空（null）は us-east-1、'EU' は eu-west-1 を表す（S3 の歴史的仕様）。
 */
export function normalizeBucketRegion(location: string | undefined): string {
  if (!location) return 'us-east-1'
  if (location === 'EU') return 'eu-west-1'
  return location
}

/**
 * アカウントの bucket を pagination 込みで列挙し、実リージョンが指定 region のものだけ返す。
 * ListBuckets はリージョンを返さないため、各 bucket の GetBucketLocation で実リージョンを解決する。
 *
 * @param client S3 クライアント
 * @param region 絞り込み対象のリージョン
 * @returns region に一致する bucket 名（昇順）
 */
export async function listRegionBuckets(client: S3Client, region: string): Promise<string[]> {
  const names: string[] = []
  let continuationToken: string | undefined
  do {
    const output = await client.send(new ListBucketsCommand({ ContinuationToken: continuationToken }))
    for (const { Name } of output.Buckets ?? []) if (Name) names.push(Name)
    continuationToken = output.ContinuationToken ?? undefined
  } while (continuationToken)

  const located = await Promise.all(
    names.map((name) =>
      client.send(new GetBucketLocationCommand({ Bucket: name })).then(({ LocationConstraint }) => ({
        name,
        region: normalizeBucketRegion(LocationConstraint),
      }))
    )
  )
  return located
    .filter((bucket) => bucket.region === region)
    .map((bucket) => bucket.name)
    .sort((left, right) => left.localeCompare(right))
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

  /**
   * 仮想パスから bucket と object key を取り出す。
   * file/object 操作で必須の bucket・key を欠く場合（ルート / bare bucket）は明示エラーにする。
   *
   * @param path 仮想パス
   * @param requireKey object 操作で key 必須なら true（bucket ルートを弾く）
   * @returns bucket と key
   * @throws ルート / key 不在の場合
   */
  private requireBucketAndKey(path: string, requireKey: boolean): { bucket: string; key: string } {
    const { bucket, key } = parseS3VirtualPath(path)
    if (!bucket) throw new Error('Operation requires a bucket path.')
    if (requireKey && !key) throw new Error('Operation is not allowed on a bucket root.')
    return { bucket, key }
  }

  async list(path: string): Promise<StorageEntry[]> {
    const virtualPath = normalizeVirtualPath(path)
    const { bucket } = parseS3VirtualPath(virtualPath)
    // ルートは bucket 一覧をディレクトリエントリとして返す。
    if (!bucket) return this.listBuckets(virtualPath)
    return this.listObjects(virtualPath, bucket)
  }

  /**
   * ルート `/` で region 内の accessible bucket をディレクトリエントリとして列挙する。
   */
  private async listBuckets(virtualPath: string): Promise<StorageEntry[]> {
    const names = await this.withClient((client) => listRegionBuckets(client, this.target.region))
    return names.map((name) => ({ name, path: joinVirtualPath(virtualPath, name), type: 'directory' as const }))
  }

  /**
   * `/<bucket>/<key...>` 配下を Delimiter='/' で 1 階層だけ列挙する。
   */
  private async listObjects(virtualPath: string, bucket: string): Promise<StorageEntry[]> {
    const { key } = parseS3VirtualPath(virtualPath)
    const prefix = key ? `${key.replace(/\/+$/, '')}/` : ''
    const entries = await this.withClient(async (client) => {
      const directories = new Map<string, StorageEntry>()
      const files = new Map<string, StorageEntry>()
      let continuationToken: string | undefined

      do {
        // Delimiter='/' を使って、object key を疑似ディレクトリ単位で 1 階層だけ見る。
        const output = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
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
          if (!object.Key || object.Key === prefix) continue
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
    const { bucket, key } = this.requireBucketAndKey(path, true)
    return this.withClient(async (client) => {
      const output = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      if (!output.Body) throw new Error('S3 object has no body.')
      // AWS SDK v3 の stream helper で renderer に渡しやすい Uint8Array へ揃える。
      return output.Body.transformToByteArray()
    })
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const { bucket, key } = this.requireBucketAndKey(path, true)
    await this.withClient(async (client) => {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data }))
    })
  }

  async delete(path: string): Promise<void> {
    const { bucket, key } = this.requireBucketAndKey(path, true)
    await this.withClient(async (client) => {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    })
  }

  /**
   * 指定 key の object がちょうど存在するか（前方一致でなく完全一致）。
   */
  private async objectExists(client: S3Client, bucket: string, key: string): Promise<boolean> {
    const output = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 }))
    return (output.Contents ?? []).some((object) => object.Key === key)
  }

  /**
   * 指定 prefix 配下に object が 1 件でもあるか。
   */
  private async anyUnderPrefix(client: S3Client, bucket: string, prefix: string): Promise<boolean> {
    const output = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 }))
    return (output.Contents ?? []).length > 0
  }

  /**
   * 名前衝突（ファイル key・ディレクトリ marker 配下のいずれか）を検出する。
   */
  private async existsAny(client: S3Client, bucket: string, key: string): Promise<boolean> {
    if (await this.objectExists(client, bucket, key)) return true
    return this.anyUnderPrefix(client, bucket, `${key}/`)
  }

  async createDirectory(path: string): Promise<void> {
    const { bucket, key } = this.requireBucketAndKey(path, true)
    const markerKey = `${key}/`
    await this.withClient(async (client) => {
      if (await this.existsAny(client, bucket, key)) {
        throw new Error('A file or directory with that name already exists.')
      }
      // S3 に実ディレクトリは無いので、末尾スラッシュの空 object を marker として置く。
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: markerKey, Body: new Uint8Array() }))
    })
  }

  async rename(sourcePath: string, destinationPath: string, entryType: StorageEntryType): Promise<void> {
    const source = this.requireBucketAndKey(sourcePath, true)
    const destination = this.requireBucketAndKey(destinationPath, true)
    await this.withClient(async (client) => {
      if (await this.existsAny(client, destination.bucket, destination.key)) {
        throw new Error('A file or directory with that name already exists.')
      }
      if (entryType === 'file') {
        await this.renameFile(client, source, destination)
        return
      }
      await this.renameDirectory(client, source, destination)
    })
  }

  /**
   * 単一 object の rename / move。CopyObject 成功後に元を DeleteObject する。
   * 別 bucket 間でも CopySource に source bucket を指定して安全に移動する。
   */
  private async renameFile(
    client: S3Client,
    source: { bucket: string; key: string },
    destination: { bucket: string; key: string }
  ): Promise<void> {
    await client.send(
      new CopyObjectCommand({
        Bucket: destination.bucket,
        Key: destination.key,
        CopySource: encodeCopySource(source.bucket, source.key),
      })
    )
    await client.send(new DeleteObjectCommand({ Bucket: source.bucket, Key: source.key }))
  }

  /**
   * prefix 配下を丸ごと rename / move する。
   * 全 copy が成功してから元を 1000 件ずつ削除する。copy 失敗時は元を消さない（データ消失防止）。
   * 別 bucket 間でも source bucket を CopySource に指定して移動する。
   */
  private async renameDirectory(
    client: S3Client,
    source: { bucket: string; key: string },
    destination: { bucket: string; key: string }
  ): Promise<void> {
    const sourcePrefix = `${source.key}/`
    const destinationPrefix = `${destination.key}/`

    const keys = await this.listKeysUnderPrefix(client, source.bucket, sourcePrefix)
    // marker が無くても配下 object があれば rename 可。0 件なら source 不在として明示エラー。
    if (keys.length === 0) throw new Error('Source directory not found.')

    // 全 copy を先に完了させる（途中失敗時はここで throw し、元は未削除のまま）。
    for (const key of keys) {
      const destinationKey = destinationPrefix + key.slice(sourcePrefix.length)
      await client.send(
        new CopyObjectCommand({
          Bucket: destination.bucket,
          Key: destinationKey,
          CopySource: encodeCopySource(source.bucket, key),
        })
      )
    }

    // 全 copy 成功後に元を削除する。
    await this.deleteKeys(client, source.bucket, keys)
  }

  async deleteDirectory(path: string): Promise<void> {
    const { bucket, key } = this.requireBucketAndKey(path, true)
    await this.withClient(async (client) => {
      const prefix = `${key}/`
      const keys = await this.listKeysUnderPrefix(client, bucket, prefix)
      if (keys.length === 0) throw new Error('Directory not found.')
      await this.deleteKeys(client, bucket, keys)
    })
  }

  async copyFile(sourcePath: string, destinationPath: string): Promise<void> {
    const source = this.requireBucketAndKey(sourcePath, true)
    const destination = this.requireBucketAndKey(destinationPath, true)
    await this.withClient(async (client) => {
      await client.send(
        new CopyObjectCommand({
          Bucket: destination.bucket,
          Key: destination.key,
          CopySource: encodeCopySource(source.bucket, source.key),
        })
      )
    })
  }

  /**
   * prefix 配下の object key を pagination で全列挙する。
   */
  private async listKeysUnderPrefix(client: S3Client, bucket: string, prefix: string): Promise<string[]> {
    const keys: string[] = []
    let continuationToken: string | undefined
    do {
      const output = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken })
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
  private async deleteKeys(client: S3Client, bucket: string, keys: string[]): Promise<void> {
    for (let index = 0; index < keys.length; index += DELETE_CHUNK_SIZE) {
      const chunk = keys.slice(index, index + DELETE_CHUNK_SIZE)
      const result = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
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
