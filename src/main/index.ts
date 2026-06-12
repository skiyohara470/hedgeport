import { join } from 'node:path'
import { homedir } from 'node:os'
import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'

import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import SftpClient from 'ssh2-sftp-client'

import type { ConnectionTarget, ConnectionTestResult } from '../shared/connections'

const rendererUrl = process.env.ELECTRON_RENDERER_URL
const connectionsFileName = 'connections.json'

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isConnectionTarget(value: unknown): value is ConnectionTarget {
  if (!value || typeof value !== 'object') return false
  const target = value as Record<string, unknown>
  if (!isString(target.id) || !isString(target.name)) return false

  if (target.kind === 'sftp') {
    return (
      isString(target.host) &&
      typeof target.port === 'number' &&
      isString(target.username) &&
      isString(target.password) &&
      isString(target.rootPath)
    )
  }

  if (target.kind === 's3') {
    return (
      isString(target.region) &&
      isString(target.bucket) &&
      isString(target.prefix) &&
      isString(target.accessKeyId) &&
      isString(target.secretAccessKey) &&
      isString(target.sessionToken)
    )
  }

  return false
}

function connectionsFilePath(): string {
  return join(app.getPath('userData'), connectionsFileName)
}

async function loadConnections(): Promise<ConnectionTarget[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(connectionsFilePath(), 'utf8'))
    if (!Array.isArray(parsed) || !parsed.every(isConnectionTarget)) {
      throw new Error('Connections file has an invalid format.')
    }
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function saveConnections(targets: ConnectionTarget[]): Promise<void> {
  if (!targets.every(isConnectionTarget)) throw new Error('Invalid connection settings.')

  const directory = app.getPath('userData')
  const destination = connectionsFilePath()
  const temporary = `${destination}.tmp`
  await mkdir(directory, { recursive: true })
  await writeFile(temporary, `${JSON.stringify(targets, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, destination)
  await chmod(destination, 0o600)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function testConnection(target: ConnectionTarget): Promise<ConnectionTestResult> {
  if (!isConnectionTarget(target)) return { ok: false, message: 'Invalid connection settings.' }

  try {
    if (target.kind === 'sftp') {
      const client = new SftpClient('hedgeport-connection-test')
      try {
        await client.connect({
          host: target.host,
          port: target.port,
          username: target.username,
          password: target.password || undefined,
          readyTimeout: 10_000,
        })
        await client.list(target.rootPath)
      } finally {
        await client.end().catch(() => undefined)
      }
      return { ok: true, message: `Connected to ${target.host}:${target.port}.` }
    }

    const credentials = {
      accessKeyId: target.accessKeyId,
      secretAccessKey: target.secretAccessKey,
      ...(target.sessionToken ? { sessionToken: target.sessionToken } : {}),
    }
    const client = new S3Client({
      region: target.region,
      credentials,
      requestHandler: {
        requestTimeout: 10_000,
        connectionTimeout: 10_000,
      },
    })
    try {
      await client.send(new HeadBucketCommand({ Bucket: target.bucket }))
    } finally {
      client.destroy()
    }
    return { ok: true, message: `Connected to s3://${target.bucket}.` }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

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
  ipcMain.handle('connections:load', loadConnections)
  ipcMain.handle('connections:save', (_event, targets: ConnectionTarget[]) => saveConnections(targets))
  ipcMain.handle('connections:test', (_event, target: ConnectionTarget) => testConnection(target))
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
