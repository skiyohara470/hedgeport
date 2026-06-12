import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'

import { isConnectionTarget, loadConnections, saveConnections } from './connectionStore'
import { listS3Buckets, testConnection } from './connectionTesting'
import { listLocalEntries } from './localFileListing'
import { createStorageProvider } from './providers/createStorageProvider'
import type { ConnectionTarget, S3BucketListRequest } from '../shared/connections'

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
