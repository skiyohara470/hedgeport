import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app, shell, type IpcMainInvokeEvent } from 'electron'

import type { ConnectionTarget } from '../shared/connections'
import type { ExternalEditSession } from '../shared/transfer'
import type { StorageEntryType } from '../shared/storage'
import { isConnectionTarget } from './connectionStore'
import { chooseApplicationAndOpen, openVerifiedRegularFile } from './fileOpening'
import { createStorageProvider } from './providers/createStorageProvider'
import type { StorageProvider } from './providers/StorageProvider'
import { basenameVirtual, isCanonicalVirtualEntryPath, parentVirtualPath } from './providers/pathUtils'

/** リモートエントリのメタデータ（conflict 検出用）。 */
interface RemoteMetadata {
  exists: boolean
  type?: StorageEntryType
  modifiedAt?: string
  size?: number
}

/**
 * main 側だけが持つ外部編集セッションの内部状態。
 */
interface InternalSession {
  id: string
  target: ConnectionTarget
  remotePath: string
  name: string
  tempDir: string
  tempFilePath: string
  base: RemoteMetadata
  // temp の dirty 判定用スナップショット（download / upload 直後に更新）。
  tempMtimeMs: number
  tempSize: number
}

// セッションは target.id + canonical remote path で一意。重複起動は再利用する。
const sessions = new Map<string, InternalSession>()
// per-key の直列化キュー（start / upload / discard の競合を防ぐ single-flight）。
const queues = new Map<string, Promise<unknown>>()
// アプリ終了時の cleanup 開始フラグ。新規 start/upload/reveal を拒否する。
let shuttingDown = false

function sessionKey(targetId: string, remotePath: string): string {
  return `${targetId}\n${remotePath}`
}

/**
 * 同一 key の操作を直列に実行する。これで concurrent start の二重生成や upload/discard 競合を防ぐ。
 */
function runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve()
  // prior の成否に関わらず後続を実行（直列化のみ目的）。
  const next = prior.then(task, task)
  const guard = next.then(
    () => undefined,
    () => undefined
  )
  queues.set(key, guard)
  void guard.finally(() => {
    if (queues.get(key) === guard) queues.delete(key)
  })
  return next
}

function toPublic(session: InternalSession, dirty: boolean): ExternalEditSession {
  return { id: session.id, remotePath: session.remotePath, name: session.name, dirty }
}

function findById(sessionId: unknown): InternalSession | null {
  if (typeof sessionId !== 'string') return null
  for (const session of sessions.values()) if (session.id === sessionId) return session
  return null
}

/**
 * リモートの親ディレクトリを list して対象エントリのメタデータを得る（不在は exists:false）。
 */
async function readMetadata(provider: StorageProvider, remotePath: string): Promise<RemoteMetadata> {
  const parent = parentVirtualPath(remotePath) ?? '/'
  const entries = await provider.list(parent)
  const name = basenameVirtual(remotePath)
  const entry = entries.find((candidate) => candidate.name === name)
  if (!entry) return { exists: false }
  return { exists: true, type: entry.type, modifiedAt: entry.modifiedAt, size: entry.size }
}

/**
 * temp ファイルの stat スナップショット（mtimeMs / size）を取る。
 */
async function snapshotTemp(tempFilePath: string): Promise<{ tempMtimeMs: number; tempSize: number }> {
  const s = await stat(tempFilePath)
  return { tempMtimeMs: s.mtimeMs, tempSize: s.size }
}

/**
 * temp が download / 前回 upload 時点から変化したか（dirty）を判定する。
 * temp が消えている等の異常も「変化あり」とみなす。
 */
async function isDirty(session: InternalSession): Promise<boolean> {
  try {
    const s = await stat(session.tempFilePath)
    return s.mtimeMs !== session.tempMtimeMs || s.size !== session.tempSize
  } catch {
    return true
  }
}

/**
 * temp ファイルを外部アプリで開く。system-default は shell.openPath（失敗は throw）、
 * choose-app はアプリ選択 → spawn。choose-app のキャンセルは false を返す。
 */
