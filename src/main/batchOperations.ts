import { basename, isAbsolute, join } from 'node:path'
import { lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'

import type { ConnectionTarget } from '../shared/connections'
import type { StorageEntryType } from '../shared/storage'
import type { BatchOperationResult, BatchTransferProgress } from '../shared/transfer'
import { isConnectionTarget } from './connectionStore'
import { createStorageProvider } from './providers/createStorageProvider'
import { basenameVirtual, isCanonicalVirtualEntryPath, joinVirtualPath } from './providers/pathUtils'

/**
 * 接続設定を main 側で再検証して返す。
 *
 * @param target 検証対象
 * @returns 検証済み ConnectionTarget
 * @throws 不正な場合
 */
function ensureConnectionTarget(target: unknown): ConnectionTarget {
  if (!isConnectionTarget(target)) throw new Error('Invalid connection settings.')
  return target
}

/**
 * 失敗記録用に、未検証アイテムから安全にパス文字列を取り出す。
 */
function describeItem(item: unknown): string {
  if (typeof item === 'string') return item
  if (item && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string') {
    return (item as { path: string }).path
  }
  return '(invalid)'
}

/**
 * 逐次処理し、成功数と失敗詳細を集計する共通ランナー。
 * 1 件の失敗で全体を止めず、項目ごとに try/catch して継続する。未検証要素も安全に failure 化する。
 *
 * @param items 未検証の処理対象配列
 * @param run 各項目の処理（要素を検証し実行する）
 * @returns 成功数と失敗一覧
 */
async function runBatch(items: unknown[], run: (item: unknown) => Promise<void>): Promise<BatchOperationResult> {
  const failures: BatchOperationResult['failures'] = []
  let succeeded = 0
  for (const item of items) {
    try {
      await run(item)
      succeeded += 1
    } catch (reason) {
      failures.push({
        path: describeItem(item),
        message: reason instanceof Error ? reason.message : 'Operation failed.',
      })
    }
  }
  return { succeeded, failures }
}

/**
 * リモートのバッチ項目を検証する（object / canonical path / file|directory）。
 *
 * @param raw IPC から届いた未検証の値
 * @returns 検証済みの remote path と entry 種別
 * @throws shape、path、entry 種別が不正な場合
 */
function assertRemoteBatchItem(raw: unknown): { path: string; type: StorageEntryType } {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid item.')
  const { path, type } = raw as Record<string, unknown>
  if (typeof path !== 'string' || !isCanonicalVirtualEntryPath(path)) throw new Error('Invalid remote path.')
  if (type !== 'file' && type !== 'directory') throw new Error('Invalid entry type.')
  return { path, type }
}

/**
 * ローカルのバッチ項目を検証する（object / absolute path / file|directory）。
 *
 * @param raw IPC から届いた未検証の値
 * @returns 検証済みの local path と entry 種別
 * @throws shape、path、entry 種別が不正な場合
 */
function assertLocalBatchItem(raw: unknown): { path: string; type: StorageEntryType } {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid item.')
  const { path, type } = raw as Record<string, unknown>
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Invalid local path.')
  if (type !== 'file' && type !== 'directory') throw new Error('Invalid entry type.')
  return { path, type }
}

/**
 * リモートの複数エントリを削除する（file は delete、directory は deleteDirectory）。
 *
 * @param target 接続先設定（未検証値）
 * @param items 削除対象 [{ path, type }]
 * @returns 成功件数と失敗した項目
 */
export async function batchDeleteRemote(target: unknown, items: unknown): Promise<BatchOperationResult> {
  const connection = ensureConnectionTarget(target)
  if (!Array.isArray(items)) throw new Error('Invalid items.')
  const provider = createStorageProvider(connection)
  return runBatch(items, async (raw) => {
    const item = assertRemoteBatchItem(raw)
    if (item.type === 'directory') await provider.deleteDirectory(item.path)
    else await provider.delete(item.path)
  })
}

/**
 * ローカルの複数エントリを削除する。
 * symlink は追跡せず entry として削除（unlink）。directory は非再帰（空のみ、非空はエラー）。
 *
 * @param items 削除対象 [{ path, type }]
 * @returns 成功件数と失敗した項目
 */
export async function batchDeleteLocal(items: unknown): Promise<BatchOperationResult> {
  if (!Array.isArray(items)) throw new Error('Invalid items.')
  return runBatch(items, async (raw) => {
    const item = assertLocalBatchItem(raw)
    // lstat で symlink を追跡しない。symlink はリンク自体を unlink する。
    const stats = await lstat(item.path)
    if (stats.isSymbolicLink() || stats.isFile()) {
      await unlink(item.path)
      return
    }
    if (stats.isDirectory()) {
      // 非再帰。非空は rmdir がエラーを投げる（安全側）。
      await rmdir(item.path)
      return
    }
    throw new Error('Unsupported entry.')
  })
}

/**
 * リモートの複数エントリを、指定ローカルディレクトリへダウンロードする。
 * ディレクトリは同名のローカルディレクトリへ再帰的に取得し、既存フォルダへはマージする。
 *
 * @param target 接続先設定（未検証値）
 * @param items ダウンロード対象 [{ path, type }]
 * @param localDirectory 保存先のローカルディレクトリ（絶対パス）
 * @returns 成功件数と失敗した項目。directory は子の一部が保存済みでも失敗として記録される
 */
export async function batchDownloadToDirectory(
  target: unknown,
  items: unknown,
  localDirectory: unknown,
  onProgress?: (progress: Omit<BatchTransferProgress, 'transferId'>) => void
): Promise<BatchOperationResult> {
  const connection = ensureConnectionTarget(target)
  if (!Array.isArray(items)) throw new Error('Invalid items.')
  if (typeof localDirectory !== 'string' || !isAbsolute(localDirectory)) throw new Error('Invalid local file path.')
  const provider = createStorageProvider(connection)
  let completed = 0
  return runBatch(items, async (raw) => {
    try {
      const item = assertRemoteBatchItem(raw)
      await downloadRemoteEntry(provider, item.path, item.type, join(localDirectory, basenameVirtual(item.path)))
    } finally {
      completed += 1
      onProgress?.({ completed, total: items.length })
    }
  })
}

/**
 * リモート一覧の子要素名がローカルの1パス要素として安全か検証する。
 *
 * 作成・改名時の assertEntryName と異なり、既存リモート名の空白だけのケースは許容する。
 *
 * @param name リモートプロバイダーが返した名前
 * @throws 空名、dot segment、区切り文字、NUL を含む場合
 */
function assertSafeRemoteName(name: unknown): asserts name is string {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    /[\\/\0]/.test(name)
  ) {
    throw new Error('Remote entry has an unsafe name.')
  }
}

