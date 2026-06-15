import { isAbsolute, join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'

import { batchDeleteLocal, batchDeleteRemote, batchDownloadToDirectory, batchUpload } from './batchOperations'
import { pasteEntries } from './clipboard'
import {
  cleanupAllExternalEdits,
  discardExternalEdit,
  listExternalEditSessions,
  revealExternalEdit,
  startExternalEdit,
  uploadExternalEdit,
} from './externalEdit'
import { chooseApplicationAndOpen, readLocalText, writeLocalText } from './fileOpening'
import { isConnectionTarget, loadConnections, saveConnections } from './connectionStore'
import { testConnection } from './connectionTesting'
import { pickDirectory } from './dialogs'
import { handleAppCommand, handleSwipe } from './navigationInput'
import {
  createPreviewSessionStore,
  handlePreviewLoad,
  handlePreviewMeta,
  openPreviewSession,
  type PreviewReaders,
  type PreviewWindowHandle,
} from './previewSession'
import { loadSettings, saveSettings } from './settingsStore'
import type { HistoryDirection } from '../shared/navigation'
import { deleteFile, downloadFile, downloadToDirectory, readTextFile, uploadFile, writeTextFile } from './fileTransfer'
import { listLocalEntries } from './localFileListing'
import { createStorageProvider } from './providers/createStorageProvider'
import { createLocalDirectory, createRemoteDirectory, renameLocal, renameRemote } from './storageMutations'
import type { ConnectionTarget } from '../shared/connections'
import type { StorageEntryType } from '../shared/storage'
import {
  MAX_PREVIEW_TEXT_BYTES,
  type BatchItem,
  type OpenMode,
  type PasteRequest,
  type ReadEncoding,
  type TextEncoding,
} from '../shared/transfer'

const rendererUrl = process.env.ELECTRON_RENDERER_URL

/**
 * renderer のエントリを読み込む。
 * 開発中は Vite dev server、本番ビルドでは生成済み index.html を使う。
 *
 * @param window 描画先の BrowserWindow
 * @param route hash ルーティング用の画面識別子
 */
function loadRenderer(window: BrowserWindow, route = ''): Promise<void> {
  if (rendererUrl) {
    return window.loadURL(`${rendererUrl}${route}`)
  }

  // build 後は hash route を index.html に渡して renderer 側の画面を切り替える。
  return window.loadFile(join(__dirname, '../renderer/index.html'), {
    hash: route.replace(/^#/, ''),
  })
}

/**
 * 通常操作用のメインウィンドウを生成する。
 * 外部リンクはアプリ内で開かず、OS 既定ブラウザへ委譲する。
 */
function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'HedgePort',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
    },
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // マウス戻る/進む（Win/Linux app-command）と macOS トラックパッド swipe を、
  // メインウィンドウでのみ捕捉して renderer のディレクトリ履歴移動へ橋渡しする。
  // Chromium 既定のページ履歴移動は抑止し、1 入力 = 1 ディレクトリ遷移にする。
  const sendNavigation = (direction: HistoryDirection): void => window.webContents.send('history:navigate', direction)
  // app-command / swipe は BrowserWindow（BaseWindow）のイベント。
  window.on('app-command', (event, command) => {
    handleAppCommand(command, { preventDefault: () => event.preventDefault(), send: sendNavigation })
  })
  window.on('swipe', (_event, direction) => {
    handleSwipe(direction, sendNavigation)
  })

  void loadRenderer(window)
}

// プレビューセッション。送信元ウィンドウ（webContents.id）へ束縛して main 側で保持する。
// renderer へは任意 path/target/session id を指定させず、event.sender に紐づくセッションだけ読める。
const previewSessions = createPreviewSessionStore()
// プレビューは編集（1 MiB）より緩い専用上限（20 MiB）を使う。上限超過は preview 用文言で返す。
// 既存の検証付き reader（path/target/NUL/encoding 検証・local の symlink/TOCTOU 保護）を再利用し、
// 上限と超過メッセージだけを注入する（重複実装しない）。
const previewDecodeOptions = {
  maxBytes: MAX_PREVIEW_TEXT_BYTES,
  tooLargeMessage: `File is too large to preview (limit ${MAX_PREVIEW_TEXT_BYTES / (1024 * 1024)} MiB).`,
}
const previewReaders: PreviewReaders = {
  readRemote: (target, path, encoding) => readTextFile(target, path, encoding, previewDecodeOptions),
  readLocal: (path, encoding) => readLocalText(path, encoding, previewDecodeOptions),
}