async function launch(
  event: IpcMainInvokeEvent,
  tempFilePath: string,
  mode: 'system-default' | 'choose-app'
): Promise<boolean> {
  if (mode === 'system-default') {
    const error = await shell.openPath(tempFilePath)
    if (error) throw new Error(error)
    return true
  }
  const applicationPath = await chooseApplicationAndOpen(event, tempFilePath)
  return applicationPath !== null
}

/**
 * セッションの temp ディレクトリを削除する（best-effort。失敗は致命にせずログのみ）。
 */
async function cleanup(session: { tempDir: string }): Promise<void> {
  await rm(session.tempDir, { recursive: true, force: true }).catch((error) => {
    console.error(`Failed to clean up external edit temp dir ${session.tempDir}:`, error)
  })
}

/**
 * 新規セッションを作成して launch する（finding 1: 失敗時はトランザクション的に巻き戻す）。
 */
async function createAndLaunch(
  event: IpcMainInvokeEvent,
  key: string,
  target: ConnectionTarget,
  remotePath: string,
  mode: 'system-default' | 'choose-app'
): Promise<ExternalEditSession | null> {
  const provider = createStorageProvider(target)
  const data = await provider.read(remotePath)
  const base = await readMetadata(provider, remotePath)

  // temp は main 所有・canonical。renderer からパスを受け取らず basename のみ採用（path traversal 防止）。
  const id = randomUUID()
  const tempDir = join(app.getPath('temp'), 'hedgeport-edit', id)
  const name = basenameVirtual(remotePath)
  const tempFilePath = join(tempDir, name)
  await mkdir(tempDir, { recursive: true, mode: 0o700 })

  const session: InternalSession = {
    id,
    target,
    remotePath,
    name,
    tempDir,
    tempFilePath,
    base,
    tempMtimeMs: 0,
    tempSize: 0,
  }
  try {
    await writeFile(tempFilePath, data, { mode: 0o600 })
    const snap = await snapshotTemp(tempFilePath)
    session.tempMtimeMs = snap.tempMtimeMs
    session.tempSize = snap.tempSize
    sessions.set(key, session)
    const launched = await launch(event, tempFilePath, mode)
    if (!launched) {
      // choose-app キャンセル: 新規セッションは破棄。
      if (sessions.get(key) === session) sessions.delete(key)
      await cleanup(session)
      return null
    }
    return toPublic(session, false)
  } catch (error) {
    // mkdir 後のあらゆる失敗で map 登録（自分のものなら）と temp を巻き戻す（再利用可能な残骸を残さない）。
    if (sessions.get(key) === session) sessions.delete(key)
    await cleanup(session)
    throw error
  }
}

/**
 * リモートファイルを app 所有の per-session temp へダウンロードして外部アプリで開く。
 * 同一 (target, remotePath) は single-flight で直列化し、既存があれば再ダウンロードせず再利用（再 launch）する。
 *
 * @returns 公開用セッション。choose-app をキャンセルした新規セッションは null。
 */
export async function startExternalEdit(
  event: IpcMainInvokeEvent,
  target: unknown,
  remotePath: unknown,
  mode: unknown
): Promise<ExternalEditSession | null> {
  if (!isConnectionTarget(target)) throw new Error('Invalid connection settings.')
  if (typeof remotePath !== 'string' || !isCanonicalVirtualEntryPath(remotePath)) {
    throw new Error('Invalid remote path.')
  }
  if (mode !== 'system-default' && mode !== 'choose-app') throw new Error('Unsupported open mode.')
  if (shuttingDown) throw new Error('Application is shutting down.')

  const key = sessionKey(target.id, remotePath)
  return runExclusive(key, async () => {
    const existing = sessions.get(key)
    if (existing) {
      // 曖昧な重複を作らず、既存セッションを要求 mode で再 launch（フォーカス）。
      await launch(event, existing.tempFilePath, mode)
      return toPublic(existing, await isDirty(existing))
    }
    return createAndLaunch(event, key, target, remotePath, mode)
  })
}

/**
 * 外部編集の変更をリモートへ書き戻す（同一 session を直列化）。
 * temp が通常ファイル（非 symlink）であることを検証し、download 時点からリモートが
 * 削除 / 型変更 / 変化（modifiedAt / size）していれば conflict として block する。成功後は base / snapshot を更新。
 */
