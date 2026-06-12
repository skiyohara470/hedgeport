// 接続先（SFTP / S3 など）を抽象化したストレージ操作契約。
// 具体実装（SftpProvider / S3Provider）は本ファイルに置かず、別タスクで追加する。

import type { StorageEntry } from '../../shared/storage'

export type { StorageEntry } from '../../shared/storage'

/**
 * 接続先ストレージに対する共通操作の契約。
 * 戻り値のバイト列は Uint8Array、異常系は例外を throw する（Fail Fast）。
 */
export interface StorageProvider {
  /**
   * 指定ディレクトリ直下のエントリを列挙する。
   * @param path 列挙対象のディレクトリパス
   * @returns 直下のエントリ一覧（空なら空配列）
   */
  list(path: string): Promise<StorageEntry[]>

  /**
   * 指定パスのファイル内容を読み出す。
   * @param path 読み出すファイルパス
   * @returns ファイルのバイト列
   * @throws パスが存在しない場合
   */
  read(path: string): Promise<Uint8Array>

  /**
   * 指定パスへバイト列を書き込む（既存は上書き）。
   * @param path 書き込み先パス
   * @param data 書き込むバイト列
   */
  write(path: string, data: Uint8Array): Promise<void>

  /**
   * 指定パスのファイルを削除する。
   * @param path 削除するファイルパス
   * @throws パスが存在しない場合
   */
  delete(path: string): Promise<void>
}
