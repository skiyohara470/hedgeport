// 接続先（SFTP / S3 など）を抽象化したストレージ操作契約。
// 具体実装（SftpProvider / S3Provider）は本ファイルに置かず、別タスクで追加する。

import type { StorageEntry, StorageEntryType } from '../../shared/storage'

export type { StorageEntry, StorageEntryType } from '../../shared/storage'

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

  /**
   * 空ディレクトリを作成する（S3 では末尾スラッシュの marker object）。
   * @param path 作成するディレクトリの仮想パス
   * @throws 同名のディレクトリ / ファイルが既に存在する場合
   */
  createDirectory(path: string): Promise<void>

  /**
   * ファイル / ディレクトリをリネーム（移動）する。
   * @param sourcePath 変更元の仮想パス
   * @param destinationPath 変更先の仮想パス
   * @param entryType source の種別。S3 はファイル / ディレクトリで処理が異なるため必要
   * @throws destination が既に存在する場合、または source 配下 / 同一 / ルートへの操作
   */
  rename(sourcePath: string, destinationPath: string, entryType: StorageEntryType): Promise<void>

  /**
   * ディレクトリを削除する。
   * SFTP は非再帰（非空はエラー）。S3 は実ディレクトリが無いため prefix 配下を一括削除する。
   * @param path 削除するディレクトリの仮想パス
   * @throws SFTP で非空の場合、削除中の個別失敗など
   */
  deleteDirectory(path: string): Promise<void>

  /**
   * 同一接続内でファイルを複製する。
   * @param sourcePath 複製元のファイルパス
   * @param destinationPath 複製先のファイルパス（呼び出し側で衝突しない名前を渡す）
   */
  copyFile(sourcePath: string, destinationPath: string): Promise<void>
}