/**
 * プレビュー表示専用のサブウィンドウを生成し、要求をセッションとして束縛する。
 * 認証情報やローカル絶対パスは URL/hash/query へ載せず、main 管理セッション越しに読む。
 * 描画ロードを await し、失敗時は session 削除 + window 破棄してから reject する（残骸を残さない）。
 * window close / レンダラプロセス消失でもセッションを確実に破棄する。
 * ライフサイクルの本体は previewSession.openPreviewSession（electron 非依存・テスト可能）にあり、
 * ここでは BrowserWindow の生成と各操作の橋渡しだけを行う。
 *
 * @param request 検証前の open 要求（renderer 由来）
 * @returns 描画ロード完了で解決する Promise（invoke 経由で renderer へ成否を返す）
 */
function openPreviewWindow(request: unknown): Promise<void> {
  return openPreviewSession(request, previewSessions, (validated): PreviewWindowHandle => {
    const previewWindow = new BrowserWindow({
      width: 840,
      height: 640,
      minWidth: 560,
      minHeight: 400,
      // タイトルにファイル名を含める（表示用。シェル等の危険な用途へは使わない）。
      title: `${validated.name} — HedgePort Preview`,
      webPreferences: {
        preload: join(__dirname, '../preload/index.mjs'),
        sandbox: false,
      },
    })
    return {
      id: previewWindow.webContents.id,
      loadContent: () => loadRenderer(previewWindow, '#preview'),
      destroy: () => previewWindow.destroy(),
      onClosed: (callback) => {
        previewWindow.on('closed', callback)
      },
      onRenderProcessGone: (callback) => {
        previewWindow.webContents.on('render-process-gone', callback)
      },
    }
  })
}

/**
 * Electron 初期化後に IPC とウィンドウ生成を登録する。
 * main process はここを起点に renderer からの要求を各サービスへ中継する。
 */
