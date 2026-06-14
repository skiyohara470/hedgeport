/**
 * エントリ種別。ファイルとディレクトリの 2 種のみ扱う。
 */
export type StorageEntryType = 'file' | 'directory'

/**
 * main / renderer 間で共有するファイル一覧エントリ契約。
 * SFTP / S3 / ローカルの違いは吸収し、UI が同じ形で扱えるようにする。
 */
export interface StorageEntry {
  name: string
  path: string
  type: StorageEntryType
  size?: number
  modifiedAt?: string
}
