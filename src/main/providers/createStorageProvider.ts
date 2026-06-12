import type { ConnectionTarget } from '../../shared/connections'
import { S3Provider } from './S3Provider'
import { SftpProvider } from './SftpProvider'
import type { StorageProvider } from './StorageProvider'

/**
 * 接続設定から対応するストレージ実装を選ぶ。
 * renderer 側は種別を意識せず共通インターフェースだけを扱う。
 */
export function createStorageProvider(target: ConnectionTarget): StorageProvider {
  return target.kind === 'sftp' ? new SftpProvider(target) : new S3Provider(target)
}
