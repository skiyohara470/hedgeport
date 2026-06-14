import { basename, isAbsolute, join } from 'node:path'
import { lstat, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'

import type { ConnectionTarget } from '../shared/connections'
import type { StorageEntryType } from '../shared/storage'
import type { BatchOperationResult } from '../shared/transfer'
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
 * リモートの複数ファイルを、指定ローカルディレクトリ直下へダウンロードする（ファイルのみ）。
 *
 * @param target 接続先設定（未検証値）
 * @param remotePaths ダウンロード元のリモート仮想パス配列
 * @param localDirectory 保存先のローカルディレクトリ（絶対パス）
 */
export async function batchDownloadToDirectory(
  target: unknown,
  remotePaths: unknown,
  localDirectory: unknown
): Promise<BatchOperationResult> {
  const connection = ensureConnectionTarget(target)
  if (!Array.isArray(remotePaths)) throw new Error('Invalid items.')
  if (typeof localDirectory !== 'string' || !isAbsolute(localDirectory)) throw new Error('Invalid local file path.')
  const provider = createStorageProvider(connection)
  return runBatch(remotePaths, async (raw) => {
    if (typeof raw !== 'string' || !isCanonicalVirtualEntryPath(raw)) throw new Error('Invalid remote path.')
    const data = await provider.read(raw)
    await writeFile(join(localDirectory, basenameVirtual(raw)), data)
  })
}

/**
 * ローカルの複数ファイルを、リモートの指定ディレクトリ直下へアップロードする（ファイルのみ）。
 *
 * @param target 接続先設定（未検証値）
 * @param localPaths アップロード元のローカル絶対パス配列
 * @param remoteDirectory 書き込み先のリモート仮想ディレクトリ
 */
export async function batchUpload(
  target: unknown,
  localPaths: unknown,
  remoteDirectory: unknown
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
  return runBatch(localPaths, async (raw) => {
    if (typeof raw !== 'string' || !isAbsolute(raw)) throw new Error('Invalid local path.')
    const data = await readFile(raw)
    await provider.write(joinVirtualPath(remoteDirectory, basename(raw)), new Uint8Array(data))
  })
}
