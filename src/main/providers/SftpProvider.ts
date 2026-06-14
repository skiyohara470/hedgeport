import SftpClient from 'ssh2-sftp-client'

import type { SftpConnectionTarget } from '../../shared/connections'
import type { StorageEntry, StorageEntryType } from '../../shared/storage'
import type { StorageProvider } from './StorageProvider'
import { joinSftpPath, joinVirtualPath, normalizeVirtualPath } from './pathUtils'

/**
 * ssh2-sftp-client が返す更新時刻はサーバーによって秒/ミリ秒が揺れるので両対応にする。
 */
export function sftpTimestampToIso(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp
  return new Date(milliseconds).toISOString()
}

export class SftpProvider implements StorageProvider {
  constructor(private readonly target: SftpConnectionTarget) {}

  /**
   * 操作ごとに短命な接続を張る。
   * 状態を持つ接続を共有しないことで、IPC をまたぐ並列利用でも扱いを単純にする。
   */
  private async withClient<T>(operation: (client: SftpClient) => Promise<T>): Promise<T> {
    const client = new SftpClient(`hedgeport-${this.target.id}`)
    try {
      await client.connect({
        host: this.target.host,
        port: this.target.port,
        username: this.target.username,
        password: this.target.password || undefined,
        readyTimeout: 10_000,
      })
      return await operation(client)
    } finally {
      await client.end().catch(() => undefined)
    }
  }

  async list(path: string): Promise<StorageEntry[]> {
    const virtualPath = normalizeVirtualPath(path)
    const entries = await this.withClient((client) => client.list(joinSftpPath(this.target.rootPath, virtualPath)))
    return (
      entries
        // UI ではディレクトリとファイルだけ扱う。リンクはファイル相当として見せる。
        .filter((entry) => entry.type === 'd' || entry.type === '-' || entry.type === 'l')
        .map((entry) => ({
          name: entry.name,
          path: joinVirtualPath(virtualPath, entry.name),
          type: entry.type === 'd' ? ('directory' as const) : ('file' as const),
          ...(entry.type !== 'd' ? { size: entry.size } : {}),
          ...(sftpTimestampToIso(entry.modifyTime) ? { modifiedAt: sftpTimestampToIso(entry.modifyTime) } : {}),
        }))
        .sort((left, right) => {
          if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
          return left.name.localeCompare(right.name)
        })
    )
  }

  async read(path: string): Promise<Uint8Array> {
    const data = await this.withClient((client) => client.get(joinSftpPath(this.target.rootPath, path)))
    if (!Buffer.isBuffer(data)) throw new Error('SFTP read did not return a buffer.')
    return new Uint8Array(data)
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    await this.withClient(async (client) => {
      // parent directory の自動作成はしない。存在前提で put する。
      await client.put(Buffer.from(data), joinSftpPath(this.target.rootPath, path))
    })
  }

  async delete(path: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.delete(joinSftpPath(this.target.rootPath, path))
    })
  }

  async createDirectory(path: string): Promise<void> {
    const actual = joinSftpPath(this.target.rootPath, path)
    await this.withClient(async (client) => {
      // 既存名は上書き / マージせず明示エラーにする。
      if (await client.exists(actual)) throw new Error('A file or directory with that name already exists.')
      await client.mkdir(actual, false)
    })
  }

  // SFTP の rename はファイル / ディレクトリ共通で扱えるため entryType は使わない。
  async rename(sourcePath: string, destinationPath: string, _entryType: StorageEntryType): Promise<void> {
    const sourceActual = joinSftpPath(this.target.rootPath, sourcePath)
    const destinationActual = joinSftpPath(this.target.rootPath, destinationPath)
    await this.withClient(async (client) => {
      if (await client.exists(destinationActual)) {
        throw new Error('A file or directory with that name already exists.')
      }
      await client.rename(sourceActual, destinationActual)
    })
  }

  async deleteDirectory(path: string): Promise<void> {
    const actual = joinSftpPath(this.target.rootPath, path)
    // 非再帰削除。非空ディレクトリは ssh2-sftp-client がエラーを投げる（安全側）。
    await this.withClient((client) => client.rmdir(actual, false))
  }

  async copyFile(sourcePath: string, destinationPath: string): Promise<void> {
    // SFTP にサーバーサイド copy は無いので、同一接続内で get→put する。
    await this.withClient(async (client) => {
      const data = await client.get(joinSftpPath(this.target.rootPath, sourcePath))
      if (!Buffer.isBuffer(data)) throw new Error('SFTP read did not return a buffer.')
      await client.put(data, joinSftpPath(this.target.rootPath, destinationPath))
    })
  }
}