export async function uploadExternalEdit(sessionId: unknown): Promise<void> {
  if (shuttingDown) throw new Error('Application is shutting down.')
  const target = findById(sessionId)
  if (!target) throw new Error('Edit session not found.')
  const key = sessionKey(target.target.id, target.remotePath)
  return runExclusive(key, async () => {
    const session = findById(sessionId)
    if (!session) throw new Error('Edit session not found.')

    // temp を検証 handle 経由で読む（symlink 差し替え対策）。
    const handle = await openVerifiedRegularFile(session.tempFilePath, fsConstants.O_RDONLY)
    let data: Uint8Array
    try {
      data = new Uint8Array(await handle.readFile())
    } finally {
      await handle.close().catch(() => undefined)
    }

    const provider = createStorageProvider(session.target)
    const current = await readMetadata(provider, session.remotePath)
    if (!current.exists) {
      throw new Error('Remote file no longer exists. Discard and re-create to avoid resurrecting it.')
    }
    if (session.base.type !== undefined && current.type !== undefined && current.type !== session.base.type) {
      throw new Error('Remote entry type changed since you opened it. Discard to avoid overwriting.')
    }
    const changed =
      (session.base.modifiedAt !== undefined &&
        current.modifiedAt !== undefined &&
        current.modifiedAt !== session.base.modifiedAt) ||
      (session.base.size !== undefined && current.size !== undefined && current.size !== session.base.size)
    if (changed) {
      throw new Error('Remote file changed since you opened it. Discard and reopen to avoid overwriting changes.')
    }

    await provider.write(session.remotePath, data)
    // 書き戻し後の remote / temp を新たな基準にする（dirty=false、連続 upload を許容）。
    session.base = await readMetadata(provider, session.remotePath)
    const snap = await snapshotTemp(session.tempFilePath)
    session.tempMtimeMs = snap.tempMtimeMs
    session.tempSize = snap.tempSize
  })
}

/**
 * 外部編集を破棄して temp を片付ける（同一 session を直列化、冪等）。
 */
export async function discardExternalEdit(sessionId: unknown): Promise<void> {
  const target = findById(sessionId)
  if (!target) return
  const key = sessionKey(target.target.id, target.remotePath)
  await runExclusive(key, async () => {
    const session = findById(sessionId)
    if (!session) return
    sessions.delete(key)
    await cleanup(session)
  })
}

/**
 * temp ファイルを Finder / Explorer で表示する。
 */
export function revealExternalEdit(sessionId: unknown): void {
  if (shuttingDown) throw new Error('Application is shutting down.')
  const session = findById(sessionId)
  if (!session) throw new Error('Edit session not found.')
  shell.showItemInFolder(session.tempFilePath)
}

/**
 * 現在の全セッションを dirty 付きで列挙する（renderer のバナー更新用。temp パスは公開しない）。
 */
export async function listExternalEditSessions(): Promise<ExternalEditSession[]> {
  const result: ExternalEditSession[] = []
  for (const session of sessions.values()) result.push(toPublic(session, await isDirty(session)))
  return result
}

/**
 * 全セッションの temp を片付ける（アプリ終了時の best-effort）。await 可能。
 *
 * 先に shutdown フラグを立て新規 start/upload/reveal を拒否してから、
 * 現在キューにある in-flight 操作を **settle 待ち**（クリアしない）する。これにより
 * cleanup 中に start が provider.read 等を待っていても、完了後に登録されたセッションも snapshot に含めて確実に片付ける。
 * snapshot 後に新規タスクが登録されないことは、新規操作が shutdown で拒否されることで保証する。
 */
export async function cleanupAllExternalEdits(): Promise<void> {
  shuttingDown = true
  // queues はクリアせず、現在の in-flight をすべて settle 待ち。
  await Promise.allSettled([...queues.values()])
  const all = [...sessions.values()]
  sessions.clear()
  queues.clear()
  for (const session of all) await cleanup(session)
}

/** テスト用にセッション / shutdown 状態を初期化する。 */
export function __resetExternalEditSessionsForTest(): void {
  sessions.clear()
  queues.clear()
  shuttingDown = false
}
