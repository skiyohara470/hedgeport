import { contextBridge, ipcRenderer } from 'electron'

import type { ConnectionTarget, S3BucketListRequest } from '../shared/connections'

/**
 * renderer へ公開する最小限の IPC API。
 * React 側は Node.js や ipcRenderer を直接触らず、この窓口だけを経由する。
 */
const api = {
  openPreview: (): void => {
    ipcRenderer.send('preview:open')
  },
  listLocal: (path?: string) => ipcRenderer.invoke('local:list', path),
  loadConnections: (): Promise<ConnectionTarget[]> => ipcRenderer.invoke('connections:load'),
  saveConnections: (targets: ConnectionTarget[]): Promise<void> => ipcRenderer.invoke('connections:save', targets),
  testConnection: (target: ConnectionTarget) => ipcRenderer.invoke('connections:test', target),
  listS3Buckets: (request: S3BucketListRequest): Promise<string[]> => ipcRenderer.invoke('s3:buckets', request),
  listStorage: (target: ConnectionTarget, path: string) => ipcRenderer.invoke('storage:list', target, path),
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