/**
 * ファイルのダウンロード先が regular file か検証し、symlink への書き込みを拒否する。
 *
 * @param path 検証するローカルパス
 * @throws symlink、regular file 以外の既存 entry、または stat エラーの場合
 */
async function assertDownloadFileDestination(path: string): Promise<void> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) throw new Error('Refusing to write through a symbolic link.')
    if (!stats.isFile()) {
      throw new Error('A different item already exists at the download destination.')
    }
  } catch (reason) {
    if (reason && typeof reason === 'object' && 'code' in reason && reason.code === 'ENOENT') return
    throw reason
  }
}

/**
 * 保存先ルート配下のディレクトリを symlink をたどらずに確認し、無ければ1階層だけ作る。
 *
 * 呼び出し側は親 directory を先に検証済みであること。recursive mkdir は使わず、
 * 既存の子 directory が symlink の場合にそのリンク先へ書き込まない。
 *
 * @param path 検証または作成する directory path
 * @throws symlink、directory 以外の既存 entry、親の不存在、または filesystem error の場合
 */
async function ensureDownloadDirectory(path: string): Promise<void> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) throw new Error('Refusing to write through a symbolic link.')
    if (!stats.isDirectory()) throw new Error('A different item already exists at the download destination.')
  } catch (reason) {
    if (reason && typeof reason === 'object' && 'code' in reason && reason.code === 'ENOENT') {
      // 親は再帰呼び出し元で検証済み。recursive mkdir で未検証の子孫をたどらない。
      await mkdir(path)
      return
    }
    throw reason
  }
}

/**
 * リモートの1エントリをローカルへ保存する。directory は子要素を逐次処理する。
 *
 * @param provider ダウンロード元 provider
 * @param remotePath canonical なリモート仮想パス
 * @param type 対象の entry 種別
 * @param localPath 保存先パス
 * @throws provider / filesystem 操作、または子エントリ検証に失敗した場合
 */
