import { join } from 'node:path'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'

import { app } from 'electron'

import type { ConnectionDraft, ConnectionSecrets, ConnectionTarget } from '../shared/connections'
import {
  encryptSecrets,
  extractSecrets,
  readEncryptedMap,
  requireEncryptionAvailable,
  writeEncryptedMap,
} from './connectionSecrets'

const connectionsFileName = 'connections.json'

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/**
 * IPC 越しの入力を main 側で必ず再検証する。
 * renderer の型だけでは永続化データや外部入力を守れないため。
 *
 * 検証対象は「機密でないメタデータ」だけ。secret（password / アクセスキー類）は別ストアで扱うため、
 * ここでは要求しない。余分なフィールド（旧形式の平文 secret や legacy bucket / prefix）は無視する。
 *
 * @param value 検証対象（IPC / 永続レコード由来の未知値）
 * @returns メタデータとして妥当な接続先なら true
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
      isString(target.rootPath)
    )
  }

  if (target.kind === 's3') {
    // bucket / prefix はアカウント単位モデルでは持たない。legacy レコードに残っていても無視する。
    return isString(target.region)
  }

  return false
}

function connectionsFilePath(): string {
  return join(app.getPath('userData'), connectionsFileName)
}

/**
 * 機密でないメタデータ配列を connections.json へ原子的に書き込む。
 * 一時ファイルへ書いてから rename し、破損した JSON が残る確率を下げる。
 *
 * @param targets 保存するメタデータ（secret を含まないこと）
 */
