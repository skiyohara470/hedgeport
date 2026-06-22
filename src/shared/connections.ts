/**
 * main / preload / renderer が共有する接続設定契約。
 * 実装詳細ではなく、層をまたいで受け渡すデータ形状だけをここへ置く。
 *
 * 認証情報（secret）の扱い方針:
 * - `ConnectionTarget` は「機密でないメタデータ」だけを持つ。connections.json への永続化、
 *   renderer の保持、ストレージ操作 IPC の往復はすべてこの secret なし形状で行う。
 * - secret（SFTP password / S3 アクセスキー類）は `ConnectionSecrets` として分離し、main プロセスの
 *   暗号化ストア（safeStorage）にのみ保存・復号する。renderer / preload へは渡さない。
 * - secret を伴う provider 接続は `ResolvedConnection`（メタデータ + secret）として main 内でのみ組み立てる。
 * - 作成 / 編集 / 疎通確認では renderer から `ConnectionDraft`（secret は任意）を渡す。
 */
interface ConnectionTargetBase {
  id: string
  name: string
  lastLocalPath?: string
}

/**
 * SFTP 接続先の機密でないメタデータ。
 * password は secret として分離するためここには含めない。
 */
export interface SftpConnectionTarget extends ConnectionTargetBase {
  kind: 'sftp'
  host: string
  port: number
  username: string
  rootPath: string
}

/**
 * S3 接続先の機密でないメタデータ（アカウント/認証情報単位）。
 * accessKeyId / secretAccessKey / sessionToken は secret として分離する。
 * bucket / prefix は持たず、初期ページで region 内の bucket 一覧を表示し、
 * 仮想パス `/<bucket>/<key>` で各 bucket を辿る。
 */
export interface S3ConnectionTarget extends ConnectionTargetBase {
  kind: 's3'
  region: string
}

/**
 * 機密でない接続先メタデータの合併型。
 * 永続化・renderer 保持・ストレージ操作 IPC で使う。secret は含まない。
 */
export type ConnectionTarget = SftpConnectionTarget | S3ConnectionTarget

/**
 * SFTP の secret。
 */
export interface SftpSecrets {
  password: string
}

/**
 * S3 の secret。
 */
export interface S3Secrets {
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
}

/**
 * 接続種別ごとの secret 合併型。暗号化ストアにのみ保存し、renderer へは出さない。
 */
export type ConnectionSecrets = SftpSecrets | S3Secrets

/**
 * メタデータと secret を結合した、provider が接続に使う解決済み接続（main 内専用）。
 */
export type SftpConnection = SftpConnectionTarget & SftpSecrets
export type S3Connection = S3ConnectionTarget & S3Secrets
export type ResolvedConnection = SftpConnection | S3Connection

/**
 * renderer から作成 / 編集 / 疎通確認時に渡す下書き。
 * secret は任意（編集時に空欄なら既存の secret を維持する）。
 */
export type SftpConnectionDraft = SftpConnectionTarget & Partial<SftpSecrets>
export type S3ConnectionDraft = S3ConnectionTarget & Partial<S3Secrets>
export type ConnectionDraft = SftpConnectionDraft | S3ConnectionDraft

/**
 * 接続テスト結果。
 */
export interface ConnectionTestResult {
  ok: boolean
  message: string
}
