import { readFileSync } from 'node:fs'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app, safeStorage } from 'electron'

import type {
  ConnectionDraft,
  ConnectionSecrets,
  ConnectionTarget,
  S3Secrets,
  SftpSecrets,
} from '../shared/connections'

/**
 * secret（暗号化済み）を保存する専用ファイル。connections.json とは分離する。
 * connections.json には機密でないメタデータだけを残し、ここには safeStorage で暗号化した値だけを置く。
 */
const secretsFileName = 'connectionSecrets.json'

/** 現行 secret ストアのフォーマットバージョン。将来の形式変更検知に使う。 */
const SECRET_STORE_VERSION = 1

/**
 * 永続化する secret ストアの封筒（envelope）形状。
 * `secrets` は接続 id → base64(safeStorage 暗号化バイト列) のマップ。
 */
interface SecretEnvelope {
  version: typeof SECRET_STORE_VERSION
  secrets: Record<string, string>
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/**
 * 復号後 JSON が SFTP secret の正当な形状かを検証する。
 * password は文字列（空可）のみ許可する。
 */
export function isValidSftpSecrets(value: unknown): value is SftpSecrets {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return isString(obj.password)
}

/**
 * 復号後 JSON が S3 secret の正当な形状かを検証する。
 * accessKeyId / secretAccessKey は非空文字列、sessionToken は文字列（空可）のみ許可する。
 */
export function isValidS3Secrets(value: unknown): value is S3Secrets {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return isString(obj.accessKeyId) && obj.accessKeyId !== '' && isString(obj.secretAccessKey) && obj.secretAccessKey !== '' && isString(obj.sessionToken)
}

/**
 * 復号後 JSON が ConnectionSecrets の正当な形状かを検証する。
 */
export function isValidConnectionSecrets(value: unknown): value is ConnectionSecrets {
  return isValidSftpSecrets(value) || isValidS3Secrets(value)
}

/**
 * 下書き/レコードからメタデータ（機密でない部分）と secret を分離する純粋関数。
 * 永続化（connections.json はメタデータのみ）と移行（平文 secret の抽出）の両方で使う。
 *
 * secret の有無判定:
 * - SFTP: password が非空文字列（かつ文字列型）のときのみ secret あり（鍵認証等で password 不要なら secret なし）。
 * - S3: secretAccessKey が非空文字列（かつ文字列型）のときのみ secret あり。
 *   このとき accessKeyId も非空文字列でなければ throw、sessionToken は文字列（空可）。
 *
 * 編集時に secret 欄が空（undefined / ''）の下書きは secret=null を返し、呼び出し側で既存 secret を維持する。
 *
 * @param draft 接続の下書き、または平文 secret を含み得る永続レコード
 * @returns メタデータ（現行形状・legacy フィールド除去）と、抽出した secret（無ければ null）
 * @throws S3 で secretAccessKey はあるが accessKeyId が非空文字列でない場合、または secret fields に非文字列値が渡った場合
 */
export function extractSecrets(draft: ConnectionDraft): {
  metadata: ConnectionTarget
  secrets: ConnectionSecrets | null
} {
  if (draft.kind === 'sftp') {
    const metadata: ConnectionTarget = {
      kind: 'sftp',
      id: draft.id,
      name: draft.name,
      ...(draft.lastLocalPath !== undefined ? { lastLocalPath: draft.lastLocalPath } : {}),
      host: draft.host,
      port: draft.port,
      username: draft.username,
      rootPath: draft.rootPath,
    }
    // IPC/旧ファイル由来で非 string が来た場合は secret なし扱い（不正型を暗号化しない）。
    const rawPassword = draft.password
    const password = isString(rawPassword) ? rawPassword : ''
    const secrets: SftpSecrets | null = password ? { password } : null
    return { metadata, secrets }
  }

  const metadata: ConnectionTarget = {
    kind: 's3',
    id: draft.id,
    name: draft.name,
    ...(draft.lastLocalPath !== undefined ? { lastLocalPath: draft.lastLocalPath } : {}),
    region: draft.region,
  }
  const rawSecretAccessKey = draft.secretAccessKey
  // 非文字列の secretAccessKey は secret なし扱い（IPC/旧ファイル由来の不正型を暗号化しない）。
  if (!isString(rawSecretAccessKey) || rawSecretAccessKey === '') {
    return { metadata, secrets: null }
  }
  // secretAccessKey が有効なら accessKeyId も非空文字列を要求（部分的な secret は拒否）。
  const rawAccessKeyId = draft.accessKeyId
  if (!isString(rawAccessKeyId) || rawAccessKeyId === '') {
    throw new Error('S3 credentials are incomplete: secretAccessKey is present but accessKeyId is missing or invalid.')
  }
  const sessionToken = isString(draft.sessionToken) ? draft.sessionToken : ''
  const secrets: S3Secrets = {
    accessKeyId: rawAccessKeyId,
    secretAccessKey: rawSecretAccessKey,
    sessionToken,
  }
  return { metadata, secrets }
}

/**
 * 永続テキストを secret envelope として検証・解析し、id→base64 マップを返す純粋関数。
 *
 * @param text connectionSecrets.json の中身
 * @returns 接続 id → 暗号化値(base64) のマップ
 * @throws 形状/バージョンが不正な場合
 */
export function parseSecretEnvelope(text: string): Record<string, string> {
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Secret store file has an invalid format.')
  }
  const envelope = parsed as Record<string, unknown>
  if (envelope.version !== SECRET_STORE_VERSION || !envelope.secrets || typeof envelope.secrets !== 'object') {
    throw new Error('Secret store file has an invalid format.')
  }
  const secrets = envelope.secrets as Record<string, unknown>
  if (!Object.values(secrets).every(isString)) {
    throw new Error('Secret store file has an invalid format.')
  }
  return secrets as Record<string, string>
}

