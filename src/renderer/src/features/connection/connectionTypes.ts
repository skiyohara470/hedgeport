/**
 * 接続先選択画面と将来の StorageProvider 生成が扱う接続設定。
 * main/renderer間で共有する契約を再公開する。
 */
export type {
  ConnectionTarget,
  ConnectionTestResult,
  S3ConnectionTarget,
  SftpConnectionTarget,
} from '../../../../shared/connections'
