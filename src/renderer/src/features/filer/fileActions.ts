/**
 * ファイラのアクション定義（capability / menu / shortcut）を集約した純粋モジュール。
 * context menu・toolbar・キーボードショートカットはすべてここの定義から駆動し、齟齬を防ぐ。
 * DOM やアプリ状態に依存しない純関数だけを置き、単体テスト可能にする。
 */
import type { StorageEntry, StorageEntryType } from '../../../../shared/storage'

/** ショートカットの組み合わせ定義。mod は Cmd(mac)/Ctrl(他)。 */
export interface ShortcutDescriptor {
  key: string
  mod?: boolean
  shift?: boolean
}

/** アクション識別子。 */
export type FileActionId =
  | 'open'
  | 'open-with'
  | 'download-local'
  | 'download-dialog'
  | 'upload'
  | 'copy'
  | 'paste'
  | 'rename'
  | 'copy-path'
  | 'delete'
  | 'new-folder'
  | 'reveal'
  | 'open-folder'

/** コンテキストメニュー1項目（onClick は呼び出し側が後付けする）。 */
export interface ContextMenuItem {
  label: string
  onClick?: () => void
  disabled?: boolean
  shortcut?: ShortcutDescriptor
  shortcutLabel?: string
}

/** アクションの表示・有効状態を表す記述子。 */
export interface FileActionDescriptor {
  id: FileActionId
  label: string
  shortcut?: ShortcutDescriptor
  shortcutLabel?: string
  enabled: boolean
}

/** アクション可否を決める文脈。 */
export interface ActionContext {
  paneKind: 'remote' | 'local'
  selection: StorageEntry[]
  busy: boolean
  /** remote のみ: ローカルペインが表示中で保存先が確定しているか。 */
  canDownloadToLocal: boolean
  /** 内部クリップボードに貼り付け可能な項目があるか。 */
  hasClipboard: boolean
  /**
   * remote のみ: S3 のルート（bucket 一覧）を表示しているか。
   * bucket は外部リソースで疑似フォルダではないため、ここでは mutation / 転送 / open-with を不可にし、
   * ディレクトリ（bucket）の Open/移動と検索・更新だけを許す。
   */
  isBucketListRoot?: boolean
}

/**
 * S3 bucket 一覧ルートで無効化するアクション。
 * bucket への generic な mutation / 転送 / ファイルを開く操作はすべて不可にする。
 */
const BUCKET_ROOT_DISABLED: ReadonlySet<FileActionId> = new Set<FileActionId>([
  'open-with',
  'download-local',
  'download-dialog',
  'upload',
  'copy',
  'paste',
  'rename',
  'copy-path',
  'delete',
  'new-folder',
])

/** 実行環境が mac かどうか（メニューの修飾キー表記に使う）。 */
export const isMacPlatform =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)

/** 実行環境が Windows かどうか（Finder/Explorer/File Manager の表記出し分けに使う）。 */
export const isWindowsPlatform =
  typeof navigator !== 'undefined' && /Win/.test(navigator.platform || navigator.userAgent)

/** 修飾キーの表示記号。mac は ⌘、それ以外は Ctrl。 */
export const MOD_LABEL = isMacPlatform ? '⌘' : 'Ctrl'

/** OS 別の「ファイルマネージャ」名称。 */
const FILE_MANAGER_NAME = isMacPlatform ? 'Finder' : isWindowsPlatform ? 'Explorer' : 'File Manager'

/** 各アクションのショートカット定義。 */
const SHORTCUTS: Partial<Record<FileActionId, ShortcutDescriptor>> = {
  open: { key: 'Enter' },
  'open-with': { key: 'Enter', mod: true },
  'download-local': { key: 'd', mod: true },
  'download-dialog': { key: 'd', mod: true, shift: true },
  upload: { key: 'u', mod: true },
  copy: { key: 'c', mod: true },
  paste: { key: 'v', mod: true },
  rename: { key: 'F2' },
  'copy-path': { key: 'c', mod: true, shift: true },
  delete: { key: 'Delete' },
  'new-folder': { key: 'n', mod: true, shift: true },
}

/** pane ごとのアクション表示順。 */
const ORDER: Record<'remote' | 'local', FileActionId[]> = {
  remote: [
    'open',
    'open-with',
    'download-local',
    'download-dialog',
    'copy',
    'paste',
    'rename',
    'copy-path',
    'delete',
    'new-folder',
  ],
  local: [
    'open',
    'open-with',
    'upload',
    'copy',
    'paste',
    'rename',
    'copy-path',
    'reveal',
    'delete',
    'new-folder',
    'open-folder',
  ],
}

/**
 * 入力要素（input / textarea / contenteditable）にフォーカスがあるか。
 * グローバルショートカットを入力中に発火させないために使う。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true
}

/**
 * キーイベントがショートカット定義に一致するか判定する。
 * alt 同時押しは常に不一致。Delete は macOS の Backspace も等価として受理する。
 */
export function matchesShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  shortcut: ShortcutDescriptor
): boolean {
  if (event.altKey) return false
  const mod = event.metaKey || event.ctrlKey
  if (Boolean(shortcut.mod) !== mod) return false
  if (Boolean(shortcut.shift) !== event.shiftKey) return false
  if (shortcut.key === 'Delete') return event.key === 'Delete' || (isMacPlatform && event.key === 'Backspace')
  return event.key.toLowerCase() === shortcut.key.toLowerCase()
}

