import { contextBridge, ipcRenderer } from 'electron'

const api = {
  openPreview: (): void => {
    ipcRenderer.send('preview:open')
  },
  listLocal: (path?: string) => ipcRenderer.invoke('local:list', path),
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('hedgeport', api)
} else {
  window.hedgeport = api
}
