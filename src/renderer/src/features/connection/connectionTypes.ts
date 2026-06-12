/**
 * 起動時の接続先選択画面が扱う接続先1件。
 */
export interface ConnectionTarget {
  /** 一意な識別子 */
  id: string
  /** 表示名 */
  name: string
  /** 接続先の種別 */
  kind: 'sftp' | 's3'
}
