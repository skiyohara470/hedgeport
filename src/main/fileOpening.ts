import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { lstat, open, type FileHandle } from 'node:fs/promises'

import { BrowserWindow, dialog, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron'

import type { TextDocument } from '../shared/transfer'
import {
  decodeTextDocument,
  encodeTextDocument,
  resolveEncoding,
  resolveReadEncoding,
  type DecodeOptions,
} from './textCodec'

// O_NOFOLLOW があれば symlink を open 時点で弾く。未対応 OS（値が 0）では lstat/fstat identity で補う。
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
const NOFOLLOW_SUPPORTED = NOFOLLOW !== 0

/**
 * ローカル絶対パスを検証する。
 */
function assertLocalPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Invalid local path.')
}

/**
 * 既存の通常ファイルだけを開く（lstat→read/write の TOCTOU を回避）。
 *
 * O_NOFOLLOW が使える環境では open 時点で symlink を弾く。
 * 使えない環境（nofollowSupported=false）では open 前に lstat で symlink を弾き、
 * open 後に fstat の dev/ino を lstat と比較して「同じ inode を開いた」ことを検証する（途中差し替えを検出）。
 * いずれも最後に handle を fstat して通常ファイルであることを確認する。
 *
 * @param path 対象の絶対パス
 * @param flags open フラグ（O_RDONLY / O_WRONLY 等。O_CREAT は付けない＝存在必須）
 * @param nofollowSupported O_NOFOLLOW が有効か（テスト用に注入可能。既定は実行環境の値）
 * @returns 検証済み FileHandle（呼び出し側が close する）
 * @throws symlink / 不在 / 通常ファイルでない / 差し替え検出の場合
 */
export async function openVerifiedRegularFile(
  path: string,
  flags: number,
  nofollowSupported: boolean = NOFOLLOW_SUPPORTED
): Promise<FileHandle> {
  // O_NOFOLLOW 非対応時のフォールバック: open 前に lstat で symlink を弾き、identity 比較用に dev/ino を控える。
  let preStat: Awaited<ReturnType<typeof lstat>> | null = null
  if (!nofollowSupported) {
    try {
      preStat = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('File not found.')
      throw error
    }
    if (preStat.isSymbolicLink()) throw new Error('Symlinks cannot be edited as text.')
  }

  let handle: FileHandle
  try {
    handle = await open(path, flags | (nofollowSupported ? NOFOLLOW : 0))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP') throw new Error('Symlinks cannot be edited as text.')
    if (code === 'ENOENT') throw new Error('File not found.')
    throw error
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('Not a regular file.')
    // フォールバック時は open した inode が lstat と一致するか検証（差し替え検出）。
    if (preStat && (preStat.dev !== stat.dev || preStat.ino !== stat.ino)) {
      throw new Error('File changed during open.')
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
  return handle
}

/**
 * ローカルテキストファイルを読み出す（built-in editor / preview 用）。
 * symlink は不可、通常ファイルのみ。開いた handle 経由で読むため差し替え競合に耐える。
 *
 * @param path ローカル絶対パス
 * @param encoding 文字コード（未指定は utf-8）
 * @returns TextDocument
 */
export async function readLocalText(path: unknown, encoding?: unknown, options?: DecodeOptions): Promise<TextDocument> {
  assertLocalPath(path)
  const readEncoding = resolveReadEncoding(encoding)
  const handle = await openVerifiedRegularFile(path, fsConstants.O_RDONLY)
  try {
    const data = await handle.readFile()
    // サイズ上限は decode 前に判定する（プレビューは緩い上限を options で注入する）。
    return decodeTextDocument(new Uint8Array(data), readEncoding, options)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * ローカルテキストファイルへ書き込む（既存の通常ファイルのみ）。
 * open（O_NOFOLLOW, O_CREAT なし）→ fstat 確認 → truncate → write を同一 handle で行い、
 * symlink 差し替えや不在パスへの誤書き込みを防ぐ。
 *
 * @param path ローカル絶対パス
 * @param text 保存テキスト
 * @param encoding 文字コード（未指定は utf-8）
 * @param bom utf-8 BOM 付与有無
 */
export async function writeLocalText(path: unknown, text: unknown, encoding?: unknown, bom?: unknown): Promise<void> {
  assertLocalPath(path)
  if (typeof text !== 'string') throw new Error('Invalid text content.')
  // 表現不能 / サイズ超過は open（truncate）前に弾く。
  const data = encodeTextDocument(text, resolveEncoding(encoding), Boolean(bom))
  const handle = await openVerifiedRegularFile(path, fsConstants.O_WRONLY)
  try {
    await handle.truncate(0)
    await handle.writeFile(data)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * 選択したアプリでローカルファイルを開く（shell:false / 引数配列）。
 * spawn の 'error'（実行不可・不在）を監視し、起動確定まで待つ。失敗時は reject する。
 * macOS は `open -a` が即終了するため exit code で成否判定、Windows/Linux は spawn 成立を待って detach する。
 */
function launchWithApplication(applicationPath: string, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform === 'darwin') {
      const child = spawn('open', ['-a', applicationPath, filePath], { shell: false })
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.once('error', reject)
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(stderr.trim() || `Failed to open application (exit ${code}).`))
      )
    } else {
      const child = spawn(applicationPath, [filePath], { shell: false, detached: true, stdio: 'ignore' })
      child.once('error', reject)
      // 'spawn' で起動成立を確認してから親から切り離す。
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    }
  })
}

/**
 * アプリ選択ダイアログを開き、選んだアプリでローカルファイルを開く。
 * キャンセル時は null。起動失敗（実行不可・不在）は reject する。
 *
 * @param event 親ウィンドウ特定のための IPC イベント
 * @param filePath 開くローカルファイルの絶対パス
 * @returns 選択したアプリの絶対パス。キャンセルは null
 */
export async function chooseApplicationAndOpen(event: IpcMainInvokeEvent, filePath: unknown): Promise<string | null> {
  assertLocalPath(filePath)
  const parent = BrowserWindow.fromWebContents(event.sender)
  const options: OpenDialogOptions = { title: 'Choose Application', properties: ['openFile'] }
  // macOS は既定で /Applications を開き、.app バンドル（VS Code 等）をすぐ選べるようにする。
  // filter で .app のみに絞るが、.app は OS が単一ファイル扱いするため内部実行ファイルは選ばれない。
  // Windows / Linux は従来どおり（defaultPath / filter なし）。
  if (process.platform === 'darwin') {
    options.defaultPath = '/Applications'
    options.filters = [{ name: 'Applications', extensions: ['app'] }]
  }
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  const applicationPath = result.filePaths[0]
  if (!isAbsolute(applicationPath)) throw new Error('Invalid application path.')
  await launchWithApplication(applicationPath, filePath)
  return applicationPath
}
