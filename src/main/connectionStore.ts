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
    return (
      isString(target.region) &&
      isString(target.bucket) &&
      isString(target.prefix) &&
      isString(target.accessKeyId) &&
      isString(target.secretAccessKey) &&
      isString(target.sessionToken)
    )
  }

  return false
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
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function saveConnections(targets: ConnectionTarget[]): Promise<void> {
  if (!targets.every(isConnectionTarget)) throw new Error('Invalid connection settings.')

  const directory = app.getPath('userData')
  const destination = connectionsFilePath()
  const temporary = `${destination}.tmp`
  // 一時ファイルへ書いてから rename し、破損した JSON が残る確率を下げる。
  await mkdir(directory, { recursive: true })
  await writeFile(temporary, `${JSON.stringify(targets, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, destination)
  await chmod(destination, 0o600)
}