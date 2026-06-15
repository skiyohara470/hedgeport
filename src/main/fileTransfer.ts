import { isAbsolute, join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'

import type { ConnectionTarget } from '../shared/connections'
import type { TextDocument } from '../shared/transfer'
import { computeContentRevision } from './contentRevision'
import { isConnectionTarget } from './connectionStore'
import { createStorageProvider } from './providers/createStorageProvider'
import { basenameVirtual, isCanonicalVirtualEntryPath } from './providers/pathUtils'
import {
  decodeTextDocument,
  encodeTextDocument,
  resolveEncoding,
  resolveReadEncoding,
  type DecodeOptions,
} from './textCodec'

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
export async function readTextFile(
  target: unknown,
  path: unknown,
  encoding?: unknown,
  options?: DecodeOptions
): Promise<TextDocument> {
  return (await readRemoteTextWithRevision(target, path, encoding, options)).document
}

/**
 * リモートファイルをテキストとして読み出し、内容リビジョンも併せて返す。
 * プレビュー編集が「読込時点の内容」を main 側で覚えるために使う。1 回の read で
 * document（表示用デコード結果）と revision（生バイト列のハッシュ）を同時に得る。
 *
 * @param target 接続先設定（未検証値）
 * @param path 読み出すリモート仮想パス
 * @param encoding 文字コード（'auto' / concrete）
 * @param options decode のサイズ上限・超過メッセージ（プレビューは緩い上限を注入する）
 * @returns デコード済みテキスト・内容リビジョン・生バイト長
 * @throws サイズ超過・バイナリ・不正 UTF-8 の場合
 */
export async function readRemoteTextWithRevision(
  target: unknown,
  path: unknown,
  encoding?: unknown,
  options?: DecodeOptions
): Promise<{ document: TextDocument; revision: string; byteLength: number }> {
  assertConnectionTarget(target)
  assertRemoteFilePath(path)
  const readEncoding = resolveReadEncoding(encoding)
  const data = await createStorageProvider(target).read(path)
  // revision は生バイト列から算出する（decode/encoding に依存しない）。
  const revision = computeContentRevision(data)
  // サイズ上限は decode 前に判定する（プレビューは緩い上限を options で注入する）。
  return { document: decodeTextDocument(data, readEncoding, options), revision, byteLength: data.byteLength }
}

/**
 * リモートファイルの現在の内容リビジョンだけを取得する（保存直前の競合検知用）。
 * decode しないため、保存対象が編集上限を超えるサイズへ膨らんでいても判定でき、バイナリ判定でも落ちない。
 *
 * @param target 接続先設定（未検証値）
 * @param path 対象のリモート仮想パス
 * @returns 現在の内容リビジョン
 */
export async function readRemoteRevision(target: unknown, path: unknown): Promise<string> {
  assertConnectionTarget(target)
  assertRemoteFilePath(path)
  return computeContentRevision(await createStorageProvider(target).read(path))
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
 * テキストをリモートファイルへ書き込み、書き込んだ内容のリビジョンを返す。
 * プレビュー編集の保存後にセッションの基準リビジョンを更新するため、書き込んだバイト列から
 * そのまま revision を算出する（書き込み直後の再読込を増やさない）。サイズ上限は encode 側で判定する。
 *
 * @param target 接続先設定（未検証値）
 * @param path 書き込み先のリモート仮想パス
 * @param text 書き込むテキスト
 * @param encoding 文字コード（未指定は utf-8）
 * @param bom utf-8 BOM 付与有無
 * @returns 書き込んだ内容のリビジョンと実際に書き込んだバイト長
 * @throws テキストが文字列でない、表現不能文字、編集サイズ上限超過の場合
 */
export async function writeRemoteTextWithRevision(
  target: unknown,
  path: unknown,
  text: unknown,
  encoding?: unknown,
  bom?: unknown
): Promise<{ revision: string; byteLength: number }> {
  assertConnectionTarget(target)
  assertRemoteFilePath(path)
  const textEncoding = resolveEncoding(encoding)
  if (typeof text !== 'string') throw new Error('Invalid text content.')
  const data = encodeTextDocument(text, textEncoding, Boolean(bom))
  await createStorageProvider(target).write(path, data)
  return { revision: computeContentRevision(data), byteLength: data.byteLength }
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