/**
 * ショートカットを OS に応じた表示文字列にする（⌘+Shift+D など）。
 */
export function shortcutLabel(shortcut: ShortcutDescriptor): string {
  const parts: string[] = []
  if (shortcut.mod) parts.push(MOD_LABEL)
  if (shortcut.shift) parts.push('Shift')
  const keyLabel = shortcut.key === 'Delete' ? (isMacPlatform ? '⌫' : 'Del') : shortcut.key
  parts.push(keyLabel.length === 1 ? keyLabel.toUpperCase() : keyLabel)
  return parts.join('+')
}

/**
 * メニュー項目を組み立てる。shortcut からは表示ラベルも自動生成する。
 */
export function menuItem(
  label: string,
  onClick: (() => void) | undefined,
  options: { shortcut?: ShortcutDescriptor; disabled?: boolean } = {}
): ContextMenuItem {
  return {
    label,
    onClick,
    disabled: options.disabled,
    shortcut: options.shortcut,
    shortcutLabel: options.shortcut ? shortcutLabel(options.shortcut) : undefined,
  }
}

/** 選択がすべてファイルか。 */
function allFiles(selection: StorageEntry[]): boolean {
  return selection.length > 0 && selection.every((entry) => entry.type === 'file')
}

/**
 * 選択件数に応じたアクションラベルを返す（例: Delete 4 items）。
 */
function actionLabel(id: FileActionId, count: number): string {
  switch (id) {
    case 'open':
      return 'Open'
    case 'open-with':
      return 'Open…'
    case 'download-local':
      return count <= 1 ? 'Download to Local' : `Download ${count} files to Local`
    case 'download-dialog':
      return count <= 1 ? 'Download file…' : `Download ${count} files…`
    case 'upload':
      return count <= 1 ? 'Upload file' : `Upload ${count} files`
    case 'copy':
      return count <= 1 ? 'Copy' : `Copy ${count} files`
    case 'paste':
      return 'Paste'
    case 'rename':
      return 'Rename…'
    case 'copy-path':
      return count <= 1 ? 'Copy path' : 'Copy paths'
    case 'delete':
      return count <= 1 ? 'Delete' : `Delete ${count} items`
    case 'new-folder':
      return 'New Folder…'
    case 'reveal':
      return `Show in ${FILE_MANAGER_NAME}`
    case 'open-folder':
      return `Open Folder in ${FILE_MANAGER_NAME}`
  }
}

/**
 * アクションが現在有効か判定する。
 */
function isEnabled(id: FileActionId, context: ActionContext): boolean {
  const count = context.selection.length
  const files = allFiles(context.selection)
  // S3 bucket 一覧ルートでは bucket への mutation / 転送 / open-with を不可にする（Open=移動のみ許可）。
  if (context.isBucketListRoot && BUCKET_ROOT_DISABLED.has(id)) return false
  switch (id) {
    case 'open':
      return count === 1
    case 'open-with':
      // 開き方選択は単一ファイルのみ（ディレクトリは Open で移動）。
      return count === 1 && context.selection[0]?.type === 'file'
    case 'download-local':
      return context.paneKind === 'remote' && files && context.canDownloadToLocal && !context.busy
    case 'download-dialog':
      return context.paneKind === 'remote' && files && !context.busy
    case 'upload':
      return context.paneKind === 'local' && files && !context.busy
    case 'copy':
      // ディレクトリ copy は対象外のため、ファイルのみ。
      return files && !context.busy
    case 'paste':
      return context.hasClipboard && !context.busy
    case 'rename':
      return count === 1 && !context.busy
    case 'copy-path':
      return count >= 1
    case 'delete':
      return count >= 1 && !context.busy
    case 'new-folder':
      return !context.busy
    case 'reveal':
      // ローカルの単一選択を Finder/Explorer で表示。
      return context.paneKind === 'local' && count === 1
    case 'open-folder':
      // 現在のローカルディレクトリを開く（選択不要）。
      return context.paneKind === 'local'
  }
}

/**
 * pane の全アクションを表示順に記述する。context menu / toolbar / shortcut はこれを共有する。
 *
 * @param context 現在の選択・状態
 * @returns 表示順のアクション記述子
 */
export function describeActions(context: ActionContext): FileActionDescriptor[] {
  const count = context.selection.length
  return ORDER[context.paneKind].map((id) => {
    const shortcut = SHORTCUTS[id]
    return {
      id,
      label: actionLabel(id, count),
      shortcut,
      shortcutLabel: shortcut ? shortcutLabel(shortcut) : undefined,
      enabled: isEnabled(id, context),
    }
  })
}

/** 選択種別（ファイル / ディレクトリ混在）を要約した文字列（confirm 表示用）。 */
export function summarizeSelection(selection: StorageEntry[]): string {
  if (selection.length === 1) return `"${selection[0].name}"`
  const fileCount = selection.filter((entry) => entry.type === 'file').length
  const dirCount = selection.length - fileCount
  const parts: string[] = []
  if (fileCount > 0) parts.push(`${fileCount} file${fileCount > 1 ? 's' : ''}`)
  if (dirCount > 0) parts.push(`${dirCount} folder${dirCount > 1 ? 's' : ''}`)
  return parts.join(' and ')
}

export type { StorageEntry, StorageEntryType }