async function writeConnectionsFile(targets: ConnectionTarget[]): Promise<void> {
  const directory = app.getPath('userData')
  const destination = connectionsFilePath()
  const temporary = `${destination}.tmp`
  await mkdir(directory, { recursive: true })
  await writeFile(temporary, `${JSON.stringify(targets, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, destination)
  await chmod(destination, 0o600)
}

/**
 * 永続レコードに平文 secret フィールドが残っているかを判定する。
 * 旧形式（password / アクセスキー類を connections.json に平文保存）からの移行要否に使う。
 *
 * @param record 永続レコード
 * @returns 平文 secret フィールドのキーが含まれていれば true
 */
function hasPlaintextSecretFields(record: ConnectionDraft): boolean {
  if (record.kind === 'sftp') return 'password' in record
  return 'accessKeyId' in record || 'secretAccessKey' in record || 'sessionToken' in record
}

/**
 * 旧形式（平文 secret を含む connections.json）を、暗号化ストア + メタデータのみの形式へ移行する。
 *
 * 失敗時にファイルを部分的に書き換えないため、必ず次の順で行う:
 * 1. 暗号化が必要なら safeStorage を要求し（不可なら何も書かずに throw）、
 * 2. 暗号化ストアを先に原子的に書き込み、
 * 3. その成功後に connections.json をメタデータのみへ書き換える。
 *
 * 未配布前提のため、これ以降の平文長期互換フォールバックは持たない。
 *
 * @param records 平文 secret を含み得る永続レコード
 */
async function migratePlaintextSecrets(records: ConnectionDraft[]): Promise<void> {
  const toStore: Array<{ id: string; secrets: ConnectionSecrets }> = []
  for (const record of records) {
    const { secrets } = extractSecrets(record)
    if (secrets) toStore.push({ id: record.id, secrets })
  }

  // 実際に暗号化する secret 値があるときだけ safeStorage を要求し、ストアへ書き込む。
  // 値が無い（空フィールドだけ）の場合は connections.json から該当フィールドを除去するだけでよい。
  if (toStore.length > 0) {
    requireEncryptionAvailable()
    const map = { ...readEncryptedMap() }
    for (const { id, secrets } of toStore) map[id] = encryptSecrets(secrets)
    await writeEncryptedMap(map)
  }

  // 暗号化ストア書き込み成功後に、平文を除いたメタデータで connections.json を上書きする。
  await writeConnectionsFile(records.map((record) => extractSecrets(record).metadata))
}

/**
 * 接続先メタデータを読み込む。secret は返さない（renderer へは機密でない情報だけ渡す）。
 * 旧形式（平文 secret を含む connections.json）を検出したら、暗号化ストアへ移行してから返す。
 *
 * @returns 機密でない接続先メタデータの配列
 */
export async function loadConnections(): Promise<ConnectionTarget[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(connectionsFilePath(), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  if (!Array.isArray(parsed) || !parsed.every(isConnectionTarget)) {
    throw new Error('Connections file has an invalid format.')
  }

  const records = parsed as ConnectionDraft[]
  // 平文 secret が残っていれば移行（暗号化ストア書き込み → 平文除去）してから返す。
  if (records.some((record) => hasPlaintextSecretFields(record))) {
    await migratePlaintextSecrets(records)
  }
  return records.map((record) => extractSecrets(record).metadata)
}

/**
 * 接続先の下書き配列を保存する。
 * secret はメタデータから分離して暗号化ストアへ保存し、connections.json には機密でないメタデータだけを残す。
 *
 * 書き込み順序:
 * 1. 追加/更新 secret を暗号化ストアへ書く（既存は維持、prune はまだしない）。
 *    この時点で失敗しても既存 secret は失われない。
 * 2. connections.json を書く。
 *    2a. 失敗時は暗号化ストアを元の状態へロールバックする（ロールバック失敗は非致命）。
 * 3. connections.json 書き込み成功後に prune（不要 id の secret 削除）を実行する。
 *    prune 失敗は stale な encrypted secret が残るだけで、接続の利用には影響しないため非致命。
 *
 * secret を含む下書きがあり safeStorage が使えない場合は、何も書かずに明確に失敗する（平文保存しない）。
 * secret 欄が空の下書き（編集で再入力しなかった場合など）は、既存の暗号化 secret を維持する。
 *
 * @param drafts renderer 由来の接続先下書き（secret は任意）
 * @returns 保存後の機密でないメタデータ配列（renderer の state 更新に使う）
 */
export async function saveConnections(drafts: ConnectionDraft[]): Promise<ConnectionTarget[]> {
  if (!drafts.every(isConnectionTarget)) throw new Error('Invalid connection settings.')

  const existing = readEncryptedMap()
  // addMap: 既存のすべての secret を保持したまま、新規/更新分を上書きしたマップ（prune 前）。
  const addMap: Record<string, string> = { ...existing }
  const metadata: ConnectionTarget[] = []
  const pendingSecrets: Array<{ id: string; secrets: ConnectionSecrets }> = []

  for (const draft of drafts) {
    const { metadata: meta, secrets } = extractSecrets(draft)
    metadata.push(meta)
    if (secrets) {
      pendingSecrets.push({ id: draft.id, secrets })
    }
    // 空 secret は addMap の初期値（existing のコピー）から既存暗号化値をそのまま引き継ぐ。
  }

  // 新規に暗号化する secret があるときだけ safeStorage を要求する（不可なら何も書かずに失敗）。
  if (pendingSecrets.length > 0) requireEncryptionAvailable()
  for (const { id, secrets } of pendingSecrets) addMap[id] = encryptSecrets(secrets)

  // Step 1: 追加/更新 secret を先に書く（prune 前なので既存 secret は安全）。
  await writeEncryptedMap(addMap)

  // Step 2: connections.json を書く。失敗時は暗号化ストアを元の状態へロールバックする。
  try {
    await writeConnectionsFile(metadata)
  } catch (error) {
    // connections.json の書き込み失敗時は、追加/更新分を加える前の状態に戻す。
    // ロールバック失敗は stale な encrypted secret が残るだけ（既存 secret の消失はない）。
    await writeEncryptedMap(existing).catch(() => undefined)
    throw error
  }

  // Step 3: connections.json 書き込み成功後に prune する。
  // prune 失敗は stale な encrypted secret が残るだけで、接続は正常に動作するため非致命。
  const draftIds = new Set(drafts.map((d) => d.id))
  const prunedMap: Record<string, string> = {}
  for (const [id, enc] of Object.entries(addMap)) {
    if (draftIds.has(id)) prunedMap[id] = enc
  }
  await writeEncryptedMap(prunedMap).catch(() => undefined)

  return metadata
}
