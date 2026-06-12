/**
 * main / preload / renderer が共有する接続設定契約。
 * 実装詳細ではなく、層をまたいで受け渡すデータ形状だけをここへ置く。
 */
interface ConnectionTargetBase {
  id: string
  name: string
  lastLocalPath?: string
}

/**
 * SFTP 接続先の設定。
 */
export interface SftpConnectionTarget extends ConnectionTargetBase {
  kind: 'sftp'
  host: string
  port: number
  username: string
  password: string
  rootPath: string
}

/**
 * S3 接続先の設定。
 */
export interface S3ConnectionTarget extends ConnectionTargetBase {
  kind: 's3'
  region: string
  bucket: string
  prefix: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
}

/**
 * renderer から main へ受け渡す接続先設定の合併型。
 */
export type ConnectionTarget = SftpConnectionTarget | S3ConnectionTarget

/**
 * 接続テスト結果。
 */
export interface ConnectionTestResult {
  ok: boolean
  message: string
}

/**
 * S3 bucket 一覧取得に必要な認証入力。
 */
export interface S3BucketListRequest {
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
}
