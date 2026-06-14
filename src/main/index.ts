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
import { listS3Buckets, testConnection } from './connectionTesting'
import { pickDirectory } from './dialogs'
import { deleteFile, downloadFile, downloadToDirectory, readTextFile, uploadFile, writeTextFile } from './fileTransfer'
import { listLocalEntries } from './localFileListing'
import { createStorageProvider } from './providers/createStorageProvider'
import { createLocalDirectory, createRemoteDirectory, renameLocal, renameRemote } from './storageMutations'
import type { ConnectionTarget, S3BucketListRequest } from '../shared/connections'
import type { StorageEntryType } from '../shared/storage'
import type { BatchItem, OpenMode, PasteRequest, TextEncoding } from '../shared/transfer'

const rendererUrl = process.env.ELECTRON_RENDERER_URL

/**
 * renderer のエントリを読み込む。
 * 開発中は Vite dev server、本番ビルドでは生成済み index.html を使う。
 *
 * @param window 描画先の BrowserWindow
 * @param route hash ルーティング用の画面識別子
 */
function loadRenderer(window: BrowserWindow, route = ''): void {
  if (rendererUrl) {
    void window.loadURL(`${rendererUrl}${route}`)
    return
  }

  // build 後は hash route を index.html に渡して renderer 側の画面を切り替える。
  void window.loadFile(join(__dirname, '../renderer/index.html'), {
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

  loadRenderer(window)
}

/**
 * プレビュー表示専用のサブウィンドウを生成する。
 * renderer 側では #preview ルートを見て専用画面へ切り替える。
 */
function createPreviewWindow(): void {
  const previewWindow = new BrowserWindow({
    width: 840,
    height: 640,
    minWidth: 560,
    minHeight: 400,
    title: 'HedgePort Preview',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
    },
  })

  loadRenderer(previewWindow, '#preview')
}

/**
 * Electron 初期化後に IPC とウィンドウ生成を登録する。
 * main process はここを起点に renderer からの要求を各サービスへ中継する。
 */
app.whenReady().then(() => {
  ipcMain.on('preview:open', createPreviewWindow)
  ipcMain.handle('connections:load', loadConnections)
  ipcMain.handle('connections:save', (_event, targets: ConnectionTarget[]) => saveConnections(targets))
  ipcMain.handle('connections:test', (_event, target: ConnectionTarget) => testConnection(target))
  ipcMain.handle('s3:buckets', (_event, request: S3BucketListRequest) => listS3Buckets(request))
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
  ipcMain.handle('storage:read-text', (_event, target: ConnectionTarget, path: string, encoding?: TextEncoding) =>
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
  ipcMain.handle('local:read-text', (_event, path: string, encoding?: TextEncoding) => readLocalText(path, encoding))
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