app.whenReady().then(() => {
  // プレビュー: open は要求を検証して新ウィンドウを生成（失敗は invoke で renderer へ返す）。
  // load は送信元ウィンドウに束縛されたセッションだけを読める（メインウィンドウからの load は拒否）。
  ipcMain.handle('preview:open', (_event, request: unknown) => openPreviewWindow(request))
  ipcMain.handle('preview:metadata', (event) => handlePreviewMeta(previewSessions, event.sender.id))
  ipcMain.handle('preview:load', (event, encoding?: ReadEncoding) =>
    handlePreviewLoad(previewSessions, event.sender.id, encoding, previewReaders)
  )
  ipcMain.handle('connections:load', loadConnections)
  ipcMain.handle('connections:save', (_event, targets: ConnectionTarget[]) => saveConnections(targets))
  ipcMain.handle('connections:test', (_event, target: ConnectionTarget) => testConnection(target))
  // アプリ設定のロード / 保存（全体置換、main 側で再検証・正規化）。
  ipcMain.handle('settings:load', () => loadSettings())
  ipcMain.handle('settings:save', (_event, settings: unknown) => saveSettings(settings))
  ipcMain.handle('storage:list', async (_event, target: ConnectionTarget, path: string) => {
    if (!isConnectionTarget(target)) throw new Error('Invalid connection settings.')
    return createStorageProvider(target).list(path)
  })
  ipcMain.handle('local:list', (_event, requestedPath?: string) => listLocalEntries(requestedPath))
  // 単一ファイル操作。バイト列は main 内で完結させ、renderer IPC へ往復させない。
  ipcMain.handle('storage:download', (_event, target: ConnectionTarget, remotePath: string, localPath: string) =>
    downloadFile(target, remotePath, localPath)
  )
  ipcMain.handle('storage:upload', (_event, target: ConnectionTarget, localPath: string, remotePath: string) =>
    uploadFile(target, localPath, remotePath)
  )
  ipcMain.handle('storage:read-text', (_event, target: ConnectionTarget, path: string, encoding?: ReadEncoding) =>
    readTextFile(target, path, encoding)
  )
  ipcMain.handle(
    'storage:write-text',
    (_event, target: ConnectionTarget, path: string, text: string, encoding?: TextEncoding, bom?: boolean) =>
      writeTextFile(target, path, text, encoding, bom)
  )
  ipcMain.handle('storage:delete', (_event, target: ConnectionTarget, path: string) => deleteFile(target, path))
  ipcMain.handle(
    'storage:download-to-directory',
    (_event, target: ConnectionTarget, remotePath: string, localDirectory: string) =>
      downloadToDirectory(target, remotePath, localDirectory)
  )
  // ディレクトリ作成 / リネーム（remote / local）。バイト列を扱わない構造操作。
  ipcMain.handle('storage:create-directory', (_event, target: ConnectionTarget, parentPath: string, name: string) =>
    createRemoteDirectory(target, parentPath, name)
  )
  ipcMain.handle(
    'storage:rename',
    (_event, target: ConnectionTarget, sourcePath: string, newName: string, entryType: StorageEntryType) =>
      renameRemote(target, sourcePath, newName, entryType)
  )
  ipcMain.handle('local:create-directory', (_event, parentPath: string, name: string) =>
    createLocalDirectory(parentPath, name)
  )
  ipcMain.handle('local:rename', (_event, sourcePath: string, newName: string, entryType: StorageEntryType) =>
    renameLocal(sourcePath, newName, entryType)
  )
  // 保存先ディレクトリ選択ダイアログ（親ウィンドウ特定のため event を渡す）。
  ipcMain.handle('dialog:pick-directory', (event) => pickDirectory(event))
  // バッチ操作（複数選択）。renderer から 1 回の IPC で受け、main 内で逐次処理する。
  ipcMain.handle('storage:batch-delete', (_event, target: ConnectionTarget, items: BatchItem[]) =>
    batchDeleteRemote(target, items)
  )
  ipcMain.handle('local:batch-delete', (_event, items: BatchItem[]) => batchDeleteLocal(items))
  ipcMain.handle(
    'storage:batch-download',
    (_event, target: ConnectionTarget, remotePaths: string[], localDirectory: string) =>
      batchDownloadToDirectory(target, remotePaths, localDirectory)
  )
  ipcMain.handle(
    'storage:batch-upload',
    (_event, target: ConnectionTarget, localPaths: string[], remoteDirectory: string) =>
      batchUpload(target, localPaths, remoteDirectory)
  )
  // アプリ内クリップボードの貼り付け（remote/local 4 組合せ）。
  ipcMain.handle('clipboard:paste', (_event, request: PasteRequest) => pasteEntries(request))
  // ローカルファイル / ディレクトリを OS 既定アプリで開く。openPath は失敗時に非空文字列を返すので例外化する。
  ipcMain.handle('local:open-path', async (_event, path: string) => {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Invalid local path.')
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })
  // ローカルエントリを Finder / Explorer / File Manager で表示する。
  ipcMain.handle('local:reveal', (_event, path: string) => {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Invalid local path.')
    shell.showItemInFolder(path)
  })
  // ローカルテキストの読み書き（built-in editor / preview 用）と、アプリ選択起動。
  ipcMain.handle('local:read-text', (_event, path: string, encoding?: ReadEncoding) => readLocalText(path, encoding))
  ipcMain.handle('local:write-text', (_event, path: string, text: string, encoding?: TextEncoding, bom?: boolean) =>
    writeLocalText(path, text, encoding, bom)
  )
  ipcMain.handle('local:open-with', (event, filePath: string) => chooseApplicationAndOpen(event, filePath))
  // リモート外部編集セッション（temp へ download → 外部アプリ起動 → 明示 Upload/Discard）。
  ipcMain.handle('external:open', (event, target: ConnectionTarget, remotePath: string, mode: OpenMode) =>
    startExternalEdit(event, target, remotePath, mode)
  )
  ipcMain.handle('external:upload', (_event, sessionId: string) => uploadExternalEdit(sessionId))
  ipcMain.handle('external:discard', (_event, sessionId: string) => discardExternalEdit(sessionId))
  ipcMain.handle('external:reveal', (_event, sessionId: string) => revealExternalEdit(sessionId))
  ipcMain.handle('external:list', () => listExternalEditSessions())
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

/**
 * macOS 以外では最後のウィンドウが閉じられた時点でアプリを終了する。
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * 終了時に外部編集の temp を await して片付ける。
 * 一度だけ quit を保留し、cleanup 完了後に再 quit する（再帰しないよう guard）。失敗は非致命。
 */
let externalEditCleanupDone = false
app.on('will-quit', (event) => {
  if (externalEditCleanupDone) return
  event.preventDefault()
  void cleanupAllExternalEdits().finally(() => {
    externalEditCleanupDone = true
    app.quit()
  })
})
