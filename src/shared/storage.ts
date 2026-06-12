/**
 * main / renderer 間で共有するファイル一覧エントリ契約。
 * SFTP / S3 / ローカルの違いは吸収し、UI が同じ形で扱えるようにする。
 */
export interface StorageEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modifiedAt?: string
}
