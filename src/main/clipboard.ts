import { isAbsolute, join } from 'node:path'
import { copyFile as fsCopyFile, readdir, readFile, writeFile } from 'node:fs/promises'

import type { ConnectionTarget } from '../shared/connections'
import type { BatchOperationResult, ClipboardEntry, PaneKind, PasteRequest } from '../shared/transfer'
import { isConnectionTarget } from './connectionStore'
import { createStorageProvider } from './providers/createStorageProvider'
import type { StorageProvider } from './providers/StorageProvider'
import { isCanonicalVirtualEntryPath, joinVirtualPath } from './providers/pathUtils'
import { assertEntryName } from './storageMutations'

/**
 * 既存名と衝突しない安全な名前を採番する。
 * 衝突時は `name copy.ext` → `name copy 2.ext` … の形式にする。
 * 先頭ドットのみのドットファイル（.env 等）は拡張子分割しない。
 *
 * @param name 希望する名前
 * @param taken 既存の名前集合（採番後の名前も追加していく）
 * @returns 衝突しない名前
 */
export function safeCopyName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = `${base} copy${ext}`
  let counter = 2
  while (taken.has(candidate)) {
    candidate = `${base} copy ${counter}${ext}`
    counter += 1
  }
  return candidate
}

/**
 * remote 側の接続設定を検証して返す。
 */
function ensureTarget(target: ConnectionTarget | null): ConnectionTarget {
  if (!isConnectionTarget(target)) throw new Error('Invalid connection settings.')
  return target
}

/**
 * pane 種別が remote / local か検証する。
 */
function assertPaneKind(kind: unknown): asserts kind is PaneKind {
  if (kind !== 'remote' && kind !== 'local') throw new Error('Invalid pane kind.')
}

/**
 * クリップボード 1 エントリを source 種別に応じて検証する。
 * name は storageMutations と同等に sanitize（空白のみ・dot/dotdot・slash・backslash・NUL 拒否）。
 * ディレクトリ copy は対象外。
 */
function assertClipboardEntry(raw: unknown, sourceKind: PaneKind): ClipboardEntry {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid clipboard entry.')
  const { path, name, type } = raw as Record<string, unknown>
  if (type !== 'file') throw new Error('Copying directories is not supported yet.')
  assertEntryName(name)
  if (sourceKind === 'remote') {
    if (typeof path !== 'string' || !isCanonicalVirtualEntryPath(path)) throw new Error('Invalid remote path.')
  } else if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error('Invalid local path.')
  }
  return { path, name: name as string, type }
}

/**
 * 失敗記録用に、未検証エントリから安全にパスを取り出す。
 */
function describeEntry(entry: unknown): string {
  if (entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string') {
    return (entry as { path: string }).path
  }
  return '(invalid)'
}

/**
 * 貼り付け先ディレクトリ直下の既存名集合を得る。
 */
async function listDestinationNames(
  destinationKind: 'remote' | 'local',
  directory: string,
  destinationProvider: StorageProvider | null
): Promise<Set<string>> {
  if (destinationKind === 'remote') {
    const entries = await destinationProvider!.list(directory)
    return new Set(entries.map((entry) => entry.name))
  }
  return new Set(await readdir(directory))
}

/**
 * アプリ内クリップボードの貼り付けを実行する。
 *
 * remote↔local の 4 組合せを main 内で処理し、renderer へバイト列を返さない。
 * ディレクトリのコピーは今回は対象外（明示エラー）。同名は上書きせず安全名で採番する。
 *
 * @param request 貼り付け要求（source / destination と entries）
 * @returns 成功数と失敗詳細
 */
