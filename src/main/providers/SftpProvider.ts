import SftpClient from 'ssh2-sftp-client'

import type { SftpConnectionTarget } from '../../shared/connections'
import type { StorageEntry } from '../../shared/storage'
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
    return entries
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
}
