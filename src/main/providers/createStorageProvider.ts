import type { ConnectionTarget, ResolvedConnection } from '../../shared/connections'
import { getStoredSecrets, isValidS3Secrets, isValidSftpSecrets } from '../connectionSecrets'
import { S3Provider } from './S3Provider'
import { SftpProvider } from './SftpProvider'
import type { StorageProvider } from './StorageProvider'

/**
 * 機密でないメタデータに、暗号化ストアから復号した secret を結合して解決済み接続を作る。
 * secret は main プロセス内でのみ復号し、provider 生成（接続時）にだけ渡す。
 *
 * 復号した secret の shape が target.kind と一致しない場合は明確に失敗させる
 * （SFTP secret が S3 id に入っている等の壊れた状態を provider に渡さない）。
 *
 * @param target 機密でない接続先メタデータ
 * @returns メタデータ + secret を結合した解決済み接続
 * @throws S3 で必要な secret が保存されていない場合、または secret の kind と shape が一致しない場合
 */
export function resolveConnection(target: ConnectionTarget): ResolvedConnection {
  const secrets = getStoredSecrets(target.id)

  if (target.kind === 'sftp') {
    if (secrets !== null && !isValidSftpSecrets(secrets)) {
      throw new Error(
        `Stored credential for SFTP connection "${target.name}" has an unexpected format (wrong kind). Please re-enter and save the credentials.`
      )
    }
    // SFTP は password 任意（鍵認証等）。未保存 / password 欠落なら空文字で接続を試みる。
    const password = isValidSftpSecrets(secrets) ? secrets.password : ''
    return { ...target, password }
  }

  if (!secrets) {
    throw new Error('Missing stored credentials for this S3 connection. Please re-enter and save them.')
  }
  if (!isValidS3Secrets(secrets)) {
    throw new Error(
      `Stored credential for S3 connection "${target.name}" has an unexpected format (wrong kind or missing fields). Please re-enter and save the credentials.`
    )
  }
  const { accessKeyId, secretAccessKey, sessionToken } = secrets
  return { ...target, accessKeyId, secretAccessKey, sessionToken }
}

/**
 * 接続設定から対応するストレージ実装を選ぶ。
 * renderer 側は種別を意識せず共通インターフェースだけを扱う。
 * secret はここで（接続時に）復号して provider へ注入する。
 *
 * @param target 機密でない接続先メタデータ
 * @returns 解決済み credential を持つストレージ provider
 */
export function createStorageProvider(target: ConnectionTarget): StorageProvider {
  const connection = resolveConnection(target)
  return connection.kind === 'sftp' ? new SftpProvider(connection) : new S3Provider(connection)
}
