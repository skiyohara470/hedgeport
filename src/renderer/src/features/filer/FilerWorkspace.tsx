import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'

import {
  TEXT_ENCODINGS,
  type BatchOperationResult,
  type ClipboardEntry,
  type ExternalEditSession,
  type OpenMode,
  type ReadEncoding,
  type TextEncoding,
} from '../../../../shared/transfer'
import type { StorageEntry } from '../../../../shared/storage'
import { ConnectionManager } from '../connection/ConnectionManager'
import type { ConnectionTarget } from '../connection/connectionTypes'
import {
  describeActions,
  isTypingTarget,
  matchesShortcut,
  summarizeSelection,
  type ActionContext,
  type FileActionDescriptor,
  type FileActionId,
} from './fileActions'

/** pane action toolbar に出すアクション（順序）。 */
const TOOLBAR_ACTIONS: Record<PaneKind, FileActionId[]> = {
  remote: ['download-local', 'copy', 'paste', 'rename', 'delete', 'new-folder'],
  local: ['upload', 'copy', 'paste', 'rename', 'delete', 'new-folder'],
}

/** アクション id → toolbar アイコン名。 */
const ACTION_ICON: Partial<Record<FileActionId, IconProps['name']>> = {
  'download-local': 'download',
  upload: 'upload',
  copy: 'copy',
  paste: 'paste',
  rename: 'rename',
  delete: 'trash',
  'new-folder': 'folder-plus',
}
import { emptySelection, selectEntry } from './selectionModel'
import { activateTab, closeTab, openTab, type TabsState } from './tabsModel'

/** ペイン種別。 */
type PaneKind = 'remote' | 'local'

/** ファイル操作のアクション実行ハンドラ（選択全体に作用する）。 */
type ActionHandler = (id: FileActionId, selection: StorageEntry[]) => void

/** 開き方選択ハンドラ。 */
type OpenWithHandler = (mode: OpenMode, entry: StorageEntry) => void

/** Open… で選べる開き方の一覧。 */
const OPEN_MODE_ITEMS: { mode: OpenMode; label: string }[] = [
  { mode: 'preview', label: 'Preview' },
  { mode: 'built-in', label: 'Built-in Editor' },
  { mode: 'system-default', label: 'System Default App' },
  { mode: 'choose-app', label: 'Choose Application…' },
]

/**
 * 開き方が現在の pane で使えるか。
 * remote の System Default / Choose Application は外部編集セッション（temp 経由）で対応する。
 */
function openModeEnabled(_mode: OpenMode, _paneKind: PaneKind): boolean {
  return true
}

interface FilerWorkspaceProps {
  target: ConnectionTarget
  targets: ConnectionTarget[]
  onSaveTarget: (target: ConnectionTarget) => Promise<void> | void
  onDeleteTarget: (target: ConnectionTarget) => Promise<void> | void
  onDisconnect: () => void
}

interface IconProps {
  name:
    | 'columns'
    | 'eye'
    | 'connections'
    | 'plus'
    | 'close'
    | 'up'
    | 'refresh'
    | 'back'
    | 'forward'
    | 'folder'
    | 'file'
    | 'download'
    | 'upload'
    | 'copy'
    | 'paste'
    | 'trash'
    | 'folder-plus'
    | 'rename'
}

/**
 * ワークスペース内で使う共通アイコン。
 * 見た目は name ごとの path 定義だけに寄せて呼び出し側を簡潔にする。
 */
