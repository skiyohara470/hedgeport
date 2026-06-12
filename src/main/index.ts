import { join } from 'node:path'
import { homedir } from 'node:os'
import { readdir } from 'node:fs/promises'

import { app, BrowserWindow, ipcMain, shell } from 'electron'

const rendererUrl = process.env.ELECTRON_RENDERER_URL

function loadRenderer(window: BrowserWindow, route = ''): void {
  if (rendererUrl) {
    void window.loadURL(`${rendererUrl}${route}`)
    return
  }

  void window.loadFile(join(__dirname, '../renderer/index.html'), {
    hash: route.replace(/^#/, ''),
  })
}

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

app.whenReady().then(() => {
  ipcMain.on('preview:open', createPreviewWindow)
  ipcMain.handle('local:list', async (_event, requestedPath?: string) => {
    const path = requestedPath || homedir()
    const dirents = await readdir(path, { withFileTypes: true })
    const entries = dirents
      .map((dirent) => ({
        name: dirent.name,
        path: join(path, dirent.name),
        type: dirent.isDirectory() ? ('directory' as const) : ('file' as const),
      }))
      .sort((left, right) => {
        if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
        return left.name.localeCompare(right.name)
      })

    return {
      path,
      parentPath: path === homedir() ? null : join(path, '..'),
      entries,
    }
  })
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
