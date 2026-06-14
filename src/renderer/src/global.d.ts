import type { ConnectionTarget, ConnectionTestResult } from '../../shared/connections'
import type { AppSettings } from '../../shared/settings'
import type { StorageEntry, StorageEntryType } from '../../shared/storage'
import type {
  BatchItem,
  BatchOperationResult,
  ExternalEditSession,
  OpenMode,
  PasteRequest,
  ReadEncoding,
  TextDocument,
  TextEncoding,
} from '../../shared/transfer'

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
    loadSettings: () => Promise<AppSettings>
    saveSettings: (settings: AppSettings) => Promise<AppSettings>
    listStorage: (target: ConnectionTarget, path: string) => Promise<StorageEntry[]>
    downloadFile: (target: ConnectionTarget, remotePath: string, localPath: string) => Promise<void>
    uploadFile: (target: ConnectionTarget, localPath: string, remotePath: string) => Promise<void>
    readText: (target: ConnectionTarget, path: string, encoding?: ReadEncoding) => Promise<TextDocument>
    writeText: (
      target: ConnectionTarget,
      path: string,
      text: string,
      encoding?: TextEncoding,
      bom?: boolean
    ) => Promise<void>
    deleteFile: (target: ConnectionTarget, path: string) => Promise<void>
    downloadToDirectory: (target: ConnectionTarget, remotePath: string, localDirectory: string) => Promise<void>
    pickDirectory: () => Promise<string | null>
    createRemoteDirectory: (target: ConnectionTarget, parentPath: string, name: string) => Promise<void>
    renameRemote: (
      target: ConnectionTarget,
      sourcePath: string,
      newName: string,
      entryType: StorageEntryType
    ) => Promise<void>
    createLocalDirectory: (parentPath: string, name: string) => Promise<void>
    renameLocal: (sourcePath: string, newName: string, entryType: StorageEntryType) => Promise<void>
    batchDeleteRemote: (target: ConnectionTarget, items: BatchItem[]) => Promise<BatchOperationResult>
    batchDeleteLocal: (items: BatchItem[]) => Promise<BatchOperationResult>
    batchDownload: (
      target: ConnectionTarget,
      remotePaths: string[],
      localDirectory: string
    ) => Promise<BatchOperationResult>
    batchUpload: (
      target: ConnectionTarget,
      localPaths: string[],
      remoteDirectory: string
    ) => Promise<BatchOperationResult>
    paste: (request: PasteRequest) => Promise<BatchOperationResult>
    openLocalPath: (path: string) => Promise<void>
    revealInFolder: (path: string) => Promise<void>
    readLocalText: (path: string, encoding?: ReadEncoding) => Promise<TextDocument>
    writeLocalText: (path: string, text: string, encoding?: TextEncoding, bom?: boolean) => Promise<void>
    chooseApplication: (filePath: string) => Promise<string | null>
    startExternalEdit: (
      target: ConnectionTarget,
      remotePath: string,
      mode: OpenMode
    ) => Promise<ExternalEditSession | null>
    uploadExternalEdit: (sessionId: string) => Promise<void>
    discardExternalEdit: (sessionId: string) => Promise<void>
    revealExternalEdit: (sessionId: string) => Promise<void>
    listExternalSessions: () => Promise<ExternalEditSession[]>
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
