import type {
  ConnectionTarget,
  ConnectionTestResult,
  S3BucketListRequest,
} from '../../shared/connections'
import type { StorageEntry } from '../../shared/storage'

declare global {
  /**
   * preload が window へ公開する renderer 用 API 契約。
   * UI は main process の機能をこの窓口経由でだけ利用する。
   */
  interface HedgePortApi {
    openPreview: () => void
    listLocal: (path?: string) => Promise<LocalDirectory>
    loadConnections: () => Promise<ConnectionTarget[]>
    saveConnections: (targets: ConnectionTarget[]) => Promise<void>
    testConnection: (target: ConnectionTarget) => Promise<ConnectionTestResult>
    listS3Buckets: (request: S3BucketListRequest) => Promise<string[]>
    listStorage: (target: ConnectionTarget, path: string) => Promise<StorageEntry[]>
  }

  /**
   * ローカルファイルペインが受け取るディレクトリ一覧結果。
   */
  interface LocalDirectory {
    path: string
    parentPath: string | null
    entries: LocalEntry[]
  }

  /**
   * ローカル一覧に表示する 1 エントリ。
   */
  interface LocalEntry {
    name: string
    path: string
    type: 'file' | 'directory'
    size?: number
    modifiedAt?: string
  }

  /**
   * preload が公開した API を renderer の window 型へ追加する。
   */
  interface Window {
    hedgeport: HedgePortApi
  }
}

export {}