function Icon({ name }: IconProps) {
  const paths = {
    columns: <path d="M4 5h16v14H4zM12 5v14" />,
    eye: <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Zm9.5 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />,
    connections: <path d="M9 7 4 12l5 5M4 12h12M15 4h5v16h-5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m7 7 10 10M17 7 7 17" />,
    up: <path d="m6 14 6-6 6 6" />,
    refresh: <path d="M20 6v5h-5M4 18v-5h5M18.5 9A7 7 0 0 0 6.2 6.2L4 9m16 6-2.2 2.8A7 7 0 0 1 5.5 15" />,
    back: <path d="m14 6-6 6 6 6M8 12h12" />,
    forward: <path d="m10 6 6 6-6 6M4 12h12" />,
    folder: <path d="M3 6.5h7l2 2h9v9.5H3z" />,
    file: <path d="M6 3h8l4 4v14H6zM14 3v5h5" />,
    download: <path d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14" />,
    upload: <path d="M12 20V10m0 0 4 4m-4-4-4 4M5 5h14" />,
    copy: <path d="M9 9h10v11H9zM5 15V4h10" />,
    paste: <path d="M9 4h6v3H9zM7 5H5v15h14V5h-2M9 12h6M9 16h6" />,
    trash: <path d="M5 7h14M10 7V4h4v3M6 7l1 13h10l1-13" />,
    'folder-plus': <path d="M3 6.5h7l2 2h9v9.5H3zM12 12v5M9.5 14.5h5" />,
    rename: <path d="m4 20 1-4L16 5l3 3L8 19zM14 7l3 3" />,
  }

  return (
    <svg className="button-icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

function formatSize(size?: number): string {
  if (size === undefined) return '-'
  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`
  return `${(size / 1024 ** 3).toFixed(1)} GB`
}

/**
 * 一覧表示用に更新日時をローカライズして整形する。
 */
function formatModifiedAt(value?: string): string {
  if (!value) return '-'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

/**
 * 仮想パスの親パスを返す。
 * ルートだけはそれ以上遡れないので null を返す。
 */
function parentPath(path: string): string | null {
  if (path === '/') return null
  const segments = path.split('/').filter(Boolean)
  segments.pop()
  return segments.length ? `/${segments.join('/')}` : '/'
}

/**
 * パンくず表示用に各階層のラベルと遷移先パスを並べる。
 */
function breadcrumbs(path: string): Array<{ label: string; path: string }> {
  const items = [{ label: '/', path: '/' }]
  const segments = path.split('/').filter(Boolean)
  segments.forEach((segment, index) => {
    items.push({
      label: segment,
      path: `/${segments.slice(0, index + 1).join('/')}`,
    })
  })
  return items
}

/**
 * 左右ペインの幅を 20-80% の範囲へクランプして返す。
 */
export function calculateSplitRatio(clientX: number, left: number, width: number): number {
  if (width <= 0) return 50
  return Math.min(80, Math.max(20, ((clientX - left) / width) * 100))
}

/** Built-in Editor / Preview モーダルの矩形（fixed 配置の左上座標とサイズ）。 */
export interface EditorRect {
  x: number
  y: number
  width: number
  height: number
}

/** 画面の利用可能サイズ。 */
export interface Viewport {
  width: number
  height: number
}

/** モーダルの最小サイズ（textarea が使える程度を担保）。 */
export const MIN_EDITOR_WIDTH = 360
export const MIN_EDITOR_HEIGHT = 240

/**
 * viewport に収まる実効的な最小サイズ。
 * viewport が設定 min より小さい場合は overflow させず viewport 寸法まで最小を縮退させる。
 *
 * @param viewport 画面の利用可能サイズ
 * @returns 実効最小 width / height
 */
function effectiveMinSize(viewport: Viewport): { width: number; height: number } {
  return {
    width: Math.min(MIN_EDITOR_WIDTH, Math.max(0, viewport.width)),
    height: Math.min(MIN_EDITOR_HEIGHT, Math.max(0, viewport.height)),
  }
}

/**
 * 新規ファイルを開いた時の初期サイズ。viewport の 8 割を目安に実効 min / viewport 上限でクランプする。
 *
 * @param viewport 画面の利用可能サイズ
 * @returns 初期 width / height
 */
export function defaultEditorSize(viewport: Viewport): { width: number; height: number } {
  const min = effectiveMinSize(viewport)
  return {
    width: Math.min(Math.max(min.width, Math.round(viewport.width * 0.8)), viewport.width),
    height: Math.min(Math.max(min.height, Math.round(viewport.height * 0.8)), viewport.height),
  }
}

/**
 * 指定サイズを viewport 中央に配置する左上座標を返す（負にはしない）。
 *
 * @param size モーダルのサイズ
 * @param viewport 画面の利用可能サイズ
 * @returns 中央配置の x / y
 */
export function centeredEditorPosition(
  size: { width: number; height: number },
  viewport: Viewport
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.round((viewport.width - size.width) / 2)),
    y: Math.max(0, Math.round((viewport.height - size.height) / 2)),
  }
}

/**
 * モーダル矩形を「全体が viewport 内に収まる」ようクランプする（位置を考慮した一括クランプ）。
 * サイズを実効 min / viewport 上限へ収めたうえで、左上を [0, viewport - size] に収め、
 * 右端・下端が画面外へ出ないようにする（ヘッダ操作系・右下リサイズハンドルが常に到達可能）。
 * ドラッグ・viewport リサイズ・初期配置で共通利用する。
 *
 * @param rect クランプ前の矩形
 * @param viewport 画面の利用可能サイズ
 * @returns viewport 内に収めた矩形
 */
export function clampEditorRect(rect: EditorRect, viewport: Viewport): EditorRect {
  const min = effectiveMinSize(viewport)
  const width = Math.min(Math.max(min.width, rect.width), Math.max(min.width, viewport.width))
  const height = Math.min(Math.max(min.height, rect.height), Math.max(min.height, viewport.height))
  return {
    width,
    height,
    x: Math.min(Math.max(0, rect.x), Math.max(0, viewport.width - width)),
    y: Math.min(Math.max(0, rect.y), Math.max(0, viewport.height - height)),
  }
}

/**
 * 右下ハンドルのドラッグ量からリサイズ後の矩形を求める。
 * 左上は固定し、最大幅/高さは現在位置で使える領域（viewport.width - x / viewport.height - y）に制限する。
 * これにより右端・下端が画面外へ出ず、ヘッダ操作系も画面内に残る。
 *
 * @param start リサイズ開始時の矩形（左上を維持）
 * @param dx 横方向の移動量
 * @param dy 縦方向の移動量
 * @param viewport 画面の利用可能サイズ
 * @returns リサイズ後の矩形
 */
export function resizeEditorRect(start: EditorRect, dx: number, dy: number, viewport: Viewport): EditorRect {
  const min = effectiveMinSize(viewport)
  const maxWidth = Math.max(min.width, viewport.width - start.x)
  const maxHeight = Math.max(min.height, viewport.height - start.y)
  return {
    x: start.x,
    y: start.y,
    width: Math.min(Math.max(min.width, start.width + dx), maxWidth),
    height: Math.min(Math.max(min.height, start.height + dy), maxHeight),
  }
}

type SortKey = 'name' | 'size' | 'modifiedAt'
type SortDirection = 'asc' | 'desc'

interface ContextMenuState {
  x: number
  y: number
  // entry が null のときは空白領域のメニュー（New Folder など）。
  entry: StorageEntry | null
}

/**
 * ディレクトリ作成 / リネーム共通の入力モーダル状態。
 */
interface NameDialogState {
  id: number
  title: string
  label: string
  value: string
  submitLabel: string
  busy: boolean
  error: string | null
  submit: (name: string) => Promise<void>
}

/**
 * パス（複数なら改行区切り）をクリップボードへコピーする。
 * クリップボード API が無い環境では黙って何もしない。
 */
function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText(text)
}

function ariaSortValue(
  key: SortKey,
  sortKey: SortKey,
  sortDirection: SortDirection
): 'none' | 'ascending' | 'descending' {
  if (key !== sortKey) return 'none'
  return sortDirection === 'asc' ? 'ascending' : 'descending'
}

function compareValues(left: string | number, right: string | number): number {
  if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right)
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * ディレクトリ優先を保ちながら、指定列と方向で一覧をソートする。
 */
function sortEntries(entries: StorageEntry[], key: SortKey, direction: SortDirection): StorageEntry[] {
  const multiplier = direction === 'asc' ? 1 : -1
  return [...entries].sort((left, right) => {
    if (key === 'name') {
      const typeOrder = left.type === right.type ? 0 : left.type === 'directory' ? -1 : 1
      if (typeOrder !== 0) return typeOrder * multiplier
      return compareValues(left.name, right.name) * multiplier
    }

    if (key === 'size') {
      const leftSize = left.size ?? -1
      const rightSize = right.size ?? -1
      const sizeOrder = compareValues(leftSize, rightSize)
      if (sizeOrder !== 0) return sizeOrder * multiplier
      return compareValues(left.name, right.name)
    }

    const leftModified = left.modifiedAt ?? ''
    const rightModified = right.modifiedAt ?? ''
    const modifiedOrder = compareValues(leftModified, rightModified)
    if (modifiedOrder !== 0) return modifiedOrder * multiplier
    return compareValues(left.name, right.name)
  })
}

/**
 * 単一ペイン分のファイル一覧テーブル。
 * 検索、ソート、複数選択、コンテキストメニューをローカル state で持つ。
 * メニュー項目は呼び出し側（ペイン）が `menuItemsFor` で組み立てて渡す。
 */
function FileTable({
  entries,
  directoryKey,
  paneKind,
  busy = false,
  canDownloadToLocal = false,
  hasClipboard = false,
  keyboardActive = false,
  s3FoldersHaveNoModifiedDate = false,
  onOpenDirectory,
  onFocusPane,
  onAction = () => undefined,
  onOpenWith = () => undefined,
}: {
  entries: StorageEntry[]
  directoryKey: string
  paneKind: PaneKind
  busy?: boolean
  canDownloadToLocal?: boolean
  hasClipboard?: boolean
  keyboardActive?: boolean
  s3FoldersHaveNoModifiedDate?: boolean
  onOpenDirectory: (path: string) => void
  onFocusPane?: () => void
  onAction?: ActionHandler
  onOpenWith?: OpenWithHandler
}) {
  const [selection, setSelection] = useState(emptySelection)
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  // Open… の開き方選択モーダル対象（単一ファイル）。
  const [openModeFor, setOpenModeFor] = useState<StorageEntry | null>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)
  const normalizedQuery = query.trim().toLowerCase()
  const filteredEntries = useMemo(
    () => entries.filter((entry) => entry.name.toLowerCase().includes(normalizedQuery)),
    [entries, normalizedQuery]
  )
  const visibleEntries = useMemo(
    () => sortEntries(filteredEntries, sortKey, sortDirection),
    [filteredEntries, sortKey, sortDirection]
  )
  const orderedPaths = visibleEntries.map((entry) => entry.path)

  // 現在の選択（エントリ実体）。toolbar / menu / shortcut の作用対象。
  const selectionEntries = useMemo(
    () => entries.filter((entry) => selection.selectedPaths.has(entry.path)),
    [entries, selection.selectedPaths]
  )
  const actionContext: ActionContext = { paneKind, selection: selectionEntries, busy, canDownloadToLocal, hasClipboard }
  const actions = describeActions(actionContext)

  /**
   * アクションを実行する。ディレクトリの Open はペイン内移動、それ以外は親ハンドラへ委譲。
   */
  const runAction = (id: FileActionId): void => {
    if (id === 'open' && selectionEntries.length === 1 && selectionEntries[0].type === 'directory') {
      onOpenDirectory(selectionEntries[0].path)
      return
    }
    // Open… は開き方選択モーダルを開く（単一ファイルのみ）。
    if (id === 'open-with') {
      if (selectionEntries.length === 1 && selectionEntries[0].type === 'file') setOpenModeFor(selectionEntries[0])
      return
    }
    onAction(id, selectionEntries)
  }

  useEffect(() => {
    setSelection(emptySelection())
    setQuery('')
    setSortKey('name')
    setSortDirection('asc')
    setContextMenu(null)
    setOpenModeFor(null)
  }, [directoryKey])

  const openAction = actions.find((action) => action.id === 'open')
  const openWithAction = actions.find((action) => action.id === 'open-with')

  useEffect(() => {
    const checkbox = selectAllRef.current
    if (!checkbox) return
    const selectedCount = visibleEntries.filter((entry) => selection.selectedPaths.has(entry.path)).length
    checkbox.checked = visibleEntries.length > 0 && selectedCount === visibleEntries.length
    checkbox.indeterminate = selectedCount > 0 && selectedCount < visibleEntries.length
  }, [selection.selectedPaths, visibleEntries])

  // このペインがフォーカスされている間だけ、ショートカットをアクション定義へ対応付けて発火する。
  useEffect(() => {
    if (!keyboardActive) return
    const handler = (event: globalThis.KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return
      for (const action of actions) {
        if (!action.shortcut || !action.enabled) continue
        if (matchesShortcut(event, action.shortcut)) {
          event.preventDefault()
          runAction(action.id)
          return
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // actions / selectionEntries は描画ごとに新規だが、購読し直して最新を反映する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardActive, actions, selectionEntries])

  /**
   * 行クリックを selectionModel へ委譲して次の選択状態を作る。
   */
  const select = (event: MouseEvent<HTMLTableRowElement>, path: string): void => {
    setSelection((current) =>
      selectEntry(current, orderedPaths, path, {
        toggle: event.metaKey || event.ctrlKey,
        range: event.shiftKey,
      })
    )
  }

  /**
   * 行のダブルクリックで既定の open を実行する。
   * ディレクトリはペイン内移動、ファイルは Enter / eye button / context menu の Open と同じ
   * 既定アクション（remote=Built-in Editor / local=System Default）を委譲する。
   * チェックボックス等の操作系をダブルクリックした場合はファイルを開かない。
   */
  const handleRowDoubleClick = (event: MouseEvent<HTMLTableRowElement>, entry: StorageEntry): void => {
    // input / button / checkbox セル由来のダブルクリックでは open しない（選択操作と切り分ける）。
    if ((event.target as HTMLElement).closest('input, button, .checkbox-cell')) return
    if (entry.type === 'directory') {
      onOpenDirectory(entry.path)
      return
    }
    onAction('open', [entry])
  }

  /**
   * 同じ列を再度押した時だけ昇順/降順を反転する。
   */
  const toggleSort = (key: SortKey): void => {
    setSortDirection((currentDirection) => (sortKey === key ? (currentDirection === 'asc' ? 'desc' : 'asc') : 'asc'))
    setSortKey(key)
  }

  /**
   * 現在のフィルタ結果だけを対象に全選択/解除する。
   */
  const toggleSelectAll = (): void => {
    setSelection((current) => {
      const filteredPaths = new Set(visibleEntries.map((entry) => entry.path))
      const selectedCount = visibleEntries.filter((entry) => current.selectedPaths.has(entry.path)).length
      if (visibleEntries.length === 0) return current
      if (selectedCount === visibleEntries.length) {
        const next = new Set(current.selectedPaths)
        for (const path of filteredPaths) next.delete(path)
        return { selectedPaths: next, anchorPath: current.anchorPath }
      }
      const next = new Set(current.selectedPaths)
      for (const path of filteredPaths) next.add(path)
      return { selectedPaths: next, anchorPath: current.anchorPath ?? visibleEntries[0].path }
    })
  }

  useEffect(() => {
    if (!contextMenu) return

    const closeMenu = (): void => setContextMenu(null)
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') closeMenu()
    }

    window.addEventListener('click', closeMenu)
    window.addEventListener('scroll', closeMenu, true)
    window.addEventListener('resize', closeMenu)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [contextMenu])

  const toolbarActions = TOOLBAR_ACTIONS[paneKind]
    .map((id) => actions.find((action) => action.id === id))
    .filter((action): action is FileActionDescriptor => Boolean(action))
  const menuActions = contextMenu?.entry
    ? actions.filter((action) => action.id !== 'open-folder')
    : actions.filter((action) => action.id === 'new-folder' || action.id === 'paste' || action.id === 'open-folder')

  return (
    <div
      className="file-table-shell"
      onMouseDownCapture={() => onFocusPane?.()}
      onContextMenu={(event) => {
        // 行ハンドラが stopPropagation するため、ここに来るのは空白領域の右クリック。
        event.preventDefault()
        onFocusPane?.()
        setContextMenu({ x: event.clientX, y: event.clientY, entry: null })
      }}
    >
      <div className="table-toolbar">
        <label className="search-box">
          <input
            aria-label="Search files"
            value={query}
            placeholder="Search files"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="pane-action-toolbar" role="toolbar" aria-label={`${paneKind} actions`}>
          {/* Open（eye 本体）＋ ▼（Open… 開き方選択）の split button。 */}
          <span className="split-button">
            <button
              className="icon-button"
              type="button"
              aria-label="Open"
              title="Open (Enter)"
              disabled={!openAction?.enabled}
              onClick={() => runAction('open')}
            >
              <Icon name="eye" />
            </button>
            <button
              className="split-button-caret"
              type="button"
              aria-label="Open with…"
              aria-haspopup="menu"
              aria-expanded={openModeFor !== null}
              title={openWithAction?.shortcutLabel ? `Open… (${openWithAction.shortcutLabel})` : 'Open…'}
              disabled={!openWithAction?.enabled}
              onClick={() => runAction('open-with')}
            >
              ▾
            </button>
          </span>
          {toolbarActions.map((action) => (
            <button
              key={action.id}
              className="icon-button"
              type="button"
              aria-label={action.label}
              title={action.shortcutLabel ? `${action.label} (${action.shortcutLabel})` : action.label}
              disabled={!action.enabled}
              onClick={() => runAction(action.id)}
            >
              <Icon name={ACTION_ICON[action.id] ?? 'file'} />
            </button>
          ))}
        </div>
      </div>
      <div className="file-table-scroll">
        {visibleEntries.length === 0 ? (
          <p className="pane-message">{normalizedQuery ? 'No files match this search.' : 'This directory is empty.'}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="checkbox-cell">
                  <input ref={selectAllRef} type="checkbox" aria-label="Select all" onChange={toggleSelectAll} />
                </th>
                <th aria-sort={ariaSortValue('name', sortKey, sortDirection)}>
                  <button className="sort-button" type="button" onClick={() => toggleSort('name')}>
                    Name
                    <span aria-hidden="true">{sortKey === 'name' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
                  </button>
                </th>
                <th aria-sort={ariaSortValue('size', sortKey, sortDirection)}>
                  <button className="sort-button" type="button" onClick={() => toggleSort('size')}>
                    Size
                    <span aria-hidden="true">{sortKey === 'size' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
                  </button>
                </th>
                <th aria-sort={ariaSortValue('modifiedAt', sortKey, sortDirection)}>
                  <button className="sort-button" type="button" onClick={() => toggleSort('modifiedAt')}>
                    Modified
                    <span aria-hidden="true">
                      {sortKey === 'modifiedAt' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
                    </span>
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleEntries.map((entry) => {
                const selected = selection.selectedPaths.has(entry.path)
                return (
                  <tr
                    key={entry.path}
                    className={[entry.type === 'directory' ? 'directory-row' : '', selected ? 'selected-row' : '']
                      .filter(Boolean)
                      .join(' ')}
                    aria-selected={selected}
                    title="Double-click to open"
                    onClick={(event) => select(event, entry.path)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      // 空白領域メニューを開かないよう shell ハンドラへの伝播を止める。
                      event.stopPropagation()
                      onFocusPane?.()
                      // 右クリック対象が選択内なら複数選択を維持、選択外ならその1件へ置換。
                      if (!selection.selectedPaths.has(entry.path)) {
                        setSelection((current) =>
                          selectEntry(current, orderedPaths, entry.path, { toggle: false, range: false })
                        )
                      }
                      setContextMenu({ x: event.clientX, y: event.clientY, entry })
                    }}
                    onDoubleClick={(event) => handleRowDoubleClick(event, entry)}
                  >
                    <td className="checkbox-cell">
                      <input
                        type="checkbox"
                        aria-label={`Select ${entry.name}`}
                        checked={selected}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          event.stopPropagation()
                          setSelection((current) =>
                            selectEntry(current, orderedPaths, entry.path, {
                              toggle: true,
                              range: false,
                            })
                          )
                        }}
                      />
                    </td>
                    <td>
                      <span className="entry-name">
                        <span className={entry.type === 'directory' ? 'entry-icon folder' : 'entry-icon file'}>
                          <Icon name={entry.type === 'directory' ? 'folder' : 'file'} />
                        </span>
                        <span>{entry.name}</span>
                      </span>
                    </td>
                    <td>{formatSize(entry.size)}</td>
                    <td
                      title={
                        s3FoldersHaveNoModifiedDate && entry.type === 'directory'
                          ? 'S3 folders have no modified date.'
                          : undefined
                      }
                    >
                      {formatModifiedAt(entry.modifiedAt)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      {contextMenu && (
        <div
          className="context-menu"
          role="menu"
          aria-label={contextMenu.entry ? `${contextMenu.entry.name} actions` : 'Directory actions'}
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          {menuActions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              disabled={!action.enabled}
              onClick={() => {
                runAction(action.id)
                setContextMenu(null)
              }}
            >
              <span>{action.label}</span>
              {action.shortcutLabel && <span className="menu-shortcut">{action.shortcutLabel}</span>}
            </button>
          ))}
        </div>
      )}
      {openModeFor && (
        <div
          className="editor-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Open ${openModeFor.name} with`}
          onClick={() => setOpenModeFor(null)}
        >
          <div className="open-mode-modal" role="menu" onClick={(event) => event.stopPropagation()}>
            <header className="editor-header">
              <h2>Open “{openModeFor.name}”</h2>
            </header>
            {OPEN_MODE_ITEMS.map((item) => {
              const enabled = openModeEnabled(item.mode, paneKind)
              return (
                <button
                  key={item.mode}
                  type="button"
                  role="menuitem"
                  disabled={!enabled}
                  title={enabled ? undefined : 'External editing will be added next'}
                  onClick={() => {
                    const entry = openModeFor
                    setOpenModeFor(null)
                    onOpenWith(item.mode, entry)
                  }}
                >
                  <span>{item.label}</span>
                  {!enabled && <span className="menu-shortcut">soon</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * リモートストレージ側のファイルペイン。
 * パス移動と戻る/進む履歴を持ち、target 切替時にルートから再ロードする。
 * ファイル操作（開く / ダウンロード / 削除）は親から渡されたハンドラへ委譲する。
 */
export function RemoteFilePane({
  target,
  onAction = () => undefined,
  onCurrentPathChange,
  onFocusPane,
  onOpenWith,
  canDownloadToLocal = false,
  hasClipboard = false,
  busy = false,
  keyboardActive = false,
  reloadToken = 0,
}: {
  target: ConnectionTarget
  onAction?: ActionHandler
  onCurrentPathChange?: (path: string) => void
  onFocusPane?: () => void
  onOpenWith?: OpenWithHandler
  canDownloadToLocal?: boolean
  hasClipboard?: boolean
  busy?: boolean
  keyboardActive?: boolean
  reloadToken?: number
}) {
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<StorageEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [backStack, setBackStack] = useState<string[]>([])
  const [forwardStack, setForwardStack] = useState<string[]>([])
  const pathRef = useRef(path)

  /**
   * リモート一覧を読み込み、履歴種別に応じて back/forward stack を更新する。
   */
  const loadDirectory = async (
    nextPath: string,
    history: 'push' | 'replace' | 'back' | 'forward' = 'replace'
  ): Promise<void> => {
    try {
      setIsLoading(true)
      setError(null)
      const currentPath = pathRef.current
      const nextEntries = await window.hedgeport.listStorage(target, nextPath)
      if (history === 'push' && currentPath !== nextPath) {
        setBackStack((current) => [...current, currentPath])
        setForwardStack([])
      } else if (history === 'back') {
        setBackStack((current) => current.slice(0, -1))
        setForwardStack((current) => [...current, currentPath])
      } else if (history === 'forward') {
        setForwardStack((current) => current.slice(0, -1))
        setBackStack((current) => [...current, currentPath])
      }
      pathRef.current = nextPath
      setPath(nextPath)
      setEntries(nextEntries)
      // 親が転送先（アップロード先）を決められるよう、現在のリモートディレクトリを伝える。
      onCurrentPathChange?.(nextPath)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not list this directory.')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    setBackStack([])
    setForwardStack([])
    pathRef.current = '/'
    void loadDirectory('/', 'replace')
    // target.id だけに依存させる。lastLocalPath 保存などで target 参照が変わっても
    // リモートをルートへ戻さない（左右ペインを独立させる）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id])

  // 親が転送・削除完了を通知したら、現在ディレクトリを取り直して一覧を最新化する。
  useEffect(() => {
    if (reloadToken > 0) void loadDirectory(pathRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken])

  const parent = parentPath(path)

  return (
    <section className="file-pane">
      <header className="pane-header">
        <span>{target.name}</span>
        <div className="pane-header-tools">
          <nav className="breadcrumbs" aria-label="Current directory">
            {breadcrumbs(path).map((item, index, items) => (
              <span key={item.path}>
                <button
                  className="breadcrumb-button"
                  type="button"
                  disabled={item.path === path || isLoading}
                  onClick={() => void loadDirectory(item.path, 'push')}
                >
                  {item.label}
                </button>
                {index < items.length - 1 && <span className="breadcrumb-separator">/</span>}
              </span>
            ))}
          </nav>
          <button
            className="pane-header-button"
            type="button"
            disabled={isLoading || backStack.length === 0}
            aria-label="Back"
            title="Back"
            onClick={() => {
              const previous = backStack.at(-1)
              if (previous) void loadDirectory(previous, 'back')
            }}
          >
            <Icon name="back" />
          </button>
          <button
            className="pane-header-button"
            type="button"
            disabled={isLoading || forwardStack.length === 0}
            aria-label="Forward"
            title="Forward"
            onClick={() => {
              const next = forwardStack.at(-1)
              if (next) void loadDirectory(next, 'forward')
            }}
          >
            <Icon name="forward" />
          </button>
          <button
            className="pane-header-button"
            type="button"
            disabled={!parent || isLoading}
            aria-label="Parent directory"
            title="Parent directory"
            onClick={() => parent && void loadDirectory(parent, 'push')}
          >
            <Icon name="up" />
          </button>
          <button
            className="pane-header-button"
            type="button"
            disabled={isLoading}
            aria-label="Reload directory"
            title="Reload directory"
            onClick={() => void loadDirectory(path)}
          >
            <Icon name="refresh" />
          </button>
        </div>
      </header>
      {error ? (
        <div className="pane-message error">
          <p>{error}</p>
          <button className="compact-button" type="button" onClick={() => void loadDirectory(path)}>
            Try again
          </button>
        </div>
      ) : isLoading ? (
        <p className="pane-message">Loading remote files...</p>
      ) : (
        // 空ディレクトリでも FileTable を描画する（空白右クリック New Folder / ショートカットを使えるように）。
        <FileTable
          entries={entries}
          directoryKey={path}
          paneKind="remote"
          busy={busy}
          canDownloadToLocal={canDownloadToLocal}
          hasClipboard={hasClipboard}
          keyboardActive={keyboardActive}
          s3FoldersHaveNoModifiedDate={target.kind === 's3'}
          onOpenDirectory={(entryPath) => void loadDirectory(entryPath, 'push')}
          onFocusPane={onFocusPane}
          onAction={onAction}
          onOpenWith={onOpenWith}
        />
      )}
    </section>
  )
}

/**
 * ローカルファイル側のペイン。
 * 現在パスを target.lastLocalPath へ反映できるよう、親へ更新を返す。
 */
function LocalFilePane({
  target,
  onRememberPath,
  onAction = () => undefined,
  onOpenWith,
  onFocusPane,
  hasClipboard = false,
  busy = false,
  keyboardActive = false,
  reloadToken = 0,
}: {
  target: ConnectionTarget
  onRememberPath: (path: string) => void
  onAction?: ActionHandler
  onOpenWith?: OpenWithHandler
  onFocusPane?: () => void
  hasClipboard?: boolean
  busy?: boolean
  keyboardActive?: boolean
  reloadToken?: number
}) {
  const [directory, setDirectory] = useState<LocalDirectory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [backStack, setBackStack] = useState<string[]>([])
  const [forwardStack, setForwardStack] = useState<string[]>([])
  const pathRef = useRef(target.lastLocalPath ?? '/')

  /**
   * ローカル一覧を読み込み、現在パスと履歴を同期する。
   */
  const loadDirectory = async (
    path?: string,
    history: 'push' | 'replace' | 'back' | 'forward' = 'replace'
  ): Promise<void> => {
    try {
      setError(null)
      const currentPath = pathRef.current
      const nextDirectory = await window.hedgeport.listLocal(path)
      const nextPath = nextDirectory.path
      if (history === 'push' && currentPath !== nextPath) {
        setBackStack((current) => [...current, currentPath])
        setForwardStack([])
      } else if (history === 'back') {
        setBackStack((current) => current.slice(0, -1))
        setForwardStack((current) => [...current, currentPath])
      } else if (history === 'forward') {
        setForwardStack((current) => current.slice(0, -1))
        setBackStack((current) => [...current, currentPath])
      }
      pathRef.current = nextPath
      setDirectory(nextDirectory)
      onRememberPath(nextPath)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not read this directory.')
    }
  }

  useEffect(() => {
    setBackStack([])
    setForwardStack([])
    pathRef.current = target.lastLocalPath ?? '/'
    void loadDirectory(target.lastLocalPath, 'replace')
  }, [target.id])

  // ダウンロード完了などで親が通知したら、現在ディレクトリを取り直す。
  useEffect(() => {
    if (reloadToken > 0) void loadDirectory(pathRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken])

  const currentPath = directory?.path ?? pathRef.current
  const parent = parentPath(currentPath)

  return (
    <section className="file-pane">
      <header className="pane-header">
        <span>Local files</span>
        <div className="pane-header-tools">
          <nav className="breadcrumbs" aria-label="Current directory">
            {breadcrumbs(currentPath).map((item, index, items) => (
              <span key={item.path}>
                <button
                  className="breadcrumb-button"
                  type="button"
                  disabled={item.path === currentPath || Boolean(error)}
                  onClick={() => void loadDirectory(item.path, 'push')}
                >
                  {item.label}
                </button>
                {index < items.length - 1 && <span className="breadcrumb-separator">/</span>}
              </span>
            ))}
          </nav>
          <button
            className="pane-header-button"
            type="button"
            disabled={backStack.length === 0 || Boolean(error)}
            aria-label="Back"
            title="Back"
            onClick={() => {
              const previous = backStack.at(-1)
              if (previous) void loadDirectory(previous, 'back')
            }}
          >
            <Icon name="back" />
          </button>
          <button
            className="pane-header-button"
            type="button"
            disabled={forwardStack.length === 0 || Boolean(error)}
            aria-label="Forward"
            title="Forward"
            onClick={() => {
              const next = forwardStack.at(-1)
              if (next) void loadDirectory(next, 'forward')
            }}
          >
            <Icon name="forward" />
          </button>
          <button
            className="pane-header-button"
            type="button"
            disabled={!parent || Boolean(error)}
            aria-label="Parent directory"
            title="Parent directory"
            onClick={() => parent && void loadDirectory(parent, 'push')}
          >
            <Icon name="up" />
          </button>
          <button
            className="pane-header-button"
            type="button"
            disabled={Boolean(error)}
            aria-label="Reload directory"
            title="Reload directory"
            onClick={() => void loadDirectory(currentPath)}
          >
            <Icon name="refresh" />
          </button>
        </div>
      </header>
      {error ? (
        <div className="pane-message error">
          <p>{error}</p>
          <button className="compact-button" type="button" onClick={() => void loadDirectory(currentPath)}>
            Try again
          </button>
        </div>
      ) : directory === null ? (
        <p className="pane-message">Loading local files...</p>
      ) : (
        // 空ディレクトリでも FileTable を描画する（空白右クリック New Folder / ショートカットを使えるように）。
        <FileTable
          entries={directory.entries}
          directoryKey={directory.path}
          paneKind="local"
          busy={busy}
          hasClipboard={hasClipboard}
          keyboardActive={keyboardActive}
          onOpenDirectory={(entryPath) => void loadDirectory(entryPath, 'push')}
          onFocusPane={onFocusPane}
          onAction={onAction}
          onOpenWith={onOpenWith}
        />
      )}
    </section>
  )
}

/**
 * 未接続タブ向けの接続選択ラッパー。
 */
function TabConnectionSelect({
  targets,
  onSelect,
  onSave,
  onDelete,
}: {
  targets: ConnectionTarget[]
  onSelect: (target: ConnectionTarget) => void
  onSave: (target: ConnectionTarget) => Promise<void> | void
  onDelete: (target: ConnectionTarget) => Promise<void> | void
}) {
  return (
    <section className="tab-connection-select">
      <div className="tab-connection-card">
        <ConnectionManager targets={targets} onSelect={onSelect} onSave={onSave} onDelete={onDelete} variant="tab" />
      </div>
    </section>
  )
}

/**
 * 接続先ごとのタブ、リモートペイン、任意のローカルペインをまとめる作業画面。
 * タブごとに接続先を保持し、接続編集結果を各タブへ反映する。
 */
export function FilerWorkspace({ target, targets, onSaveTarget, onDeleteTarget, onDisconnect }: FilerWorkspaceProps) {
  const [tabs, setTabs] = useState<TabsState>({
    tabs: [{ id: 'root', title: target.name }],
    activeId: 'root',
  })
  const [tabTargets, setTabTargets] = useState<Record<string, ConnectionTarget | null>>({
    root: target,
  })
  const [showLocalFiles, setShowLocalFiles] = useState(false)
  const [splitRatio, setSplitRatio] = useState(50)
  const paneGridRef = useRef<HTMLDivElement>(null)
  const nextTabNumber = useMemo(() => tabs.tabs.length + 1, [tabs.tabs.length])
  // 転送先決定のため、各ペインの現在ディレクトリを親で保持する。
  const [remoteDir, setRemoteDir] = useState('/')
  const [localDir, setLocalDir] = useState<string | null>(target.lastLocalPath ?? null)
  // 転送・削除完了時に該当ペインへ再ロードを促すためのトークン。
  const [remoteReloadToken, setRemoteReloadToken] = useState(0)
  const [localReloadToken, setLocalReloadToken] = useState(0)
  const [transfer, setTransfer] = useState<{ busy: boolean; message: string | null; error: string | null }>({
    busy: false,
    message: null,
    error: null,
  })
  const [editor, setEditor] = useState<{
    source: PaneKind
    entry: StorageEntry
    status: 'loading' | 'ready' | 'saving' | 'error'
    content: string
    error: string | null
    encoding: TextEncoding
    bom: boolean
    dirty: boolean
    readOnly: boolean
  } | null>(null)
  // Built-in Editor / Preview モーダルの位置とサイズ（移動・リサイズ用）。新規ファイルを開くたび中央へ reset。
  const [editorRect, setEditorRect] = useState<EditorRect | null>(null)
  // ドラッグ / リサイズ中の開始スナップショット（pointer 座標と開始時の矩形）。
  const editorDragRef = useRef<{ pointerX: number; pointerY: number; rect: EditorRect } | null>(null)
  // ドラッグ / リサイズ中の window リスナー解除関数。エディタが途中で閉じても確実に解除するため保持する。
  const editorDragTeardownRef = useRef<(() => void) | null>(null)
  // キーボードショートカットの対象ペイン。remote は常に表示されるため既定は remote。
  const [focusedPane, setFocusedPane] = useState<PaneKind>('remote')
  // アプリ内クリップボード。tab 切替後も保持し、接続設定スナップショットを含める。
  const [clipboard, setClipboard] = useState<{
    source: { kind: PaneKind; target: ConnectionTarget | null }
    entries: ClipboardEntry[]
  } | null>(null)
  // リモート外部編集セッション。明示的に Upload / Discard するまで保持する（プロセス終了で消さない）。
  const [externalSessions, setExternalSessions] = useState<
    { session: ExternalEditSession; status: 'open' | 'uploading' | 'uploaded' | 'error'; error: string | null }[]
  >([])
  // ディレクトリ作成 / リネーム共通の入力モーダル。submit に実処理を持たせる。
  // id は「この dialog インスタンス」を識別し、tab 切替後に開き直した別 dialog へ旧結果を注入しないために使う。
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null)
  const nameDialogSeq = useRef(0)

  // viewport 縮小後でもヘッダ/Close へ手が届くよう、モーダル矩形全体を再クランプする。
  useEffect(() => {
    if (!editor) return
    const handleResize = (): void => {
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      setEditorRect((current) => (current ? clampEditorRect(current, viewport) : current))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [editor])

  // エディタが閉じる / アンマウントしても、ドラッグ中の window リスナーを確実に解除する。
  useEffect(() => {
    if (editor) return
    editorDragTeardownRef.current?.()
  }, [editor])
  useEffect(() => () => editorDragTeardownRef.current?.(), [])

  /**
   * 接続未選択の新規タブを開く。
   */
  const addTab = (): void => {
    const id = `tab-${Date.now()}`
    setTabs((state) => openTab(state, { id, title: `New tab ${nextTabNumber}` }))
    setTabTargets((state) => ({ ...state, [id]: null }))
  }

  /**
   * アクティブタブへ接続先を割り当て、タブタイトルも接続名へ置き換える。
   */
  const selectConnection = (selectedTarget: ConnectionTarget): void => {
    const activeId = tabs.activeId
    if (!activeId) return

    setTabTargets((state) => ({ ...state, [activeId]: selectedTarget }))
    setTabs((state) => ({
      ...state,
      tabs: state.tabs.map((tab) => (tab.id === activeId ? { ...tab, title: selectedTarget.name } : tab)),
    }))
  }

  /**
   * 最後の1タブを閉じる場合だけワークスペース全体を閉じる。
   */
  const requestCloseTab = (id: string, title: string): void => {
    if (!window.confirm(`Close "${title}"?`)) return

    if (tabs.tabs.length === 1) {
      onDisconnect()
      return
    }

    setTabs((state) => closeTab(state, id))
    setTabTargets((state) => {
      const next = { ...state }
      delete next[id]
      return next
    })
  }

  const activeTarget = tabs.activeId ? tabTargets[tabs.activeId] : null

  // アクティブタブの接続先が変わったら、ペイン位置と転送状態をリセットする。
  useEffect(() => {
    setRemoteDir('/')
    setLocalDir(activeTarget?.lastLocalPath ?? null)
    setTransfer({ busy: false, message: null, error: null })
    setEditor(null)
    setNameDialog(null)
    setFocusedPane('remote')
  }, [activeTarget?.id])

  // 非同期操作の完了時に、その間にタブ / 接続先が切り替わっていないか判定するための現在スコープ。
  const activeScopeRef = useRef<{ tabId: string | null; targetId: string | null }>({
    tabId: tabs.activeId,
    targetId: activeTarget?.id ?? null,
  })
  useEffect(() => {
    activeScopeRef.current = { tabId: tabs.activeId, targetId: activeTarget?.id ?? null }
  })

  // 外部アプリから戻った（window focus）タイミングで dirty を取り直す。
  useEffect(() => {
    const onFocus = (): void => {
      void window.hedgeport
        .listExternalSessions()
        .then((list) =>
          setExternalSessions((current) =>
            list.map((session) => {
              const prev = current.find((item) => item.session.id === session.id)
              return { session, status: prev?.status ?? 'open', error: prev?.error ?? null }
            })
          )
        )
        .catch(() => undefined)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  /**
   * 操作開始時点のタブ / 接続先を記録する。
   */
  const captureScope = (): { tabId: string | null; targetId: string | null } => ({
    tabId: tabs.activeId,
    targetId: activeTarget?.id ?? null,
  })

  /**
   * 操作開始時のスコープが、完了時点でもまだアクティブか判定する。
   * 別タブ / 別接続先へ切り替わった後の reload や status 誤反映を防ぐ。
   */
  const isCurrentScope = (scope: { tabId: string | null; targetId: string | null }): boolean =>
    activeScopeRef.current.tabId === scope.tabId && activeScopeRef.current.targetId === scope.targetId

  /**
   * ローカルペインの現在位置を覚え、接続設定にも反映する。
   * 転送先（ダウンロード先）決定に使うため localDir も同期する。
   */
  const rememberLocalPath = (path: string): void => {
    setLocalDir(path)
    if (!activeTarget || activeTarget.lastLocalPath === path) return
    void saveTarget({ ...activeTarget, lastLocalPath: path })
  }

  /**
   * BatchOperationResult を status bar に集計表示する共通ランナー。
   * 成功があれば reload を呼び、部分失敗は件数と先頭メッセージを表示する。
   *
   * @param pending 実行中文言
   * @param doneNoun 完了時の名詞（例: 'Downloaded'）
   * @param action バッチ本体
   * @param onSuccessReload 1 件でも成功したら呼ぶ reload
   * @param presetScope ダイアログ待機後など、事前固定したスコープ
   */
  const runBatch = async (
    pending: string,
    doneNoun: string,
    action: () => Promise<BatchOperationResult>,
    onSuccessReload?: () => void,
    presetScope?: { tabId: string | null; targetId: string | null }
  ): Promise<void> => {
    const scope = presetScope ?? captureScope()
    setTransfer({ busy: true, message: pending, error: null })
    try {
      const result = await action()
      if (!isCurrentScope(scope)) return
      if (result.succeeded > 0) onSuccessReload?.()
      if (result.failures.length === 0) {
        setTransfer({ busy: false, message: `${doneNoun} ${result.succeeded}`, error: null })
      } else {
        setTransfer({
          busy: false,
          message: null,
          error: `${result.succeeded} succeeded, ${result.failures.length} failed (${result.failures[0].message})`,
        })
      }
    } catch (reason) {
      if (isCurrentScope(scope)) {
        setTransfer({
          busy: false,
          message: null,
          error: reason instanceof Error ? reason.message : 'Operation failed.',
        })
      }
    }
  }

  /**
   * 選択リモートファイル群をローカルの現在ディレクトリへ一括ダウンロードする。
   */
  const handleDownloadToLocal = (selection: StorageEntry[]): void => {
    if (!activeTarget || selection.length === 0) return
    if (!showLocalFiles || !localDir) {
      setTransfer({ busy: false, message: null, error: 'Open the local files pane to choose a download destination.' })
      return
    }
    const target = activeTarget
    const directory = localDir
    const paths = selection.map((entry) => entry.path)
    void runBatch(
      `Downloading ${paths.length}…`,
      'Downloaded',
      () => window.hedgeport.batchDownload(target, paths, directory),
      () => setLocalReloadToken((value) => value + 1)
    )
  }

  /**
   * 保存先ディレクトリをダイアログで選び、選択ファイル群を一括ダウンロードする（キャンセルは no-op）。
   */
  const handleDownloadToChosenDirectory = (selection: StorageEntry[]): void => {
    if (!activeTarget || selection.length === 0) return
    const target = activeTarget
    const scope = captureScope()
    const paths = selection.map((entry) => entry.path)
    void (async () => {
      const directory = await window.hedgeport.pickDirectory()
      if (!directory || !isCurrentScope(scope)) return
      await runBatch(
        `Downloading ${paths.length}…`,
        'Downloaded',
        () => window.hedgeport.batchDownload(target, paths, directory),
        () => {
          if (showLocalFiles && directory === localDir) setLocalReloadToken((value) => value + 1)
        },
        scope
      )
    })()
  }

  /**
   * 選択ローカルファイル群をリモートの現在ディレクトリへ一括アップロードする。
   */
  const handleUpload = (selection: StorageEntry[]): void => {
    if (!activeTarget || selection.length === 0) return
    const target = activeTarget
    const paths = selection.map((entry) => entry.path)
    void runBatch(
      `Uploading ${paths.length}…`,
      'Uploaded',
      () => window.hedgeport.batchUpload(target, paths, remoteDir),
      () => setRemoteReloadToken((value) => value + 1)
    )
  }

  /**
   * 選択リモートエントリ群を確認の上で一括削除する（file + directory）。
   */
  const handleDeleteRemote = (selection: StorageEntry[]): void => {
    if (!activeTarget || selection.length === 0) return
    if (!window.confirm(`Delete ${summarizeSelection(selection)}? This cannot be undone.`)) return
    const target = activeTarget
    const items = selection.map((entry) => ({ path: entry.path, type: entry.type }))
    void runBatch(
      `Deleting ${items.length}…`,
      'Deleted',
      () => window.hedgeport.batchDeleteRemote(target, items),
      () => setRemoteReloadToken((value) => value + 1)
    )
  }

  /**
   * 選択ローカルエントリ群を確認の上で一括削除する（directory は非再帰）。
   */
  const handleDeleteLocal = (selection: StorageEntry[]): void => {
    if (selection.length === 0) return
    if (!window.confirm(`Delete ${summarizeSelection(selection)}? This cannot be undone.`)) return
    const items = selection.map((entry) => ({ path: entry.path, type: entry.type }))
    void runBatch(
      `Deleting ${items.length}…`,
      'Deleted',
      () => window.hedgeport.batchDeleteLocal(items),
      () => setLocalReloadToken((value) => value + 1)
    )
  }

  /**
   * 選択（ファイルのみ）をアプリ内クリップボードへ記録する。
   */
  const handleCopy = (paneKind: PaneKind, selection: StorageEntry[]): void => {
    const files = selection.filter((entry) => entry.type === 'file')
    if (files.length === 0) return
    setClipboard({
      source: { kind: paneKind, target: paneKind === 'remote' ? activeTarget : null },
      entries: files.map((entry) => ({ path: entry.path, name: entry.name, type: entry.type })),
    })
    setTransfer({ busy: false, message: `Copied ${files.length}`, error: null })
  }

  /**
   * クリップボードの内容を focused ペインの現在ディレクトリへ貼り付ける。
   */
  const handlePaste = (destinationKind: PaneKind): void => {
    if (!clipboard || clipboard.entries.length === 0) return
    const directory = destinationKind === 'remote' ? remoteDir : localDir
    if (destinationKind === 'remote' ? !activeTarget : !directory) return
    void runBatch(
      `Pasting ${clipboard.entries.length}…`,
      'Pasted',
      () =>
        window.hedgeport.paste({
          entries: clipboard.entries,
          source: clipboard.source,
          destination: {
            kind: destinationKind,
            target: destinationKind === 'remote' ? activeTarget : null,
            directory: directory as string,
          },
        }),
      () => (destinationKind === 'remote' ? setRemoteReloadToken((v) => v + 1) : setLocalReloadToken((v) => v + 1))
    )
  }

  /**
   * 選択のパスを改行区切りでクリップボードへコピーする。
   */
  const handleCopyPath = (selection: StorageEntry[]): void => {
    if (selection.length === 0) return
    copyToClipboard(selection.map((entry) => entry.path).join('\n'))
    setTransfer({ busy: false, message: selection.length > 1 ? 'Copied paths' : 'Copied path', error: null })
  }

  /**
   * ローカルファイルを OS 既定アプリで開く。
   */
  const handleOpenLocal = (entry: StorageEntry): void => {
    void revealPath(entry.path, true)
  }

  /**
   * ローカルパスを Finder/Explorer で表示、または OS 既定アプリで開く。
   * 失敗（openPath が非空エラー文字列など）は status bar に表示する。
   *
   * @param path 対象の絶対パス
   * @param open true なら openLocalPath（開く）、false なら revealInFolder（表示）
   */
  const revealPath = async (path: string, open = false): Promise<void> => {
    try {
      if (open) await window.hedgeport.openLocalPath(path)
      else await window.hedgeport.revealInFolder(path)
    } catch (reason) {
      setTransfer({ busy: false, message: null, error: reason instanceof Error ? reason.message : 'Could not open.' })
    }
  }

  /**
   * remote / local のファイルを built-in editor（または preview=readOnly）で開く。
   *
   * @param source 'remote'（activeTarget 経由）または 'local'
   * @param entry 対象ファイル
   * @param readOnly preview のとき true
   */
  const openInEditor = (source: PaneKind, entry: StorageEntry, readOnly: boolean): void => {
    if (source === 'remote' && !activeTarget) return
    // 新規ファイルを開くたびに、中央・sensible サイズへ位置とサイズを reset する（viewport 内へクランプ）。
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const size = defaultEditorSize(viewport)
    setEditorRect(clampEditorRect({ ...centeredEditorPosition(size, viewport), ...size }, viewport))
    setEditor({
      source,
      entry,
      status: 'loading',
      content: '',
      error: null,
      encoding: 'utf-8',
      bom: false,
      dirty: false,
      readOnly,
    })
    // 初回は auto 判定で読み、検出された concrete encoding を後で表示する。
    loadEditorContent(source, entry, 'auto')
  }

  /**
   * 指定文字コードでファイルを読み込み、エディタへ反映する。source に応じ remote/local を使い分ける。
   * encoding は 'auto'（自動判定）または concrete。返却 doc は常に concrete encoding を持つ。
   * UTF-8 decode 失敗 / 判定不能時はモーダルを閉じず、文字コード選択を促すエラーを表示する。
   */
  const loadEditorContent = (source: PaneKind, entry: StorageEntry, encoding: ReadEncoding): void => {
    const scope = captureScope()
    const read =
      source === 'remote' && activeTarget
        ? window.hedgeport.readText(activeTarget, entry.path, encoding)
        : window.hedgeport.readLocalText(entry.path, encoding)
    read
      .then((document) =>
        setEditor((current) =>
          isCurrentScope(scope) && current && current.entry.path === entry.path
            ? {
                ...current,
                status: 'ready',
                content: document.text,
                error: null,
                encoding: document.encoding,
                bom: document.bom,
                dirty: false,
              }
            : current
        )
      )
      .catch((reason: unknown) =>
        setEditor((current) =>
          isCurrentScope(scope) && current && current.entry.path === entry.path
            ? {
                // encoding は concrete のみ保持する。auto 読みの失敗時は直前の concrete 値を維持し、
                // 手動切替の失敗時は changeEditorEncoding が設定済みの選択値を維持する。
                ...current,
                status: 'error',
                error: reason instanceof Error ? reason.message : 'Could not open file.',
              }
            : current
        )
      )
  }

  /**
   * 文字コードを切り替えて再読込する。未編集なら即時、編集済みなら確認後に行う。
   */
  const changeEditorEncoding = (encoding: TextEncoding): void => {
    if (!editor || editor.encoding === encoding) return
    if (editor.dirty && !window.confirm('Reload with another encoding? Unsaved changes will be lost.')) return
    setEditor((current) => (current ? { ...current, status: 'loading', error: null, encoding } : current))
    loadEditorContent(editor.source, editor.entry, encoding)
  }

  /**
   * 編集中テキストを現在の文字コードで保存し、成功時はモーダルを閉じて一覧を更新する。
   */
  const saveEditor = (): void => {
    if (!editor || editor.readOnly) return
    if (editor.source === 'remote' && !activeTarget) return
    const { source, entry, content, encoding, bom } = editor
    const target = activeTarget
    const scope = captureScope()
    setEditor((current) => (current ? { ...current, status: 'saving', error: null } : current))
    const write =
      source === 'remote' && target
        ? window.hedgeport.writeText(target, entry.path, content, encoding, bom)
        : window.hedgeport.writeLocalText(entry.path, content, encoding, bom)
    write
      .then(() => {
        // 保存中に別タブ / 別接続先へ切り替わっていたら、現在タブへ reload / status を誤反映しない。
        if (!isCurrentScope(scope)) return
        setEditor(null)
        if (source === 'remote') setRemoteReloadToken((value) => value + 1)
        else setLocalReloadToken((value) => value + 1)
        setTransfer({ busy: false, message: `Saved ${entry.name} (${encoding})`, error: null })
      })
      .catch((reason: unknown) => {
        // 旧タブの保存失敗を、新タブで開き直したエディタへ反映しない。
        if (!isCurrentScope(scope)) return
        setEditor((current) =>
          current
            ? { ...current, status: 'ready', error: reason instanceof Error ? reason.message : 'Could not save file.' }
            : current
        )
      })
  }

  /**
   * Open… の開き方選択を pane 別に振り分ける。
   */
  const handleOpenWith = (paneKind: PaneKind, mode: OpenMode, entry: StorageEntry): void => {
    switch (mode) {
      case 'preview':
        openInEditor(paneKind, entry, true)
        break
      case 'built-in':
        openInEditor(paneKind, entry, false)
        break
      case 'system-default':
        if (paneKind === 'local') void revealPath(entry.path, true)
        else void startRemoteExternalEdit(entry, 'system-default')
        break
      case 'choose-app':
        if (paneKind === 'local') {
          void window.hedgeport.chooseApplication(entry.path).catch((reason: unknown) =>
            setTransfer({
              busy: false,
              message: null,
              error: reason instanceof Error ? reason.message : 'Could not open.',
            })
          )
        } else {
          void startRemoteExternalEdit(entry, 'choose-app')
        }
        break
      default:
        break
    }
  }

  /**
   * リモートファイルを temp へ download して外部アプリで開き、外部編集セッションを開始する。
   * 同一ファイルの再オープンは main 側で既存セッションを再利用する（id 重複は banner に増やさない）。
   */
  const startRemoteExternalEdit = async (entry: StorageEntry, mode: OpenMode): Promise<void> => {
    if (!activeTarget) return
    try {
      const session = await window.hedgeport.startExternalEdit(activeTarget, entry.path, mode)
      if (!session) return // choose-app キャンセル
      setExternalSessions((current) => {
        if (current.some((item) => item.session.id === session.id)) return current
        return [...current, { session, status: 'open', error: null }]
      })
      setTransfer({ busy: false, message: `Editing ${entry.name} externally`, error: null })
    } catch (reason) {
      setTransfer({
        busy: false,
        message: null,
        error: reason instanceof Error ? reason.message : 'Could not open externally.',
      })
    }
  }

  /**
   * 外部編集の変更をリモートへ書き戻す（明示操作。自動 upload しない）。
   * conflict / エラーはセッション行に表示し、成功後はリモート一覧を更新する。
   */
  const uploadExternalSession = (id: string): void => {
    setExternalSessions((current) =>
      current.map((item) => (item.session.id === id ? { ...item, status: 'uploading', error: null } : item))
    )
    window.hedgeport
      .uploadExternalEdit(id)
      .then(() => {
        // upload 後は dirty=false（main snapshot 更新済み）。
        setExternalSessions((current) =>
          current.map((item) =>
            item.session.id === id
              ? { ...item, status: 'uploaded', error: null, session: { ...item.session, dirty: false } }
              : item
          )
        )
        setRemoteReloadToken((value) => value + 1)
      })
      .catch((reason: unknown) =>
        setExternalSessions((current) =>
          current.map((item) =>
            item.session.id === id
              ? { ...item, status: 'error', error: reason instanceof Error ? reason.message : 'Upload failed.' }
              : item
          )
        )
      )
  }

  /**
   * 外部編集を破棄して temp を片付け、banner から外す。
   */
  const discardExternalSession = (id: string): void => {
    void window.hedgeport.discardExternalEdit(id).finally(() => {
      setExternalSessions((current) => current.filter((item) => item.session.id !== id))
    })
  }

  /**
   * 外部編集の temp ファイルを Finder / Explorer で表示する。
   */
  const revealExternalSession = (id: string): void => {
    void window.hedgeport
      .revealExternalEdit(id)
      .catch((reason: unknown) =>
        setExternalSessions((current) =>
          current.map((item) =>
            item.session.id === id
              ? { ...item, status: 'error', error: reason instanceof Error ? reason.message : 'Could not reveal.' }
              : item
          )
        )
      )
  }

  /**
   * 名前入力モーダルを開く。id を採番し、tab 切替後に開いた別 dialog と区別できるようにする。
   */
  const openNameDialog = (config: {
    title: string
    label: string
    value: string
    submitLabel: string
    submit: (name: string) => Promise<void>
  }): void => {
    nameDialogSeq.current += 1
    setNameDialog({ ...config, id: nameDialogSeq.current, busy: false, error: null })
  }

  /**
   * 名前入力モーダルの送信。submit の例外はモーダル内にエラー表示し、開いたまま再入力できる。
   * close / error 反映は「同一 dialog インスタンスかつ現スコープ」のときだけ行い、
   * 旧 tab の失敗を新 tab で開いた別 dialog へ注入しない。
   */
  const submitNameDialog = (): void => {
    if (!nameDialog) return
    const { id, value, submit } = nameDialog
    const scope = captureScope()
    const reflectsCurrentDialog = (current: NameDialogState | null): current is NameDialogState =>
      current?.id === id && isCurrentScope(scope)
    setNameDialog((current) => (current && current.id === id ? { ...current, busy: true, error: null } : current))
    submit(value)
      .then(() => setNameDialog((current) => (reflectsCurrentDialog(current) ? null : current)))
      .catch((reason: unknown) =>
        setNameDialog((current) =>
          reflectsCurrentDialog(current)
            ? { ...current, busy: false, error: reason instanceof Error ? reason.message : 'Operation failed.' }
            : current
        )
      )
  }

  /**
   * リモートの現在ディレクトリ直下に新規フォルダを作る入力モーダルを開く。
   */
  const openNewFolderRemote = (): void => {
    if (!activeTarget) return
    const target = activeTarget
    const parentDir = remoteDir
    const scope = captureScope()
    openNameDialog({
      title: 'New folder',
      label: 'Folder name',
      value: '',
      submitLabel: 'Create',
      submit: async (name) => {
        await window.hedgeport.createRemoteDirectory(target, parentDir, name)
        if (!isCurrentScope(scope)) return
        setRemoteReloadToken((value) => value + 1)
        setTransfer({ busy: false, message: `Created ${name}`, error: null })
      },
    })
  }

  /**
   * ローカルの現在ディレクトリ直下に新規フォルダを作る入力モーダルを開く。
   */
  const openNewFolderLocal = (): void => {
    if (!localDir) {
      setTransfer({
        busy: false,
        message: null,
        error: 'Open the local files pane to choose where to create a folder.',
      })
      return
    }
    const parentDir = localDir
    const scope = captureScope()
    openNameDialog({
      title: 'New folder',
      label: 'Folder name',
      value: '',
      submitLabel: 'Create',
      submit: async (name) => {
        await window.hedgeport.createLocalDirectory(parentDir, name)
        if (!isCurrentScope(scope)) return
        setLocalReloadToken((value) => value + 1)
        setTransfer({ busy: false, message: `Created ${name}`, error: null })
      },
    })
  }

  /**
   * リモートエントリの改名モーダルを開く（初期値は現名称）。
   */
  const openRenameRemote = (entry: StorageEntry): void => {
    if (!activeTarget) return
    const target = activeTarget
    const scope = captureScope()
    openNameDialog({
      title: `Rename ${entry.name}`,
      label: 'New name',
      value: entry.name,
      submitLabel: 'Rename',
      submit: async (name) => {
        await window.hedgeport.renameRemote(target, entry.path, name, entry.type)
        if (!isCurrentScope(scope)) return
        setRemoteReloadToken((value) => value + 1)
        setTransfer({ busy: false, message: `Renamed to ${name}`, error: null })
      },
    })
  }

  /**
   * ローカルエントリの改名モーダルを開く（初期値は現名称）。
   */
  const openRenameLocal = (entry: StorageEntry): void => {
    const scope = captureScope()
    openNameDialog({
      title: `Rename ${entry.name}`,
      label: 'New name',
      value: entry.name,
      submitLabel: 'Rename',
      submit: async (name) => {
        await window.hedgeport.renameLocal(entry.path, name, entry.type)
        if (!isCurrentScope(scope)) return
        setLocalReloadToken((value) => value + 1)
        setTransfer({ busy: false, message: `Renamed to ${name}`, error: null })
      },
    })
  }

  /**
   * リモートペインのアクションを各ハンドラへ振り分ける。
   */
  const handleRemoteAction: ActionHandler = (id, selection) => {
    switch (id) {
      case 'open':
        // remote file の既定は Built-in Editor。
        if (selection[0]?.type === 'file') openInEditor('remote', selection[0], false)
        break
      case 'download-local':
        handleDownloadToLocal(selection)
        break
      case 'download-dialog':
        handleDownloadToChosenDirectory(selection)
        break
      case 'copy':
        handleCopy('remote', selection)
        break
      case 'paste':
        handlePaste('remote')
        break
      case 'rename':
        if (selection[0]) openRenameRemote(selection[0])
        break
      case 'copy-path':
        handleCopyPath(selection)
        break
      case 'delete':
        handleDeleteRemote(selection)
        break
      case 'new-folder':
        openNewFolderRemote()
        break
      default:
        break
    }
  }

  /**
   * ローカルペインのアクションを各ハンドラへ振り分ける。
   */
  const handleLocalAction: ActionHandler = (id, selection) => {
    switch (id) {
      case 'open':
        if (selection[0]?.type === 'file') handleOpenLocal(selection[0])
        break
      case 'upload':
        handleUpload(selection)
        break
      case 'copy':
        handleCopy('local', selection)
        break
      case 'paste':
        handlePaste('local')
        break
      case 'rename':
        if (selection[0]) openRenameLocal(selection[0])
        break
      case 'copy-path':
        handleCopyPath(selection)
        break
      case 'delete':
        handleDeleteLocal(selection)
        break
      case 'new-folder':
        openNewFolderLocal()
        break
      case 'reveal':
        if (selection[0]) void revealPath(selection[0].path)
        break
      case 'open-folder':
        if (localDir) void revealPath(localDir, true)
        break
      default:
        break
    }
  }

  /**
   * ポインタ移動で左右ペイン比率を更新する。
   */
  const resizeSplit = (event: PointerEvent<HTMLDivElement>): void => {
    const grid = paneGridRef.current
    if (!grid) return

    event.currentTarget.setPointerCapture(event.pointerId)
    const bounds = grid.getBoundingClientRect()
    const update = (clientX: number): void => {
      setSplitRatio(calculateSplitRatio(clientX, bounds.left, bounds.width))
    }

    const handleMove = (moveEvent: globalThis.PointerEvent): void => update(moveEvent.clientX)
    const handleEnd = (): void => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
      document.body.classList.remove('resizing-panes')
    }

    update(event.clientX)
    document.body.classList.add('resizing-panes')
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)
  }

  /**
   * モーダルのドラッグ / リサイズの pointer ループを開始する共通処理。
   * pointer capture で追従し、move ごとに updateRect で新しい矩形を計算・反映する。
   * 解除関数を editorDragTeardownRef へ保存し、エディタが途中で閉じても cleanup できるようにする。
   *
   * @param event 起点の pointerdown
   * @param updateRect 開始矩形と pointer 移動量(dx,dy)・viewport から新しい矩形を返す関数
   */
  const beginEditorPointerDrag = (
    event: PointerEvent<HTMLDivElement>,
    updateRect: (start: EditorRect, dx: number, dy: number, viewport: Viewport) => EditorRect
  ): void => {
    if (event.button !== 0 || !editorRect) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    editorDragRef.current = { pointerX: event.clientX, pointerY: event.clientY, rect: editorRect }

    const handleMove = (moveEvent: globalThis.PointerEvent): void => {
      const start = editorDragRef.current
      if (!start) return
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      setEditorRect(
        updateRect(start.rect, moveEvent.clientX - start.pointerX, moveEvent.clientY - start.pointerY, viewport)
      )
    }
    const teardown = (): void => {
      editorDragRef.current = null
      editorDragTeardownRef.current = null
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', teardown)
      window.removeEventListener('pointercancel', teardown)
    }
    editorDragTeardownRef.current = teardown
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', teardown)
    window.addEventListener('pointercancel', teardown)
  }

  /**
   * Built-in Editor / Preview モーダルを専用ハンドル（ヘッダのタイトル領域）でドラッグ移動する。
   * pointer capture で確実に追従し、矩形全体が viewport 内に収まるようクランプする。
   * ヘッダの操作系（encoding / BOM / Close）は別要素なのでドラッグ起点にならない。
   */
  const startEditorDrag = (event: PointerEvent<HTMLDivElement>): void => {
    beginEditorPointerDrag(event, (start, dx, dy, viewport) =>
      clampEditorRect({ ...start, x: start.x + dx, y: start.y + dy }, viewport)
    )
  }

  /**
   * モーダル右下のハンドルでリサイズする。左上を固定し、最大サイズは現在位置で使える領域に制限する
   * （右端・下端が画面外へ出ず、ヘッダ操作系・リサイズハンドルが常に到達可能）。
   */
  const startEditorResize = (event: PointerEvent<HTMLDivElement>): void => {
    event.stopPropagation()
    beginEditorPointerDrag(event, (start, dx, dy, viewport) => resizeEditorRect(start, dx, dy, viewport))
  }

  /**
   * キーボード操作でも分割比率を 5% 単位で調整できるようにする。
   */
  const resizeSplitWithKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = event.key === 'ArrowLeft' ? -5 : 5
    setSplitRatio((current) => Math.min(80, Math.max(20, current + delta)))
  }

  /**
   * 接続設定の変更を保存し、その接続を開いている全タブへ反映する。
   */
  const saveTarget = async (savedTarget: ConnectionTarget): Promise<void> => {
    await onSaveTarget(savedTarget)
    setTabTargets((current) => {
      const next = { ...current }
      for (const [tabId, tabTarget] of Object.entries(next)) {
        if (tabTarget?.id === savedTarget.id) next[tabId] = savedTarget
      }
      return next
    })
    setTabs((current) => ({
      ...current,
      tabs: current.tabs.map((tab) =>
        tabTargets[tab.id]?.id === savedTarget.id ? { ...tab, title: savedTarget.name } : tab
      ),
    }))
  }

  /**
   * 削除された接続を参照していたタブを未接続状態へ戻す。
   */
  const deleteTarget = async (deletedTarget: ConnectionTarget): Promise<void> => {
    await onDeleteTarget(deletedTarget)
    setTabTargets((current) => {
      const next = { ...current }
      for (const [tabId, tabTarget] of Object.entries(next)) {
        if (tabTarget?.id === deletedTarget.id) next[tabId] = null
      }
      return next
    })
    setTabs((current) => ({
      ...current,
      tabs: current.tabs.map((tab) =>
        tabTargets[tab.id]?.id === deletedTarget.id ? { ...tab, title: 'New tab' } : tab
      ),
    }))
  }

  return (
    <main className="workspace">
      <header className="workspace-bar">
        <nav className="tab-bar" aria-label="File tabs">
          {tabs.tabs.map((tab) => (
            <div className={tab.id === tabs.activeId ? 'tab active' : 'tab'} key={tab.id}>
              <button type="button" onClick={() => setTabs((state) => activateTab(state, tab.id))}>
                {tab.title}
              </button>
              <button
                className="tab-close"
                type="button"
                aria-label={`Close ${tab.title}`}
                title={`Close ${tab.title}`}
                onClick={() => requestCloseTab(tab.id, tab.title)}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
          <button className="new-tab" type="button" aria-label="New tab" title="New tab" onClick={addTab}>
            <Icon name="plus" />
          </button>
        </nav>

        <div className="toolbar-actions">
          <button
            className={showLocalFiles ? 'icon-button active' : 'icon-button'}
            type="button"
            aria-label={showLocalFiles ? 'Hide local files' : 'Show local files'}
            title={showLocalFiles ? 'Hide local files' : 'Show local files'}
            aria-pressed={showLocalFiles}
            onClick={() => setShowLocalFiles((value) => !value)}
          >
            <Icon name="columns" />
          </button>
          <span className="toolbar-divider" aria-hidden="true" />
          <button
            className="icon-button"
            type="button"
            aria-label="Back to connections"
            title="Back to connections"
            onClick={onDisconnect}
          >
            <Icon name="connections" />
          </button>
        </div>
      </header>

      {!activeTarget ? (
        <TabConnectionSelect
          targets={targets}
          onSelect={selectConnection}
          onSave={saveTarget}
          onDelete={deleteTarget}
        />
      ) : (
        <div
          ref={paneGridRef}
          className={showLocalFiles ? 'pane-grid split' : 'pane-grid'}
          style={
            showLocalFiles
              ? { gridTemplateColumns: `minmax(0, ${splitRatio}fr) 5px minmax(0, ${100 - splitRatio}fr)` }
              : undefined
          }
        >
          <RemoteFilePane
            key={`${tabs.activeId}-${activeTarget.id}`}
            target={activeTarget}
            onAction={handleRemoteAction}
            onOpenWith={(mode, entry) => handleOpenWith('remote', mode, entry)}
            onCurrentPathChange={setRemoteDir}
            onFocusPane={() => setFocusedPane('remote')}
            canDownloadToLocal={showLocalFiles && Boolean(localDir)}
            hasClipboard={Boolean(clipboard && clipboard.entries.length > 0)}
            busy={transfer.busy}
            keyboardActive={focusedPane === 'remote' && !editor && !nameDialog}
            reloadToken={remoteReloadToken}
          />
          {showLocalFiles && (
            <>
              <div
                className="pane-resizer"
                role="separator"
                aria-label="Resize file panes"
                aria-orientation="vertical"
                aria-valuemin={20}
                aria-valuemax={80}
                aria-valuenow={Math.round(splitRatio)}
                tabIndex={0}
                onPointerDown={resizeSplit}
                onKeyDown={resizeSplitWithKeyboard}
                onDoubleClick={() => setSplitRatio(50)}
              />
              {activeTarget && (
                <LocalFilePane
                  target={activeTarget}
                  onRememberPath={rememberLocalPath}
                  onAction={handleLocalAction}
                  onOpenWith={(mode, entry) => handleOpenWith('local', mode, entry)}
                  onFocusPane={() => setFocusedPane('local')}
                  hasClipboard={Boolean(clipboard && clipboard.entries.length > 0)}
                  busy={transfer.busy}
                  keyboardActive={focusedPane === 'local' && !editor && !nameDialog}
                  reloadToken={localReloadToken}
                />
              )}
            </>
          )}
        </div>
      )}

      {editor && (
        <div
          className="editor-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`${editor.readOnly ? 'Preview' : 'Edit'} ${editor.entry.name}`}
        >
          <div
            className="editor-modal editor-modal-floating"
            style={
              editorRect
                ? { width: editorRect.width, height: editorRect.height, left: editorRect.x, top: editorRect.y }
                : undefined
            }
          >
            <header className="editor-header">
              {/* タイトル領域だけをドラッグ起点にする（header の操作系はドラッグを開始しない）。 */}
              <h2 className="editor-drag-handle" title="Drag to move" onPointerDown={startEditorDrag}>
                {editor.readOnly ? 'Preview: ' : ''}
                {editor.entry.name}
              </h2>
              <div className="editor-header-tools">
                {/* 文字コード select は常設。変更時は未編集なら即再読込、編集済みは確認後。 */}
                <label className="editor-encoding">
                  <span>Encoding</span>
                  <select
                    aria-label="Encoding"
                    value={editor.encoding}
                    disabled={editor.status === 'saving'}
                    onChange={(event) => changeEditorEncoding(event.target.value as TextEncoding)}
                  >
                    {TEXT_ENCODINGS.map((encoding) => (
                      <option key={encoding} value={encoding}>
                        {encoding}
                      </option>
                    ))}
                  </select>
                </label>
                {/* BOM は utf-8 のときだけ意味を持つ。読み込み時の有無を保持し、切替は dirty 扱い。 */}
                {editor.encoding === 'utf-8' && (
                  <label className="editor-bom">
                    <input
                      type="checkbox"
                      aria-label="UTF-8 BOM"
                      checked={editor.bom}
                      disabled={editor.status === 'saving'}
                      onChange={(event) =>
                        setEditor((current) =>
                          current ? { ...current, bom: event.target.checked, dirty: true } : current
                        )
                      }
                    />
                    <span>BOM</span>
                  </label>
                )}
                <button
                  className="compact-button"
                  type="button"
                  aria-label="Close editor"
                  onClick={() => setEditor(null)}
                >
                  Close
                </button>
              </div>
            </header>
            {editor.status === 'loading' ? (
              <p className="pane-message">Loading file…</p>
            ) : editor.status === 'error' ? (
              // バイナリ/大容量や UTF-8 不正。文字コード select は header に常設されているので、
              // ここではエラー文言だけ出し、別 encoding 選択で再読込できる。
              <p className="pane-message error">{editor.error}</p>
            ) : (
              <>
                {editor.error && <p className="editor-error">{editor.error}</p>}
                <textarea
                  className="editor-textarea"
                  aria-label="File contents"
                  value={editor.content}
                  spellCheck={false}
                  readOnly={editor.readOnly}
                  disabled={editor.status === 'saving'}
                  autoFocus
                  onKeyDown={(event) => {
                    // editor 固有: Mod+S で保存（preview は不可）、Escape で閉じる。
                    if (event.key === 's' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      if (!editor.readOnly) saveEditor()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      setEditor(null)
                    }
                  }}
                  onChange={(event) =>
                    setEditor((current) =>
                      current ? { ...current, content: event.target.value, dirty: true } : current
                    )
                  }
                />
                <div className="editor-actions">
                  <button
                    className="compact-button"
                    type="button"
                    disabled={editor.status === 'saving'}
                    onClick={() => setEditor(null)}
                  >
                    {editor.readOnly ? 'Close' : 'Cancel'}
                  </button>
                  {!editor.readOnly && (
                    <button type="button" disabled={editor.status === 'saving'} onClick={saveEditor}>
                      {editor.status === 'saving' ? 'Saving…' : 'Save'}
                    </button>
                  )}
                </div>
              </>
            )}
            {/* 右下のリサイズハンドル（pointer events）。textarea などの上に重ねる。 */}
            <div
              className="editor-resize-handle"
              role="separator"
              aria-label="Resize editor"
              aria-orientation="horizontal"
              onPointerDown={startEditorResize}
            />
          </div>
        </div>
      )}

      {nameDialog && (
        <div className="editor-overlay" role="dialog" aria-modal="true" aria-label={nameDialog.title}>
          <div className="name-modal">
            <header className="editor-header">
              <h2>{nameDialog.title}</h2>
            </header>
            <label className="name-field">
              <span>{nameDialog.label}</span>
              <input
                aria-label={nameDialog.label}
                value={nameDialog.value}
                autoFocus
                disabled={nameDialog.busy}
                onChange={(event) =>
                  setNameDialog((current) => (current ? { ...current, value: event.target.value } : current))
                }
                onKeyDown={(event) => {
                  // 入力モーダル固有: Enter 実行 / Escape 取消。
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    submitNameDialog()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    setNameDialog(null)
                  }
                }}
              />
            </label>
            {nameDialog.error && <p className="editor-error">{nameDialog.error}</p>}
            <div className="editor-actions">
              <button
                className="compact-button"
                type="button"
                disabled={nameDialog.busy}
                onClick={() => setNameDialog(null)}
              >
                Cancel
              </button>
              <button type="button" disabled={nameDialog.busy} onClick={submitNameDialog}>
                {nameDialog.busy ? 'Working…' : nameDialog.submitLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {externalSessions.length > 0 && (
        <section className="external-edit-banner" aria-label="External edit sessions">
          {externalSessions.map(({ session, status, error }) => (
            <div key={session.id} className="external-edit-session">
              <span className="external-edit-name">
                Editing externally: <strong>{session.name}</strong>
                <span className={`external-edit-status ${status === 'error' ? 'is-error' : ''}`}>
                  {error ??
                    (status === 'uploaded'
                      ? 'uploaded'
                      : status === 'uploading'
                        ? 'uploading…'
                        : session.dirty
                          ? 'modified'
                          : 'clean')}
                </span>
              </span>
              <div className="external-edit-actions">
                <button
                  className="compact-button"
                  type="button"
                  disabled={status === 'uploading'}
                  onClick={() => uploadExternalSession(session.id)}
                >
                  Upload Changes
                </button>
                <button className="compact-button" type="button" onClick={() => revealExternalSession(session.id)}>
                  Reveal Local Copy
                </button>
                <button
                  className="compact-button"
                  type="button"
                  disabled={status === 'uploading'}
                  onClick={() => discardExternalSession(session.id)}
                >
                  Discard
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <footer className="status-bar">
        <span className={transfer.error ? 'status-error' : undefined}>
          {transfer.error ?? transfer.message ?? 'Ready'}
        </span>
        <span>list / read / write / delete / mkdir / rename</span>
      </footer>
    </main>
  )
}