async function downloadRemoteEntry(
  provider: ReturnType<typeof createStorageProvider>,
  remotePath: string,
  type: StorageEntryType,
  localPath: string
): Promise<void> {
  if (type === 'file') {
    await assertDownloadFileDestination(localPath)
    const data = await provider.read(remotePath)
    await writeFile(localPath, data)
    return
  }

  await ensureDownloadDirectory(localPath)
  const children = await provider.list(remotePath)
  const failures: Array<{ path: string; message: string }> = []
  for (const child of children) {
    try {
      assertSafeRemoteName(child.name)
      if (child.type !== 'file' && child.type !== 'directory') throw new Error('Invalid remote entry type.')
      const expectedPath = joinVirtualPath(remotePath, child.name)
      if (child.path !== expectedPath || !isCanonicalVirtualEntryPath(child.path)) {
        throw new Error('Remote entry has an invalid path.')
      }
      await downloadRemoteEntry(provider, child.path, child.type, join(localPath, child.name))
    } catch (reason) {
      failures.push({
        path: typeof child.path === 'string' ? child.path : remotePath,
        message: reason instanceof Error ? reason.message : 'Operation failed.',
      })
    }
  }
  if (failures.length > 0) {
    const first = failures[0]
    throw new Error(`Failed to download ${failures.length} item(s). ${first.path}: ${first.message}`)
  }
}

/**
 * ローカルの複数ファイルを、リモートの指定ディレクトリ直下へアップロードする（ファイルのみ）。
 *
 * @param target 接続先設定（未検証値）
 * @param localPaths アップロード元のローカル絶対パス配列
 * @param remoteDirectory 書き込み先のリモート仮想ディレクトリ
 * @returns 成功件数と失敗した項目
 */
export async function batchUpload(
  target: unknown,
  localPaths: unknown,
  remoteDirectory: unknown,
  onProgress?: (progress: Omit<BatchTransferProgress, 'transferId'>) => void
): Promise<BatchOperationResult> {
  const connection = ensureConnectionTarget(target)
  if (!Array.isArray(localPaths)) throw new Error('Invalid items.')
  if (
    typeof remoteDirectory !== 'string' ||
    (remoteDirectory !== '/' && !isCanonicalVirtualEntryPath(remoteDirectory))
  ) {
    throw new Error('Invalid remote path.')
  }
  const provider = createStorageProvider(connection)
  let completed = 0
  return runBatch(localPaths, async (raw) => {
    try {
      const item = typeof raw === 'string' ? { path: raw } : raw
      if (!item || typeof item !== 'object') throw new Error('Invalid local path.')
      const localPath = (item as { path?: unknown }).path
      if (typeof localPath !== 'string' || !isAbsolute(localPath)) throw new Error('Invalid local path.')
      const localStat = await lstat(localPath)
      const type = localStat.isDirectory() ? 'directory' : localStat.isFile() ? 'file' : 'unsupported'
      if (localStat.isSymbolicLink() || type === 'unsupported') throw new Error('Unsupported local entry.')
      await uploadLocalEntry(provider, localPath, joinVirtualPath(remoteDirectory, basename(localPath)), type)
    } finally {
      completed += 1
      onProgress?.({ completed, total: localPaths.length })
    }
  })
}

/**
 * ローカルのファイル / ディレクトリを再帰的にリモートへ送る。symlink は追跡せず拒否する。
 */
async function uploadLocalEntry(
  provider: ReturnType<typeof createStorageProvider>,
  localPath: string,
  remotePath: string,
  knownType?: 'file' | 'directory'
): Promise<void> {
  const stats = await lstat(localPath)
  if (stats.isSymbolicLink()) throw new Error('Symbolic links cannot be uploaded.')
  if (stats.isFile() && (!knownType || knownType === 'file')) {
    const data = await readFile(localPath)
    await provider.write(remotePath, new Uint8Array(data))
    return
  }
  if (!stats.isDirectory() || (knownType && knownType !== 'directory')) {
    throw new Error('Local entry changed during upload.')
  }
  await provider.createDirectory(remotePath)
  const children = await readdir(localPath, { withFileTypes: true })
  for (const child of children) {
    if (child.name === '.' || child.name === '..' || /[\\/\0]/.test(child.name)) {
      throw new Error('Local directory contains an unsafe entry name.')
    }
    await uploadLocalEntry(
      provider,
      join(localPath, child.name),
      joinVirtualPath(remotePath, child.name),
      child.isDirectory() ? 'directory' : 'file'
    )
  }
}
