import { contextBridge, ipcRenderer } from 'electron'

import type { ConnectionTarget } from '../shared/connections'

const api = {
  openPreview: (): void => {
    ipcRenderer.send('preview:open')
  },
  listLocal: (path?: string) => ipcRenderer.invoke('local:list', path),
  loadConnections: (): Promise<ConnectionTarget[]> => ipcRenderer.invoke('connections:load'),
  saveConnections: (targets: ConnectionTarget[]): Promise<void> => ipcRenderer.invoke('connections:save', targets),
  testConnection: (target: ConnectionTarget) => ipcRenderer.invoke('connections:test', target),
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('hedgeport', api)
} else {
  window.hedgeport = api
}
