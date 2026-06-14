/**
 * 単一ファイル転送・テキスト編集・削除の IPC で受け渡す要求契約。
 * 実装ではなく層をまたぐデータ形状だけをここへ置く。
 */
import type { ConnectionTarget } from './connections'
import type { StorageEntryType } from './storage'

/**
 * テキスト編集モードで扱える最大バイト数（1 MiB）。
 * main 側の安全上限であり、renderer もこの値を使って事前案内できる。
 */
export const MAX_EDITABLE_TEXT_BYTES = 1024 * 1024

/**
 * テキスト編集で扱える文字コード。
 */
export type TextEncoding = 'utf-8' | 'shift_jis' | 'euc-jp'

/**
 * 選択可能な文字コード一覧（UI の select 順 / main の検証に使う）。
 */
export const TEXT_ENCODINGS: TextEncoding[] = ['utf-8', 'shift_jis', 'euc-jp']

/**
 * テキスト読み出し結果。BOM 有無を保持し、保存時に形式を維持できるようにする。
 * bom は utf-8 のみ true になり得る（shift_jis / euc-jp は常に false）。
 */
export interface TextDocument {
  text: string
  encoding: TextEncoding
  bom: boolean
}

/**
 * ファイルの開き方。
 * - preview: 読み取り専用ビューア
 * - built-in: アプリ内テキストエディタ
 * - system-default: OS 既定アプリで開く
 * - choose-app: アプリを選んで開く
 */
export type OpenMode = 'preview' | 'built-in' | 'system-default' | 'choose-app'

/**
 * リモートファイルの外部編集セッション（renderer へ公開する形）。
 * temp の実パスは main 所有境界を守るため公開しない（Reveal は id で行う）。
 * dirty は main が temp の stat スナップショットと比較して算出する。
 */
export interface ExternalEditSession {
  id: string
  remotePath: string
  name: string
  dirty: boolean
}

/**
 * リモート → ローカルのダウンロード要求。
 */
export interface DownloadFileRequest {
  target: ConnectionTarget
  remotePath: string
  localPath: string
}

/**
 * ローカル → リモートのアップロード要求。
 */
export interface UploadFileRequest {
  target: ConnectionTarget
  localPath: string
  remotePath: string
}

/**
 * リモートファイルのテキスト読み出し・削除で共通のファイル指定。
 */
export interface RemoteFileRequest {
  target: ConnectionTarget
  path: string
}

/**
 * リモートファイルへのテキスト書き込み要求。
 */
export interface WriteTextRequest extends RemoteFileRequest {
  text: string
}

/**
 * リモートファイルを指定ローカルディレクトリ直下へ保存する要求。
 * ファイル名結合は main 側で行うため、renderer は保存先ディレクトリだけ渡す。
 */
export interface DownloadToDirectoryRequest {
  target: ConnectionTarget
  remotePath: string
  localDirectory: string
}

/**
 * ディレクトリ作成要求（remote: 仮想パス / local: 絶対パスの親配下に name を作る）。
 */
export interface CreateDirectoryRequest {
  parentPath: string
  name: string
}

/**
 * リネーム要求（同一親内での改名）。
 */
export interface RenameRequest {
  sourcePath: string
  newName: string
  entryType: StorageEntryType
}

/**
 * バッチ操作で扱う 1 エントリ（パスと種別）。
 */
export interface BatchItem {
  path: string
  type: StorageEntryType
}

/**
 * バッチ操作の個別失敗。
 */
export interface BatchOperationFailure {
  path: string
  message: string
}

/**
 * バッチ操作の結果。逐次処理し、成功数と失敗詳細を集計する（all-or-nothing を偽装しない）。
 */
export interface BatchOperationResult {
  succeeded: number
  failures: BatchOperationFailure[]
}

/**
 * アプリ内クリップボードのコピー元 / 貼り付け先のペイン種別。
 */
export type PaneKind = 'remote' | 'local'

/**
 * クリップボードに記録する 1 エントリ。
 */
export interface ClipboardEntry {
  path: string
  name: string
  type: StorageEntryType
}

/**
 * 貼り付け要求。source / destination は remote / local の 4 組合せを取り得る。
 * remote 側は target（接続設定スナップショット）を伴う。
 */
export interface PasteRequest {
  entries: ClipboardEntry[]
  source: { kind: PaneKind; target: ConnectionTarget | null }
  destination: { kind: PaneKind; target: ConnectionTarget | null; directory: string }
}
