import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type { ConnectionTarget } from '../shared/connections'
import { isHistoryDirection, type HistoryDirection } from '../shared/navigation'
import type { PreviewDocument, PreviewMeta, PreviewOpenRequest } from '../shared/preview'
import type { AppSettings } from '../shared/settings'
import type { StorageEntryType } from '../shared/storage'
import type {
  BatchItem,
  BatchOperationResult,
  ExternalEditSession,
  OpenMode,
  PasteRequest,
  ReadEncoding,
  TextDocument,
  TextEncoding,
} from '../shared/transfer'

/**
 * renderer へ公開する最小限の IPC API。
 * React 側は Node.js や ipcRenderer を直接触らず、この窓口だけを経由する。
 */
const api = {
  // プレビューウィンドウを開く。失敗（不正要求・描画ロード失敗等）は reject で renderer へ返す。
  openPreview: (request: PreviewOpenRequest): Promise<void> => ipcRenderer.invoke('preview:open', request),
  // プレビューウィンドウ自身のセッションのメタ情報（name/path/source）。内容ロードと独立に取得できる。
  previewMetadata: (): Promise<PreviewMeta> => ipcRenderer.invoke('preview:metadata'),
  // プレビューウィンドウ自身のセッションを読む。送信元に束縛され、target/secret は返らない。
  loadPreview: (encoding?: ReadEncoding): Promise<PreviewDocument> => ipcRenderer.invoke('preview:load', encoding),
  listLocal: (path?: string) => ipcRenderer.invoke('local:list', path),
  loadConnections: (): Promise<ConnectionTarget[]> => ipcRenderer.invoke('connections:load'),
  saveConnections: (targets: ConnectionTarget[]): Promise<void> => ipcRenderer.invoke('connections:save', targets),
  testConnection: (target: ConnectionTarget) => ipcRenderer.invoke('connections:test', target),
  loadSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings: AppSettings): Promise<AppSettings> => ipcRenderer.invoke('settings:save', settings),
  // マウス戻る/進む（main で捕捉）を購読する。direction だけを renderer へ渡し、解除関数を返す。
  onHistoryNavigation: (listener: (direction: HistoryDirection) => void): (() => void) => {
    // 不正な IPC ペイロードを listener へ渡さない（back/forward 以外は破棄）。
    const handler = (_event: IpcRendererEvent, direction: unknown): void => {
      if (isHistoryDirection(direction)) listener(direction)
    }
    ipcRenderer.on('history:navigate', handler)
    return () => ipcRenderer.removeListener('history:navigate', handler)
  },
  listStorage: (target: ConnectionTarget, path: string) => ipcRenderer.invoke('storage:list', target, path),
  downloadFile: (target: ConnectionTarget, remotePath: string, localPath: string): Promise<void> =>
    ipcRenderer.invoke('storage:download', target, remotePath, localPath),
  uploadFile: (target: ConnectionTarget, localPath: string, remotePath: string): Promise<void> =>
    ipcRenderer.invoke('storage:upload', target, localPath, remotePath),
  readText: (target: ConnectionTarget, path: string, encoding?: ReadEncoding): Promise<TextDocument> =>
    ipcRenderer.invoke('storage:read-text', target, path, encoding),
  writeText: (
    target: ConnectionTarget,
    path: string,
    text: string,
    encoding?: TextEncoding,
    bom?: boolean
  ): Promise<void> => ipcRenderer.invoke('storage:write-text', target, path, text, encoding, bom),
  deleteFile: (target: ConnectionTarget, path: string): Promise<void> =>
    ipcRenderer.invoke('storage:delete', target, path),
  downloadToDirectory: (target: ConnectionTarget, remotePath: string, localDirectory: string): Promise<void> =>
    ipcRenderer.invoke('storage:download-to-directory', target, remotePath, localDirectory),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-directory'),
  createRemoteDirectory: (target: ConnectionTarget, parentPath: string, name: string): Promise<void> =>
    ipcRenderer.invoke('storage:create-directory', target, parentPath, name),
  renameRemote: (
    target: ConnectionTarget,
    sourcePath: string,
    newName: string,
    entryType: StorageEntryType
  ): Promise<void> => ipcRenderer.invoke('storage:rename', target, sourcePath, newName, entryType),
  createLocalDirectory: (parentPath: string, name: string): Promise<void> =>
    ipcRenderer.invoke('local:create-directory', parentPath, name),
  renameLocal: (sourcePath: string, newName: string, entryType: StorageEntryType): Promise<void> =>
    ipcRenderer.invoke('local:rename', sourcePath, newName, entryType),
  batchDeleteRemote: (target: ConnectionTarget, items: BatchItem[]): Promise<BatchOperationResult> =>
    ipcRenderer.invoke('storage:batch-delete', target, items),
  batchDeleteLocal: (items: BatchItem[]): Promise<BatchOperationResult> =>
    ipcRenderer.invoke('local:batch-delete', items),
  batchDownload: (
    target: ConnectionTarget,
    remotePaths: string[],
    localDirectory: string
  ): Promise<BatchOperationResult> => ipcRenderer.invoke('storage:batch-download', target, remotePaths, localDirectory),
  batchUpload: (
    target: ConnectionTarget,
    localPaths: string[],
    remoteDirectory: string
  ): Promise<BatchOperationResult> => ipcRenderer.invoke('storage:batch-upload', target, localPaths, remoteDirectory),
  paste: (request: PasteRequest): Promise<BatchOperationResult> => ipcRenderer.invoke('clipboard:paste', request),
  openLocalPath: (path: string): Promise<void> => ipcRenderer.invoke('local:open-path', path),
  revealInFolder: (path: string): Promise<void> => ipcRenderer.invoke('local:reveal', path),
  readLocalText: (path: string, encoding?: ReadEncoding): Promise<TextDocument> =>
    ipcRenderer.invoke('local:read-text', path, encoding),
  writeLocalText: (path: string, text: string, encoding?: TextEncoding, bom?: boolean): Promise<void> =>
    ipcRenderer.invoke('local:write-text', path, text, encoding, bom),
  chooseApplication: (filePath: string): Promise<string | null> => ipcRenderer.invoke('local:open-with', filePath),
  startExternalEdit: (
    target: ConnectionTarget,
    remotePath: string,
    mode: OpenMode
  ): Promise<ExternalEditSession | null> => ipcRenderer.invoke('external:open', target, remotePath, mode),
  uploadExternalEdit: (sessionId: string): Promise<void> => ipcRenderer.invoke('external:upload', sessionId),
  discardExternalEdit: (sessionId: string): Promise<void> => ipcRenderer.invoke('external:discard', sessionId),
  revealExternalEdit: (sessionId: string): Promise<void> => ipcRenderer.invoke('external:reveal', sessionId),
  listExternalSessions: (): Promise<ExternalEditSession[]> => ipcRenderer.invoke('external:list'),
}

if (process.contextIsolated) {
  /**
   * contextIsolation 有効時は contextBridge 経由で安全に window へ公開する。
   */
  contextBridge.exposeInMainWorld('hedgeport', api)
} else {
  /**
   * contextIsolation を使わない開発・検証向けのフォールバック。
   */
  window.hedgeport = api
}
