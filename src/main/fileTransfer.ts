import { isAbsolute, join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'

import type { ConnectionTarget } from '../shared/connections'
import type { TextDocument } from '../shared/transfer'
import { isConnectionTarget } from './connectionStore'
import { createStorageProvider } from './providers/createStorageProvider'
import { basenameVirtual, isCanonicalVirtualEntryPath } from './providers/pathUtils'
import { decodeTextDocument, encodeTextDocument, resolveEncoding, resolveReadEncoding } from './textCodec'

/**
 * IPC 越しに渡る接続設定を main 側で必ず再検証する。
 * renderer の型は信頼せず、ここを通った target だけを provider へ渡す。
 *
 * @param target 検証対象（renderer から届く未検証値）
 * @throws 接続設定として不正な場合
 */
function assertConnectionTarget(target: unknown): asserts target is ConnectionTarget {
  if (!isConnectionTarget(target)) throw new Error('Invalid connection settings.')
}

/**
 * リモート仮想パスが「正規化済みの絶対仮想ファイルパス」か検証する。
 *
 * provider 側（joinSftpPath / parseS3VirtualPath）は受け取ったパスを normalizeVirtualPath で
 * 正規化するため、'//', '/.', '/foo/..', 末尾スラッシュ等の曖昧入力はルートや親へ滑り込み、
 * write / delete で bucket ルート相当を操作し得る。
 * そこで「先頭スラッシュ必須・末尾スラッシュ禁止・正規化結果が入力と一致・ルートでない」を満たす
 * canonical な入力だけを受理する。
 *
 * @param path 検証対象のリモート仮想パス
 * @throws ファイルパスとして不正・非正規化・ルート相当の場合
 */
function assertRemoteFilePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isCanonicalVirtualEntryPath(path)) {
    throw new Error('Invalid remote file path.')
  }
}

/**
 * ローカルパスは絶対パスのみ受け付ける。
 * renderer から相対パスや空文字が来ても main で弾く。
 *
 * @param path 検証対象のローカルパス
 * @throws 絶対パスでない場合
 */
function assertLocalPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error('Invalid local file path.')
  }
}

/**
 * リモートの単一ファイルをローカルへダウンロードする。
 * 大容量バイト列を renderer IPC へ往復させず、main 内で read → writeFile する。
 *
 * @param target 接続先設定（未検証値）
 * @param remotePath ダウンロード元のリモート仮想パス
 * @param localPath 保存先のローカル絶対パス
 */
export async function downloadFile(target: unknown, remotePath: unknown, localPath: unknown): Promise<void> {
  assertConnectionTarget(target)
  assertRemoteFilePath(remotePath)
  assertLocalPath(localPath)
  const data = await createStorageProvider(target).read(remotePath)
  await writeFile(localPath, data)
}

/**
 * リモートの単一ファイルを、指定ローカルディレクトリ直下へダウンロードする。
 * ファイル名結合は main 側で platform-safe に行い（remote basename + OS の path.join）、
 * renderer はディレクトリパスだけ渡せばよい。
 *
 * @param target 接続先設定（未検証値）
 * @param remotePath ダウンロード元のリモート仮想パス
 * @param localDirectory 保存先のローカルディレクトリ（絶対パス）
 */
export async function downloadToDirectory(
  target: unknown,
  remotePath: unknown,
  localDirectory: unknown
): Promise<void> {
  assertConnectionTarget(target)
  assertRemoteFilePath(remotePath)
  if (typeof localDirectory !== 'string' || !isAbsolute(localDirectory)) {
    throw new Error('Invalid local file path.')
  }
  const localPath = join(localDirectory, basenameVirtual(remotePath))
  const data = await createStorageProvider(target).read(remotePath)
  await writeFile(localPath, data)
}

/**
 * ローカルの単一ファイルをリモートへアップロードする。
 * main 内で readFile → provider.write し、renderer はバイト列を扱わない。
 *
 * @param target 接続先設定（未検証値）
 * @param localPath アップロード元のローカル絶対パス
 * @param remotePath 書き込み先のリモート仮想パス
 */
export async function uploadFile(target: unknown, localPath: unknown, remotePath: unknown): Promise<void> {
  assertConnectionTarget(target)
  assertLocalPath(localPath)
  assertRemoteFilePath(remotePath)
  const data = await readFile(localPath)
  await createStorageProvider(target).write(remotePath, new Uint8Array(data))
}

/**
 * リモートファイルを UTF-8 テキストとして読み出す。
 * 編集モード保護のためサイズ上限を設け、NUL 含有や不正 UTF-8 はバイナリとして明示エラーにする。
 *
 * @param target 接続先設定（未検証値）
 * @param path 読み出すリモート仮想パス
 * @returns デコード済みテキスト
 * @throws サイズ超過・バイナリ・不正 UTF-8 の場合
 */
export async function readTextFile(target: unknown, path: unknown, encoding?: unknown): Promise<TextDocument> {
  assertConnectionTarget(target)
  assertRemoteFilePath(path)
  const readEncoding = resolveReadEncoding(encoding)
  const data = await createStorageProvider(target).read(path)
  return decodeTextDocument(data, readEncoding)
}

/**
 * テキストを UTF-8 でエンコードしてリモートファイルへ書き込む（上書き）。
 *
 * @param target 接続先設定（未検証値）
 * @param path 書き込み先のリモート仮想パス
 * @param text 書き込むテキスト
 * @throws テキストが文字列でない、またはサイズ上限を超える場合
 */
export async function writeTextFile(
  target: unknown,
  path: unknown,
  text: unknown,
  encoding?: unknown,
  bom?: unknown
): Promise<void> {
  assertConnectionTarget(target)
  assertRemoteFilePath(path)
  const textEncoding = resolveEncoding(encoding)
  if (typeof text !== 'string') throw new Error('Invalid text content.')
  const data = encodeTextDocument(text, textEncoding, Boolean(bom))
  await createStorageProvider(target).write(path, data)
}

/**
 * リモートの単一ファイルを削除する。
 *
 * @param target 接続先設定（未検証値）
 * @param path 削除するリモート仮想パス
 */
export async function deleteFile(target: unknown, path: unknown): Promise<void> {
  assertConnectionTarget(target)
  assertRemoteFilePath(path)
  await createStorageProvider(target).delete(path)
}
