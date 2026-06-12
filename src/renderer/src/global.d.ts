import type { ConnectionTarget, ConnectionTestResult } from '../../shared/connections'

declare global {
  interface HedgePortApi {
    openPreview: () => void
    listLocal: (path?: string) => Promise<LocalDirectory>
    loadConnections: () => Promise<ConnectionTarget[]>
    saveConnections: (targets: ConnectionTarget[]) => Promise<void>
    testConnection: (target: ConnectionTarget) => Promise<ConnectionTestResult>
  }

  interface LocalDirectory {
    path: string
    parentPath: string | null
    entries: LocalEntry[]
  }

  interface LocalEntry {
    name: string
    path: string
    type: 'file' | 'directory'
  }

  interface Window {
    hedgeport: HedgePortApi
  }
}

export {}