/**
 * id→base64 マップを永続テキスト（整形済み JSON）へ直列化する純粋関数。
 */
export function serializeSecretEnvelope(map: Record<string, string>): string {
  const envelope: SecretEnvelope = { version: SECRET_STORE_VERSION, secrets: map }
  return `${JSON.stringify(envelope, null, 2)}\n`
}

function secretsFilePath(): string {
  return join(app.getPath('userData'), secretsFileName)
}

/**
 * OS の安全な暗号化（Keychain / DPAPI / libsecret 等）が利用可能か。
 */
export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/**
 * safeStorage が使えなければ明確に失敗させる。平文フォールバックは行わない。
 *
 * @throws 暗号化が利用不可の場合
 */
export function requireEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Secure credential storage is unavailable on this system (OS encryption not available). ' +
        'Credentials cannot be saved or read without it.'
    )
  }
}

// 同期復号（provider 生成時に同期で secret を解決する）のための、ファイルパス単位キャッシュ。
// テストごとに userData(temp) が変わっても、パス変化で自動的に読み直す。
let cache: { path: string; map: Record<string, string> } | null = null

/**
 * 暗号化済み secret マップを同期で読み出す（キャッシュあり）。
 * ファイルが無ければ空マップを返す。
 *
 * @returns 接続 id → 暗号化値(base64) のマップ
 */
export function readEncryptedMap(): Record<string, string> {
  const path = secretsFilePath()
  if (cache && cache.path === path) return cache.map
  try {
    const map = parseSecretEnvelope(readFileSync(path, 'utf8'))
    cache = { path, map }
    return map
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = { path, map: {} }
      return {}
    }
    throw error
  }
}

/**
 * 暗号化済み secret マップを原子的に書き込む（temp へ書いて rename）。
 * パーミッションは 0600。書き込み後にキャッシュを更新する。
 *
 * @param map 接続 id → 暗号化値(base64) のマップ
 */
export async function writeEncryptedMap(map: Record<string, string>): Promise<void> {
  const directory = app.getPath('userData')
  const destination = secretsFilePath()
  const temporary = `${destination}.tmp`
  await mkdir(directory, { recursive: true })
  await writeFile(temporary, serializeSecretEnvelope(map), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, destination)
  await chmod(destination, 0o600)
  cache = { path: destination, map }
}

/**
 * secret を暗号化して base64 文字列にする。safeStorage 必須。
 *
 * @param secrets 接続種別ごとの secret
 * @returns 暗号化バイト列の base64
 * @throws 暗号化が利用不可の場合
 */
export function encryptSecrets(secrets: ConnectionSecrets): string {
  requireEncryptionAvailable()
  return safeStorage.encryptString(JSON.stringify(secrets)).toString('base64')
}

/**
 * 保存済みの暗号化値を復号して secret を取り出す。
 * 復号後 JSON を検証し、形状が不正な場合は throw する（壊れた値を provider へ渡さない）。
 *
 * @param id 接続 id
 * @returns 復号した secret。未保存なら null
 * @throws 暗号化が利用不可、復号 JSON が壊れている、または形状が不正な場合
 */
export function getStoredSecrets(id: string): ConnectionSecrets | null {
  const map = readEncryptedMap()
  const encoded = map[id]
  if (encoded === undefined) return null
  requireEncryptionAvailable()
  const decrypted = safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  const parsed: unknown = JSON.parse(decrypted)
  if (!isValidConnectionSecrets(parsed)) {
    throw new Error(
      `Stored credential for connection "${id}" has an invalid or unrecognized format. Please re-enter and save the credentials.`
    )
  }
  return parsed
}
