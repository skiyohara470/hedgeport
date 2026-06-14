import { join } from 'node:path'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'

import { app } from 'electron'

import type { ConnectionTarget } from '../shared/connections'

const connectionsFileName = 'connections.json'

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/**
 * IPC 越しの入力を main 側で必ず再検証する。
 * renderer の型だけでは永続化データや外部入力を守れないため。
 */
export function isConnectionTarget(value: unknown): value is ConnectionTarget {
  if (!value || typeof value !== 'object') return false
  const target = value as Record<string, unknown>
  if (!isString(target.id) || !isString(target.name)) return false

  if (target.kind === 'sftp') {
    return (
      isString(target.host) &&
      typeof target.port === 'number' &&
      isString(target.username) &&
      isString(target.password) &&
      isString(target.rootPath)
    )
  }

  if (target.kind === 's3') {
    // bucket / prefix はアカウント単位モデルでは持たない。legacy レコードに残っていても無視する。
    return (
      isString(target.region) &&
      isString(target.accessKeyId) &&
      isString(target.secretAccessKey) &&
      isString(target.sessionToken)
    )
  }

  return false
}

/**
 * 永続レコードを現行の接続設定形状へ正規化する。
 * S3 の legacy `bucket` / `prefix` を取り除き、他フィールドは保持する（データ消失なし）。
 * 正規化後の形状で保存されるため、次回保存時に legacy フィールドは消える。
 *
 * @param target 検証済みの接続設定（legacy フィールドを含み得る）
 * @returns 現行形状の接続設定
 */
export function migrateConnectionTarget(target: ConnectionTarget): ConnectionTarget {
  if (target.kind !== 's3') return target
  // 余分な legacy フィールド（bucket / prefix）を含めず、現行 S3 形状だけを組み立てる。
  const { id, name, lastLocalPath, region, accessKeyId, secretAccessKey, sessionToken } = target
  return {
    kind: 's3',
    id,
    name,
    ...(lastLocalPath !== undefined ? { lastLocalPath } : {}),
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
  }
}

function connectionsFilePath(): string {
  return join(app.getPath('userData'), connectionsFileName)
}

export async function loadConnections(): Promise<ConnectionTarget[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(connectionsFilePath(), 'utf8'))
    if (!Array.isArray(parsed) || !parsed.every(isConnectionTarget)) {
      throw new Error('Connections file has an invalid format.')
    }
    // legacy S3 レコード（bucket / prefix 付き）を現行形状へ正規化して返す。
    return parsed.map(migrateConnectionTarget)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function saveConnections(targets: ConnectionTarget[]): Promise<void> {
  if (!targets.every(isConnectionTarget)) throw new Error('Invalid connection settings.')

  // legacy shape（bucket / prefix 付き S3）が IPC 等から渡っても、永続化前に現行形状へ正規化する。
  const normalized = targets.map(migrateConnectionTarget)
  const directory = app.getPath('userData')
  const destination = connectionsFilePath()
  const temporary = `${destination}.tmp`
  // 一時ファイルへ書いてから rename し、破損した JSON が残る確率を下げる。
  await mkdir(directory, { recursive: true })
  await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, destination)
  await chmod(destination, 0o600)
}