export async function pasteEntries(request: unknown): Promise<BatchOperationResult> {
  if (!request || typeof request !== 'object') throw new Error('Invalid paste request.')
  const { entries, source, destination } = request as Partial<PasteRequest>
  if (!Array.isArray(entries)) throw new Error('Invalid clipboard entries.')
  if (!source || typeof source !== 'object' || !destination || typeof destination !== 'object') {
    throw new Error('Invalid paste request.')
  }
  assertPaneKind(source.kind)
  assertPaneKind(destination.kind)

  // remote 側は接続設定を検証、destination directory は kind に応じて canonical / absolute を検証する。
  const sourceProvider = source.kind === 'remote' ? createStorageProvider(ensureTarget(source.target)) : null
  const destinationProvider =
    destination.kind === 'remote' ? createStorageProvider(ensureTarget(destination.target)) : null
  if (destination.kind === 'remote') {
    if (destination.directory !== '/' && !isCanonicalVirtualEntryPath(destination.directory)) {
      throw new Error('Invalid remote path.')
    }
  } else if (typeof destination.directory !== 'string' || !isAbsolute(destination.directory)) {
    throw new Error('Invalid local path.')
  }

  const taken = await listDestinationNames(destination.kind, destination.directory, destinationProvider)
  const sameRemoteTarget =
    source.kind === 'remote' && destination.kind === 'remote' && source.target?.id === destination.target?.id

  const failures: BatchOperationResult['failures'] = []
  let succeeded = 0

  for (const raw of entries) {
    try {
      const entry = assertClipboardEntry(raw, source.kind)
      const name = safeCopyName(entry.name, taken)
      taken.add(name)
      await copyOne(entry, name, {
        source: source as PasteRequest['source'],
        destination: destination as PasteRequest['destination'],
        sourceProvider,
        destinationProvider,
        sameRemoteTarget,
      })
      succeeded += 1
    } catch (reason) {
      failures.push({ path: describeEntry(raw), message: reason instanceof Error ? reason.message : 'Copy failed.' })
    }
  }

  return { succeeded, failures }
}

/**
 * 1 ファイルを source/destination の組合せに応じてコピーする。
 */
async function copyOne(
  entry: ClipboardEntry,
  destinationName: string,
  context: {
    source: PasteRequest['source']
    destination: PasteRequest['destination']
    sourceProvider: StorageProvider | null
    destinationProvider: StorageProvider | null
    sameRemoteTarget: boolean
  }
): Promise<void> {
  const { source, destination, sourceProvider, destinationProvider, sameRemoteTarget } = context

  // local → local: fs.copyFile。
  if (source.kind === 'local' && destination.kind === 'local') {
    if (!isAbsolute(entry.path)) throw new Error('Invalid local path.')
    await fsCopyFile(entry.path, join(destination.directory, destinationName))
    return
  }

  // local → remote: readFile → provider.write。
  if (source.kind === 'local' && destination.kind === 'remote') {
    if (!isAbsolute(entry.path)) throw new Error('Invalid local path.')
    const data = await readFile(entry.path)
    await destinationProvider!.write(joinVirtualPath(destination.directory, destinationName), new Uint8Array(data))
    return
  }

  // remote → local: provider.read → writeFile。
  if (source.kind === 'remote' && destination.kind === 'local') {
    if (!isCanonicalVirtualEntryPath(entry.path)) throw new Error('Invalid remote path.')
    const data = await sourceProvider!.read(entry.path)
    await writeFile(join(destination.directory, destinationName), data)
    return
  }

  // remote → remote。
  if (!isCanonicalVirtualEntryPath(entry.path)) throw new Error('Invalid remote path.')
  const destinationPath = joinVirtualPath(destination.directory, destinationName)
  if (sameRemoteTarget) {
    // 同一接続はサーバーサイド copy（S3 CopyObject / SFTP get+put）。
    await destinationProvider!.copyFile(entry.path, destinationPath)
    return
  }
  // 異なる接続間は main 内で read→write（renderer へバイト列を返さない）。
  const data = await sourceProvider!.read(entry.path)
  await destinationProvider!.write(destinationPath, data)
}
