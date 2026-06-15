import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'

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
import type { HistoryDirection } from '../../../../shared/navigation'
import type { PreviewOpenRequest } from '../../../../shared/preview'
import { createDefaultSettings, type AppSettings, type Language } from '../../../../shared/settings'
import { mouseButtonDirection, reduceNavigation, type LastNavigation } from './mouseNavigation'
import { Icon, type IconName } from '../icons/Icon'
import { useTranslation } from '../i18n/I18nContext'
import { resolveMessage, type Message, type TranslationKey, type TranslationParams } from '../i18n/translations'
import { ConnectionManager } from '../connection/ConnectionManager'
import type { ConnectionTarget } from '../connection/connectionTypes'
import {
  describeActions,
  isTypingTarget,
  matchesShortcut,
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
const ACTION_ICON: Partial<Record<FileActionId, IconName>> = {
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

/**
 * 各ペインが公開する命令ハンドル。親はこれを通じて focus 中ペインの履歴だけを動かす。
 * navigate は非同期遷移の完了で解決し、親はこれを待って次の入力を逐次処理する。
 */
interface PaneHandle {
  navigate: (direction: HistoryDirection) => Promise<void>
}

/** main / DOM から受けたナビゲーション入力（キュー要素）。発生時点の宛先を固定する。 */
interface NavigationItem {
  direction: HistoryDirection
  pane: PaneKind
  tabId: string
}

/** ファイル操作のアクション実行ハンドラ（選択全体に作用する）。 */
type ActionHandler = (id: FileActionId, selection: StorageEntry[]) => void

/** 開き方選択ハンドラ。 */
type OpenWithHandler = (mode: OpenMode, entry: StorageEntry) => void

/** Open… で選べる開き方の一覧（ラベルは翻訳キーで保持し render 時に解決）。 */
const OPEN_MODE_ITEMS: { mode: OpenMode; labelKey: TranslationKey }[] = [
  { mode: 'preview', labelKey: 'openMode.preview' },
  { mode: 'built-in', labelKey: 'openMode.builtIn' },
  { mode: 'system-default', labelKey: 'openMode.systemDefault' },
  { mode: 'choose-app', labelKey: 'openMode.chooseApp' },
]

interface FilerWorkspaceProps {
  target: ConnectionTarget
  targets: ConnectionTarget[]
  /** 隠しファイル表示 / 削除確認に使う設定。未指定時は既定。 */
  settings?: AppSettings
  /** 設定モーダルを開く。 */
  onOpenSettings?: () => void
  onSaveTarget: (target: ConnectionTarget) => Promise<void> | void
  onDeleteTarget: (target: ConnectionTarget) => Promise<void> | void
  onDisconnect: () => void
}

function formatSize(size?: number): string {
  if (size === undefined) return '-'
  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`
  return `${(size / 1024 ** 3).toFixed(1)} GB`
}

/** 表示言語に対応する BCP47 ロケール（日付整形に使う）。 */
const DATE_LOCALES: Record<Language, string> = { ja: 'ja-JP', en: 'en-US' }

/**
 * 一覧表示用に更新日時を、アプリの表示言語に合わせて整形する。
 *
 * @param value ISO 日時文字列
 * @param language アプリ表示言語（OS ロケールではなく設定言語に追従）
 */
export function formatModifiedAt(value: string | undefined, language: Language): string {
  if (!value) return '-'
  return new Intl.DateTimeFormat(DATE_LOCALES[language], {
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

/** Built-in Editor モーダルの矩形（fixed 配置の左上座標とサイズ）。 */
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
  // 翻訳キーで保持し render 時に解決する（言語切替で固定ラベルも即時更新）。
  titleKey: TranslationKey
  titleParams?: TranslationParams
  labelKey: TranslationKey
  submitKey: TranslationKey
  value: string
  busy: boolean
  error: Message | null
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
  isBucketListRoot = false,
  showHiddenFiles = false,
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
  isBucketListRoot?: boolean
  showHiddenFiles?: boolean
  onOpenDirectory: (path: string) => void
  onFocusPane?: () => void
  onAction?: ActionHandler
  onOpenWith?: OpenWithHandler
}) {
  const { t, language } = useTranslation()
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
    () =>
      entries.filter((entry) => {
        // showHiddenFiles=false なら '.' 始まりの隠しエントリを除外する（local/SFTP/S3 共通）。
        if (!showHiddenFiles && entry.name.startsWith('.')) return false
        return entry.name.toLowerCase().includes(normalizedQuery)
      }),
    [entries, normalizedQuery, showHiddenFiles]
  )
  const visibleEntries = useMemo(
    () => sortEntries(filteredEntries, sortKey, sortDirection),
    [filteredEntries, sortKey, sortDirection]
  )
  const orderedPaths = visibleEntries.map((entry) => entry.path)

  // 現在の選択（エントリ実体）。表示中（filtered）エントリ基準にし、隠れた / 検索除外の選択は対象にしない。
  const selectionEntries = useMemo(
    () => visibleEntries.filter((entry) => selection.selectedPaths.has(entry.path)),
    [visibleEntries, selection.selectedPaths]
  )
  const actionContext: ActionContext = {
    paneKind,
    selection: selectionEntries,
    busy,
    canDownloadToLocal,
    hasClipboard,
    isBucketListRoot,
    t,
  }
  const actions = describeActions(actionContext)

  /**
   * アクションを実行する。ディレクトリの Open はペイン内移動、それ以外は親ハンドラへ委譲。
   * file の既定 Open（Enter / toolbar eye / context menu / ダブルクリック）は親ハンドラ経由で Preview を開く。
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
   * 行のダブルクリックで既定 Open を実行する。
   * ディレクトリはペイン内移動（S3 バケット一覧も同じ）。ファイルは既定 Open（親ハンドラ経由で Preview）。
   * Enter / eye button / context menu の Open と同じ経路（`onAction('open')`）を通し、重複を避ける。
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
            aria-label={t('pane.searchFiles')}
            value={query}
            placeholder={t('pane.searchFiles')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div
          className="pane-action-toolbar"
          role="toolbar"
          aria-label={t('table.paneActions', { pane: t(paneKind === 'remote' ? 'pane.remote' : 'pane.local') })}
        >
          {/* Open（eye 本体）＋ ▼（Open… 開き方選択）の split button。 */}
          <span className="split-button">
            <button
              className="icon-button"
              type="button"
              aria-label={t('action.open')}
              title={openAction?.shortcutLabel ? `${t('action.open')} (${openAction.shortcutLabel})` : t('action.open')}
              disabled={!openAction?.enabled}
              onClick={() => runAction('open')}
            >
              <Icon name="eye" />
            </button>
            <button
              className="split-button-caret"
              type="button"
              aria-label={t('action.openWithMenu')}
              aria-haspopup="menu"
              aria-expanded={openModeFor !== null}
              title={
                openWithAction?.shortcutLabel
                  ? `${t('action.openWith')} (${openWithAction.shortcutLabel})`
                  : t('action.openWith')
              }
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
          <p className="pane-message">
            {normalizedQuery ? t('pane.noSearchMatch') : isBucketListRoot ? t('pane.noBuckets') : t('pane.emptyDir')}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="checkbox-cell">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    aria-label={t('table.selectAll')}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th aria-sort={ariaSortValue('name', sortKey, sortDirection)}>
                  <button className="sort-button" type="button" onClick={() => toggleSort('name')}>
                    {t('table.name')}
                    <span aria-hidden="true">{sortKey === 'name' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
                  </button>
                </th>
                <th aria-sort={ariaSortValue('size', sortKey, sortDirection)}>
                  <button className="sort-button" type="button" onClick={() => toggleSort('size')}>
                    {t('table.size')}
                    <span aria-hidden="true">{sortKey === 'size' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
                  </button>
                </th>
                <th aria-sort={ariaSortValue('modifiedAt', sortKey, sortDirection)}>
                  <button className="sort-button" type="button" onClick={() => toggleSort('modifiedAt')}>
                    {t('table.modified')}
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
                    title={t('table.doubleClickToOpen')}
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
                        aria-label={t('table.select', { name: entry.name })}
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
                        s3FoldersHaveNoModifiedDate && entry.type === 'directory' ? t('table.s3NoDate') : undefined
                      }
                    >
                      {formatModifiedAt(entry.modifiedAt, language)}
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
          aria-label={
            contextMenu.entry ? t('table.entryActions', { name: contextMenu.entry.name }) : t('table.directoryActions')
          }
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
          aria-label={t('table.openModalAria', { name: openModeFor.name })}
          onClick={() => setOpenModeFor(null)}
        >
          <div className="open-mode-modal" role="menu" onClick={(event) => event.stopPropagation()}>
            <header className="editor-header">
              <h2>{t('table.openModalTitle', { name: openModeFor.name })}</h2>
            </header>
            {OPEN_MODE_ITEMS.map((item) => (
              <button
                key={item.mode}
                type="button"
                role="menuitem"
                onClick={() => {
                  const entry = openModeFor
                  setOpenModeFor(null)
                  onOpenWith(item.mode, entry)
                }}
              >
                <span>{t(item.labelKey)}</span>
              </button>
            ))}
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
export const RemoteFilePane = forwardRef<
  PaneHandle,
  {
    target: ConnectionTarget
    onAction?: ActionHandler
    onCurrentPathChange?: (path: string) => void
    onFocusPane?: () => void
    onOpenWith?: OpenWithHandler
    canDownloadToLocal?: boolean
    hasClipboard?: boolean
    busy?: boolean
    keyboardActive?: boolean
    showHiddenFiles?: boolean
    reloadToken?: number
  }
>(function RemoteFilePane(
  {
    target,
    onAction = () => undefined,
    onCurrentPathChange,
    onFocusPane,
    onOpenWith,
    canDownloadToLocal = false,
    hasClipboard = false,
    busy = false,
    keyboardActive = false,
    showHiddenFiles = false,
    reloadToken = 0,
  },
  ref
) {
  const { t } = useTranslation()
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<StorageEntry[]>([])
  const [error, setError] = useState<Message | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [backStack, setBackStack] = useState<string[]>([])
  const [forwardStack, setForwardStack] = useState<string[]>([])
  const pathRef = useRef(path)
  // 履歴とガード状態は ref でも保持し、連続入力（burst）でも同期的に最新値で判定・更新する。
  const backStackRef = useRef<string[]>([])
  const forwardStackRef = useRef<string[]>([])
  const loadingRef = useRef(true)
  const errorRef = useRef<Message | null>(null)

  /**
   * リモート一覧を読み込む。path / 履歴（back/forward stack）/ entries は read 成功時にのみ
   * 確定する（commit-on-success）。失敗時は現在地・履歴・表示をすべて保持し、error だけを立てる。
   * これにより list が reject しても breadcrumb / entries / 履歴が不整合にならず、再操作も可能。
   * キューが 1 件ずつ await するため、成功時の同期 ref 更新で連続ナビゲーション（burst）も整合する。
   */
  const loadDirectory = async (
    nextPath: string,
    history: 'push' | 'replace' | 'back' | 'forward' = 'replace'
  ): Promise<void> => {
    const currentPath = pathRef.current
    loadingRef.current = true
    setIsLoading(true)
    errorRef.current = null
    setError(null)
    try {
      const nextEntries = await window.hedgeport.listStorage(target, nextPath)
      // ここから先は成功確定。履歴 stack と path / entries を一括で確定する。
      if (history === 'push' && currentPath !== nextPath) {
        backStackRef.current = [...backStackRef.current, currentPath]
        forwardStackRef.current = []
      } else if (history === 'back') {
        backStackRef.current = backStackRef.current.slice(0, -1)
        forwardStackRef.current = [...forwardStackRef.current, currentPath]
      } else if (history === 'forward') {
        forwardStackRef.current = forwardStackRef.current.slice(0, -1)
        backStackRef.current = [...backStackRef.current, currentPath]
      }
      setBackStack(backStackRef.current)
      setForwardStack(forwardStackRef.current)
      pathRef.current = nextPath
      setPath(nextPath)
      setEntries(nextEntries)
      // 親が転送先（アップロード先）を決められるよう、現在のリモートディレクトリを伝える。
      onCurrentPathChange?.(nextPath)
    } catch (reason) {
      const message: Message = reason instanceof Error ? { raw: reason.message } : { key: 'pane.couldNotList' }
      errorRef.current = message
      setError(message)
    } finally {
      loadingRef.current = false
      setIsLoading(false)
    }
  }

  useEffect(() => {
    backStackRef.current = []
    forwardStackRef.current = []
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

  /**
   * 1 つ前のディレクトリへ戻る。ヘッダボタンも外部（マウス）要求も必ずこれを呼ぶ（履歴処理を複製しない）。
   * ガード / 履歴は ref で同期判定するため、連続入力でも 1 入力ごとに 1 段移動する。
   * 履歴なし / loading 中は no-op。error 中でも戻れる（known-good な履歴へ移り、error を解消できる）。
   */
  const navigateBack = (): Promise<void> => {
    if (loadingRef.current || backStackRef.current.length === 0) return Promise.resolve()
    const previous = backStackRef.current.at(-1)
    return previous ? loadDirectory(previous, 'back') : Promise.resolve()
  }
  /** 1 つ先のディレクトリへ進む。条件は navigateBack と対称。 */
  const navigateForward = (): Promise<void> => {
    if (loadingRef.current || forwardStackRef.current.length === 0) return Promise.resolve()
    const next = forwardStackRef.current.at(-1)
    return next ? loadDirectory(next, 'forward') : Promise.resolve()
  }

  // 親（FilerWorkspace）が focus 中ペインの履歴を動かすための命令ハンドル。
  // ヘッダボタンと同じ navigate 関数を使い、未知方向は no-op。
  useImperativeHandle(ref, () => ({
    navigate: (direction: HistoryDirection) =>
      direction === 'back' ? navigateBack() : direction === 'forward' ? navigateForward() : Promise.resolve(),
  }))

  const parent = parentPath(path)

  return (
    <section className="file-pane" onPointerDown={() => onFocusPane?.()}>
      <header className="pane-header">
        <span>{target.name}</span>
        <div className="pane-header-tools">
          <nav className="breadcrumbs" aria-label={t('pane.currentDirectory')}>
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
            aria-label={t('pane.back')}
            title={t('pane.back')}
            onClick={navigateBack}
          >
            <Icon name="back" />
          </button>
          <button
            className="pane-header-button"
            type="button"
            disabled={isLoading || forwardStack.length === 0}
            aria-label={t('pane.forward')}
            title={t('pane.forward')}
            onClick={navigateForward}
          >
            <Icon name="forward" />
          </button>
          <button
            className="pane-header-button"
            type="button"
            disabled={!parent || isLoading}
            aria-label={t('pane.parent')}
            title={t('pane.parent')}
            onClick={() => parent && void loadDirectory(parent, 'push')}
          >
            <Icon name="up" />
          </button>
          <button
            className="pane-header-button"
            type="button"
            disabled={isLoading}
            aria-label={t('pane.reload')}
            title={t('pane.reload')}
            onClick={() => void loadDirectory(path)}
          >
            <Icon name="refresh" />
          </button>
        </div>
      </header>
      {error ? (
        <div className="pane-message error">
          <p>{resolveMessage(t, error)}</p>
          <button className="compact-button" type="button" onClick={() => void loadDirectory(path)}>
            {t('common.tryAgain')}
          </button>
        </div>
      ) : isLoading ? (
        <p className="pane-message">{t('workspace.loadingRemote')}</p>
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
          isBucketListRoot={target.kind === 's3' && path === '/'}
          showHiddenFiles={showHiddenFiles}
          onOpenDirectory={(entryPath) => void loadDirectory(entryPath, 'push')}
          onFocusPane={onFocusPane}
          onAction={onAction}
          onOpenWith={onOpenWith}
        />
      )}
    </section>
  )
})

/**
 * ローカルファイル側のペイン。
 * 現在パスを target.lastLocalPath へ反映できるよう、親へ更新を返す。
 */
const LocalFilePane = forwardRef<
  PaneHandle,
  {
    target: ConnectionTarget
    onRememberPath: (path: string) => void
    onAction?: ActionHandler
    onOpenWith?: OpenWithHandler
    onFocusPane?: () => void
    hasClipboard?: boolean
    busy?: boolean
    keyboardActive?: boolean
    showHiddenFiles?: boolean
    reloadToken?: number
  }
>(function LocalFilePane(
  {
    target,
    onRememberPath,
    onAction = () => undefined,
    onOpenWith,
    onFocusPane,
    hasClipboard = false,
    busy = false,
    keyboardActive = false,
    showHiddenFiles = false,
    reloadToken = 0,
  },
  ref
) {
  const { t } = useTranslation()
  const [directory, setDirectory] = useState<LocalDirectory | null>(null)
  const [error, setError] = useState<Message | null>(null)
  const [backStack, setBackStack] = useState<string[]>([])
  const [forwardStack, setForwardStack] = useState<string[]>([])
  const pathRef = useRef(target.lastLocalPath ?? '/')
  const backStackRef = useRef<string[]>([])
  const forwardStackRef = useRef<string[]>([])
  const errorRef = useRef<Message | null>(null)
  const loadingRef = useRef(true)

  /**
   * ローカル一覧を読み込む。履歴 / pathRef / directory は read 成功時にのみ確定する
   * （commit-on-success）。履歴は listLocal が解決した実パス（nextDirectory.path）で更新する。
   * 失敗時は現在地・履歴・表示を保持し error だけを立てるため、breadcrumb / directory と
   * 履歴が不整合にならず再操作も可能。成功時の同期 ref 更新で連続ナビゲーションも整合する。
   */
  const loadDirectory = async (
    path?: string,
    history: 'push' | 'replace' | 'back' | 'forward' = 'replace'
  ): Promise<void> => {
    const currentPath = pathRef.current
    loadingRef.current = true
    errorRef.current = null
    setError(null)
    try {
      const nextDirectory = await window.hedgeport.listLocal(path)
      const nextPath = nextDirectory.path
      // ここから先は成功確定。解決後の実パスで履歴 stack と pathRef / directory を確定する。
      if (history === 'push' && currentPath !== nextPath) {
        backStackRef.current = [...backStackRef.current, currentPath]
        forwardStackRef.current = []
      } else if (history === 'back') {
        backStackRef.current = backStackRef.current.slice(0, -1)
        forwardStackRef.current = [...forwardStackRef.current, currentPath]
      } else if (history === 'forward') {
        forwardStackRef.current = forwardStackRef.current.slice(0, -1)
        backStackRef.current = [...backStackRef.current, currentPath]
      }
      setBackStack(backStackRef.current)
      setForwardStack(forwardStackRef.current)
      pathRef.current = nextPath
      setDirectory(nextDirectory)
      onRememberPath(nextPath)
    } catch (reason) {
      const message: Message = reason instanceof Error ? { raw: reason.message } : { key: 'pane.couldNotRead' }
      errorRef.current = message
      setError(message)
    } finally {
      loadingRef.current = false
    }
  }

  useEffect(() => {
    backStackRef.current = []
    forwardStackRef.current = []
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

  /**
   * 1 つ前のディレクトリへ戻る（ヘッダボタンと外部要求が共有）。
   * ガード / 履歴は ref で同期判定し、連続入力でも 1 入力ごとに 1 段移動する。loading 中は no-op。
   * error 中でも戻れる（known-good な履歴へ移り error を解消できる）。
   */
  const navigateBack = (): Promise<void> => {
    if (loadingRef.current || backStackRef.current.length === 0) return Promise.resolve()
    const previous = backStackRef.current.at(-1)
    return previous ? loadDirectory(previous, 'back') : Promise.resolve()
  }
  /** 1 つ先のディレクトリへ進む。 */
  const navigateForward = (): Promise<void> => {
    if (loadingRef.current || forwardStackRef.current.length === 0) return Promise.resolve()
    const next = forwardStackRef.current.at(-1)
    return next ? loadDirectory(next, 'forward') : Promise.resolve()
  }

  // 親（FilerWorkspace）が focus 中ペインの履歴を動かすための命令ハンドル。
  useImperativeHandle(ref, () => ({
    navigate: (direction: HistoryDirection) =>
      direction === 'back' ? navigateBack() : direction === 'forward' ? navigateForward() : Promise.resolve(),
  }))

  return (
    <section className="file-pane" onPointerDown={() => onFocusPane?.()}>
      <header className="pane-header">
        <span>{t('pane.localFiles')}</span>
        <div className="pane-header-tools">
          <nav className="breadcrumbs" aria-label={t('pane.currentDirectory')}>
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
            disabled={backStack.length === 0}
            aria-label={t('pane.back')}
            title={t('pane.back')}
            onClick={navigateBack}
          >
            <Icon name="back" />
          </button>
          <button
            className="pane-header-button"
            type="button"
            disabled={forwardStack.length === 0}
            aria-label={t('pane.forward')}
            title={t('pane.forward')}
            onClick={navigateForward}
          >
            <Icon name="forward" />
          </button>
          <button
            className="pane-header-button"
            type="button"
            disabled={!parent || Boolean(error)}
            aria-label={t('pane.parent')}
            title={t('pane.parent')}
            onClick={() => parent && void loadDirectory(parent, 'push')}
          >
            <Icon name="up" />
          </button>
          <button
            className="pane-header-button"
            type="button"
            disabled={Boolean(error)}
            aria-label={t('pane.reload')}
            title={t('pane.reload')}
            onClick={() => void loadDirectory(currentPath)}
          >
            <Icon name="refresh" />
          </button>
        </div>
      </header>
      {error ? (
        <div className="pane-message error">
          <p>{resolveMessage(t, error)}</p>
          <button className="compact-button" type="button" onClick={() => void loadDirectory(currentPath)}>
            {t('common.tryAgain')}
          </button>
        </div>
      ) : directory === null ? (
        <p className="pane-message">{t('pane.loadingLocal')}</p>
      ) : (
        // 空ディレクトリでも FileTable を描画する（空白右クリック New Folder / ショートカットを使えるように）。
        <FileTable
          entries={directory.entries}
          directoryKey={directory.path}
          paneKind="local"
          busy={busy}
          hasClipboard={hasClipboard}
          keyboardActive={keyboardActive}
          showHiddenFiles={showHiddenFiles}
          onOpenDirectory={(entryPath) => void loadDirectory(entryPath, 'push')}
          onFocusPane={onFocusPane}
          onAction={onAction}
          onOpenWith={onOpenWith}
        />
      )}
    </section>
  )
})

/**
 * 未接続タブ向けの接続選択ラッパー。
 */
function TabConnectionSelect({
  targets,
  settings,
  onSelect,
  onSave,
  onDelete,
}: {
  targets: ConnectionTarget[]
  settings: AppSettings
  onSelect: (target: ConnectionTarget) => void
  onSave: (target: ConnectionTarget) => Promise<void> | void
  onDelete: (target: ConnectionTarget) => Promise<void> | void
}) {
  return (
    <section className="tab-connection-select">
      <div className="tab-connection-card">
        <ConnectionManager
          targets={targets}
          settings={settings}
          onSelect={onSelect}
          onSave={onSave}
          onDelete={onDelete}
          variant="tab"
        />
      </div>
    </section>
  )
}

/**
 * 接続先ごとのタブ、リモートペイン、任意のローカルペインをまとめる作業画面。
 * タブごとに接続先を保持し、接続編集結果を各タブへ反映する。
 */
export function FilerWorkspace({
  target,
  targets,
  settings = createDefaultSettings('en'),
  onOpenSettings = () => undefined,
  onSaveTarget,
  onDeleteTarget,
  onDisconnect,
}: FilerWorkspaceProps) {
  const { t } = useTranslation()
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
  // status / error は構造化メッセージで保持し、言語切替時に再翻訳できるようにする。
  const [transfer, setTransfer] = useState<{ busy: boolean; status: Message | null; error: Message | null }>({
    busy: false,
    status: null,
    error: null,
  })
  const [editor, setEditor] = useState<{
    source: PaneKind
    entry: StorageEntry
    status: 'loading' | 'ready' | 'saving' | 'error'
    content: string
    error: Message | null
    encoding: TextEncoding
    bom: boolean
    dirty: boolean
  } | null>(null)
  // Built-in Editor モーダルの位置とサイズ（移動・リサイズ用）。新規ファイルを開くたび中央へ reset。
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
    { session: ExternalEditSession; status: 'open' | 'uploading' | 'uploaded' | 'error'; error: Message | null }[]
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
    if (!window.confirm(t('confirm.closeTab', { title }))) return

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

  // 各ペインへの命令ハンドル（focus 中ペインの履歴だけを動かすため imperative に保持）。
  const remotePaneRef = useRef<PaneHandle | null>(null)
  const localPaneRef = useRef<PaneHandle | null>(null)
  // ナビゲーション入力のキュー（順序保持し、非同期遷移を 1 件ずつ処理する）と重複抑止状態。
  const navQueueRef = useRef<NavigationItem[]>([])
  const navRunningRef = useRef(false)
  const lastNavRef = useRef<LastNavigation | null>(null)
  // 非同期処理中も最新の focus / active tab を参照するための ref。
  const focusedPaneRef = useRef(focusedPane)
  focusedPaneRef.current = focusedPane
  const activeIdRef = useRef(tabs.activeId)
  activeIdRef.current = tabs.activeId

  // キューを 1 件ずつ処理する。発生時点で固定した pane/tab が今も有効なときだけ、その pane を動かす。
  const drainNavQueue = useCallback(async (): Promise<void> => {
    if (navRunningRef.current) return
    navRunningRef.current = true
    try {
      let item = navQueueRef.current.shift()
      while (item) {
        // タブが切り替わっていたら、別タブの履歴は動かさない。
        if (item.tabId === activeIdRef.current) {
          const handle = item.pane === 'remote' ? remotePaneRef.current : localPaneRef.current
          // 対象ペインが未マウント（local 非表示等）なら no-op。
          if (handle) await handle.navigate(item.direction)
        }
        item = navQueueRef.current.shift()
      }
    } finally {
      navRunningRef.current = false
    }
  }, [])

  /**
   * 履歴ナビゲーション要求を受け、発生時点の focus 中ペイン / active tab を宛先に固定してキューへ積む。
   * dialog（aria-modal）表示中 / 入力フォーカス中 / 未接続では no-op。
   * IPC と DOM が同一物理入力を二重通知する環境では同方向・別 source の短時間重複だけ落とす。
   */
  const requestNavigate = useCallback(
    (direction: HistoryDirection, source: 'ipc' | 'dom'): void => {
      if (!activeIdRef.current || !(activeIdRef.current && tabTargets[activeIdRef.current])) return
      // editor / name dialog / settings / open-with など開いている aria-modal があれば無視。
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      if (isTypingTarget(document.activeElement)) return
      // dedupe: accept/reject に関わらず観測を記録する（reduceNavigation）。
      // こうしないと二重通知の片方を落とした後、直後の同 source 正規入力まで誤って落としてしまう。
      const { accept, last } = reduceNavigation(lastNavRef.current, { direction, source }, Date.now())
      lastNavRef.current = last
      if (!accept) return
      navQueueRef.current.push({ direction, pane: focusedPaneRef.current, tabId: activeIdRef.current })
      void drainNavQueue()
    },
    [drainNavQueue, tabTargets]
  )

  // main（マウス戻る/進む・swipe）からの履歴ナビゲーションを購読する。
  useEffect(() => {
    const unsubscribe = window.hedgeport.onHistoryNavigation?.((direction) => requestNavigate(direction, 'ipc'))
    return () => unsubscribe?.()
  }, [requestNavigate])

  // 補助マウスボタン（button 3/4）が DOM MouseEvent としてのみ来る環境にも対応し、既定動作を抑止する。
  useEffect(() => {
    const handler = (event: globalThis.MouseEvent): void => {
      const direction = mouseButtonDirection(event.button)
      if (!direction) return
      // Chromium 既定の履歴移動は常に抑止する（入力要素上でも誤遷移させない）。
      event.preventDefault()
      // mousedown 時点では focus がまだ移っておらず activeElement では拾えないため、
      // event.target が入力要素ならナビゲーションせず抑止だけ行う（activeElement 判定は requestNavigate 側で維持）。
      if (isTypingTarget(event.target)) return
      requestNavigate(direction, 'dom')
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [requestNavigate])

  // アクティブタブの接続先が変わったら、ペイン位置と転送状態をリセットする。
  useEffect(() => {
    setRemoteDir('/')
    setLocalDir(activeTarget?.lastLocalPath ?? null)
    setTransfer({ busy: false, status: null, error: null })
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
   * @param pendingKey 実行中の翻訳キー（params に count を渡す）
   * @param doneKey 完了時の翻訳キー（params.count = 成功件数）
   * @param count 実行対象件数（pending 表示用）
   * @param action バッチ本体
   * @param onSuccessReload 1 件でも成功したら呼ぶ reload
   * @param presetScope ダイアログ待機後など、事前固定したスコープ
   */
  const runBatch = async (
    pendingKey: TranslationKey,
    doneKey: TranslationKey,
    count: number,
    action: () => Promise<BatchOperationResult>,
    onSuccessReload?: () => void,
    presetScope?: { tabId: string | null; targetId: string | null }
  ): Promise<void> => {
    const scope = presetScope ?? captureScope()
    setTransfer({ busy: true, status: { key: pendingKey, params: { count } }, error: null })
    try {
      const result = await action()
      if (!isCurrentScope(scope)) return
      if (result.succeeded > 0) onSuccessReload?.()
      if (result.failures.length === 0) {
        setTransfer({ busy: false, status: { key: doneKey, params: { count: result.succeeded } }, error: null })
      } else {
        setTransfer({
          busy: false,
          status: null,
          // 先頭の失敗メッセージは main/server 由来のため raw を埋め込む。
          error: {
            key: 'status.batchPartial',
            params: {
              succeeded: result.succeeded,
              failed: result.failures.length,
              message: result.failures[0].message,
            },
          },
        })
      }
    } catch (reason) {
      if (isCurrentScope(scope)) {
        setTransfer({
          busy: false,
          status: null,
          error: reason instanceof Error ? { raw: reason.message } : { key: 'error.operationFailed' },
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
      setTransfer({ busy: false, status: null, error: { key: 'error.noDownloadDest' } })
      return
    }
    const target = activeTarget
    const directory = localDir
    const paths = selection.map((entry) => entry.path)
    void runBatch(
      'status.downloading',
      'status.downloaded',
      paths.length,
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
        'status.downloading',
        'status.downloaded',
        paths.length,
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
      'status.uploading',
      'status.uploaded',
      paths.length,
      () => window.hedgeport.batchUpload(target, paths, remoteDir),
      () => setRemoteReloadToken((value) => value + 1)
    )
  }

  /** 削除確認のメッセージ（選択内容の要約付き、件数表現は言語別キー）。 */
  const deleteConfirmMessage = (selection: StorageEntry[]): string => {
    if (selection.length === 1) {
      return t('confirm.deleteEntries', { summary: `“${selection[0].name}”` })
    }
    const fileCount = selection.filter((entry) => entry.type === 'file').length
    const dirCount = selection.length - fileCount
    const parts: string[] = []
    // 英語は単数/複数を明示キーで分岐（日本語は単複同形）。
    if (fileCount > 0) parts.push(t(fileCount === 1 ? 'summary.fileOne' : 'summary.fileMany', { count: fileCount }))
    if (dirCount > 0) parts.push(t(dirCount === 1 ? 'summary.folderOne' : 'summary.folderMany', { count: dirCount }))
    return t('confirm.deleteEntries', { summary: parts.join(t('summary.join')) })
  }

  /**
   * 選択リモートエントリ群を確認の上で一括削除する（file + directory）。
   */
  const handleDeleteRemote = (selection: StorageEntry[]): void => {
    if (!activeTarget || selection.length === 0) return
    // confirmBeforeDelete=false なら確認を省略する。
    if (settings.confirmBeforeDelete && !window.confirm(deleteConfirmMessage(selection))) return
    const target = activeTarget
    const items = selection.map((entry) => ({ path: entry.path, type: entry.type }))
    void runBatch(
      'status.deleting',
      'status.deleted',
      items.length,
      () => window.hedgeport.batchDeleteRemote(target, items),
      () => setRemoteReloadToken((value) => value + 1)
    )
  }

  /**
   * 選択ローカルエントリ群を確認の上で一括削除する（directory は非再帰）。
   */
  const handleDeleteLocal = (selection: StorageEntry[]): void => {
    if (selection.length === 0) return
    if (settings.confirmBeforeDelete && !window.confirm(deleteConfirmMessage(selection))) return
    const items = selection.map((entry) => ({ path: entry.path, type: entry.type }))
    void runBatch(
      'status.deleting',
      'status.deleted',
      items.length,
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
    setTransfer({ busy: false, status: { key: 'status.copied', params: { count: files.length } }, error: null })
  }

  /**
   * クリップボードの内容を focused ペインの現在ディレクトリへ貼り付ける。
   */
  const handlePaste = (destinationKind: PaneKind): void => {
    if (!clipboard || clipboard.entries.length === 0) return
    const directory = destinationKind === 'remote' ? remoteDir : localDir
    if (destinationKind === 'remote' ? !activeTarget : !directory) return
    void runBatch(
      'status.pasting',
      'status.pasted',
      clipboard.entries.length,
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
    setTransfer({
      busy: false,
      status: { key: selection.length > 1 ? 'status.copiedPaths' : 'status.copiedPath' },
      error: null,
    })
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
      setTransfer({
        busy: false,
        status: null,
        error: reason instanceof Error ? { raw: reason.message } : { key: 'error.couldNotOpen' },
      })
    }
  }

  /**
   * remote / local のファイルを独立プレビューウィンドウで開く。
   * 認証情報やローカル絶対パスは URL/hash へ載せず、main 管理セッションとして渡す。
   * 起動失敗（不正要求・接続なし等）は status bar へ構造化エラーで通知する。
   *
   * @param source 'remote'（activeTarget 経由）または 'local'
   * @param entry 対象ファイル
   */
  const openPreview = (source: PaneKind, entry: StorageEntry): void => {
    if (source === 'remote' && !activeTarget) return
    const request: PreviewOpenRequest =
      source === 'remote' && activeTarget
        ? { source: 'remote', target: activeTarget, path: entry.path, name: entry.name }
        : { source: 'local', path: entry.path, name: entry.name }
    void window.hedgeport.openPreview(request).catch((reason: unknown) =>
      setTransfer({
        busy: false,
        status: null,
        error: reason instanceof Error ? { raw: reason.message } : { key: 'error.couldNotOpen' },
      })
    )
  }

  /**
   * remote / local のファイルを built-in editor で開く（編集可能）。
   *
   * @param source 'remote'（activeTarget 経由）または 'local'
   * @param entry 対象ファイル
   */
  const openInEditor = (source: PaneKind, entry: StorageEntry): void => {
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
                error: reason instanceof Error ? { raw: reason.message } : { key: 'editor.couldNotOpenFile' },
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
    if (editor.dirty && !window.confirm(t('confirm.reloadEncoding'))) return
    setEditor((current) => (current ? { ...current, status: 'loading', error: null, encoding } : current))
    loadEditorContent(editor.source, editor.entry, encoding)
  }

  /**
   * 編集中テキストを現在の文字コードで保存し、成功時はモーダルを閉じて一覧を更新する。
   */
  const saveEditor = (): void => {
    if (!editor) return
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
        setTransfer({
          busy: false,
          status: { key: 'status.saved', params: { name: entry.name, encoding } },
          error: null,
        })
      })
      .catch((reason: unknown) => {
        // 旧タブの保存失敗を、新タブで開き直したエディタへ反映しない。
        if (!isCurrentScope(scope)) return
        setEditor((current) =>
          current
            ? {
                ...current,
                status: 'ready',
                error: reason instanceof Error ? { raw: reason.message } : { key: 'editor.couldNotSaveFile' },
              }
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
        openPreview(paneKind, entry)
        break
      case 'built-in':
        openInEditor(paneKind, entry)
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
              status: null,
              error: reason instanceof Error ? { raw: reason.message } : { key: 'error.couldNotOpen' },
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
      setTransfer({
        busy: false,
        status: { key: 'status.editingExternally', params: { name: entry.name } },
        error: null,
      })
    } catch (reason) {
      setTransfer({
        busy: false,
        status: null,
        error: reason instanceof Error ? { raw: reason.message } : { key: 'external.couldNotOpenExternally' },
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
              ? {
                  ...item,
                  status: 'error',
                  error: reason instanceof Error ? { raw: reason.message } : { key: 'external.uploadFailed' },
                }
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
    void window.hedgeport.revealExternalEdit(id).catch((reason: unknown) =>
      setExternalSessions((current) =>
        current.map((item) =>
          item.session.id === id
            ? {
                ...item,
                status: 'error',
                error: reason instanceof Error ? { raw: reason.message } : { key: 'external.couldNotReveal' },
              }
            : item
        )
      )
    )
  }

  /**
   * 名前入力モーダルを開く。id を採番し、tab 切替後に開いた別 dialog と区別できるようにする。
   */
  const openNameDialog = (config: {
    titleKey: TranslationKey
    titleParams?: TranslationParams
    labelKey: TranslationKey
    value: string
    submitKey: TranslationKey
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
            ? {
                ...current,
                busy: false,
                error: reason instanceof Error ? { raw: reason.message } : { key: 'error.operationFailed' },
              }
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
      titleKey: 'dialog.newFolderTitle',
      labelKey: 'dialog.folderName',
      value: '',
      submitKey: 'dialog.create',
      submit: async (name) => {
        await window.hedgeport.createRemoteDirectory(target, parentDir, name)
        if (!isCurrentScope(scope)) return
        setRemoteReloadToken((value) => value + 1)
        setTransfer({ busy: false, status: { key: 'status.created', params: { name } }, error: null })
      },
    })
  }

  /**
   * ローカルの現在ディレクトリ直下に新規フォルダを作る入力モーダルを開く。
   */
  const openNewFolderLocal = (): void => {
    if (!localDir) {
      setTransfer({ busy: false, status: null, error: { key: 'error.noFolderDest' } })
      return
    }
    const parentDir = localDir
    const scope = captureScope()
    openNameDialog({
      titleKey: 'dialog.newFolderTitle',
      labelKey: 'dialog.folderName',
      value: '',
      submitKey: 'dialog.create',
      submit: async (name) => {
        await window.hedgeport.createLocalDirectory(parentDir, name)
        if (!isCurrentScope(scope)) return
        setLocalReloadToken((value) => value + 1)
        setTransfer({ busy: false, status: { key: 'status.created', params: { name } }, error: null })
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
      titleKey: 'dialog.renameTitle',
      titleParams: { name: entry.name },
      labelKey: 'dialog.newName',
      value: entry.name,
      submitKey: 'dialog.rename',
      submit: async (name) => {
        await window.hedgeport.renameRemote(target, entry.path, name, entry.type)
        if (!isCurrentScope(scope)) return
        setRemoteReloadToken((value) => value + 1)
        setTransfer({ busy: false, status: { key: 'status.renamed', params: { name } }, error: null })
      },
    })
  }

  /**
   * ローカルエントリの改名モーダルを開く（初期値は現名称）。
   */
  const openRenameLocal = (entry: StorageEntry): void => {
    const scope = captureScope()
    openNameDialog({
      titleKey: 'dialog.renameTitle',
      titleParams: { name: entry.name },
      labelKey: 'dialog.newName',
      value: entry.name,
      submitKey: 'dialog.rename',
      submit: async (name) => {
        await window.hedgeport.renameLocal(entry.path, name, entry.type)
        if (!isCurrentScope(scope)) return
        setLocalReloadToken((value) => value + 1)
        setTransfer({ busy: false, status: { key: 'status.renamed', params: { name } }, error: null })
      },
    })
  }

  /**
   * リモートペインのアクションを各ハンドラへ振り分ける。
   */
  const handleRemoteAction: ActionHandler = (id, selection) => {
    switch (id) {
      case 'open':
        // remote file の既定 Open は Preview（独立ウィンドウ）。編集は Open… > Built-in Editor から。
        if (selection[0]?.type === 'file') openPreview('remote', selection[0])
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
        // local file の既定 Open は Preview（独立ウィンドウ）。OS 既定アプリは Open… > System Default から。
        if (selection[0]?.type === 'file') openPreview('local', selection[0])
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
   * Built-in Editor モーダルを専用ハンドル（ヘッダのタイトル領域）でドラッグ移動する。
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
        <nav className="tab-bar" aria-label={t('pane.fileTabs')}>
          {tabs.tabs.map((tab) => {
            // 未接続タブは 'New tab' プレースホルダを翻訳表示（接続名は data なので翻訳しない）。
            const tabTitle = tabTargets[tab.id] ? tab.title : t('pane.newTab')
            return (
              <div className={tab.id === tabs.activeId ? 'tab active' : 'tab'} key={tab.id}>
                <button type="button" onClick={() => setTabs((state) => activateTab(state, tab.id))}>
                  {tabTitle}
                </button>
                <button
                  className="tab-close"
                  type="button"
                  aria-label={t('pane.closeTab', { title: tabTitle })}
                  title={t('pane.closeTab', { title: tabTitle })}
                  onClick={() => requestCloseTab(tab.id, tabTitle)}
                >
                  <Icon name="close" />
                </button>
              </div>
            )
          })}
          <button
            className="new-tab"
            type="button"
            aria-label={t('pane.newTab')}
            title={t('pane.newTab')}
            onClick={addTab}
          >
            <Icon name="plus" />
          </button>
        </nav>

        <div className="toolbar-actions">
          <button
            className={showLocalFiles ? 'icon-button active' : 'icon-button'}
            type="button"
            aria-label={showLocalFiles ? t('workspace.hideLocal') : t('workspace.showLocal')}
            title={showLocalFiles ? t('workspace.hideLocal') : t('workspace.showLocal')}
            aria-pressed={showLocalFiles}
            onClick={() => setShowLocalFiles((value) => !value)}
          >
            <Icon name="columns" />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={t('settings.open')}
            title={t('settings.open')}
            onClick={onOpenSettings}
          >
            <Icon name="settings" />
          </button>
          <span className="toolbar-divider" aria-hidden="true" />
          <button
            className="icon-button"
            type="button"
            aria-label={t('workspace.disconnect')}
            title={t('workspace.disconnect')}
            onClick={onDisconnect}
          >
            <Icon name="connections" />
          </button>
        </div>
      </header>

      {!activeTarget ? (
        <TabConnectionSelect
          targets={targets}
          settings={settings}
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
            ref={remotePaneRef}
            target={activeTarget}
            onAction={handleRemoteAction}
            onOpenWith={(mode, entry) => handleOpenWith('remote', mode, entry)}
            onCurrentPathChange={setRemoteDir}
            onFocusPane={() => setFocusedPane('remote')}
            canDownloadToLocal={showLocalFiles && Boolean(localDir)}
            hasClipboard={Boolean(clipboard && clipboard.entries.length > 0)}
            busy={transfer.busy}
            keyboardActive={focusedPane === 'remote' && !editor && !nameDialog}
            showHiddenFiles={settings.showHiddenFiles}
            reloadToken={remoteReloadToken}
          />
          {showLocalFiles && (
            <>
              <div
                className="pane-resizer"
                role="separator"
                aria-label={t('pane.resizePanes')}
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
                  ref={localPaneRef}
                  target={activeTarget}
                  onRememberPath={rememberLocalPath}
                  onAction={handleLocalAction}
                  onOpenWith={(mode, entry) => handleOpenWith('local', mode, entry)}
                  onFocusPane={() => setFocusedPane('local')}
                  hasClipboard={Boolean(clipboard && clipboard.entries.length > 0)}
                  busy={transfer.busy}
                  keyboardActive={focusedPane === 'local' && !editor && !nameDialog}
                  showHiddenFiles={settings.showHiddenFiles}
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
          aria-label={t('editor.ariaEdit', { name: editor.entry.name })}
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
              <h2 className="editor-drag-handle" title={t('editor.dragToMove')} onPointerDown={startEditorDrag}>
                {editor.entry.name}
              </h2>
              <div className="editor-header-tools">
                {/* 文字コード select は常設。変更時は未編集なら即再読込、編集済みは確認後。 */}
                <label className="editor-encoding">
                  <span>{t('editor.encoding')}</span>
                  <select
                    aria-label={t('editor.encoding')}
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
                  aria-label={t('editor.closeAria')}
                  onClick={() => setEditor(null)}
                >
                  {t('common.close')}
                </button>
              </div>
            </header>
            {editor.status === 'loading' ? (
              <p className="pane-message">{t('editor.loading')}</p>
            ) : editor.status === 'error' ? (
              // バイナリ/大容量や UTF-8 不正。文字コード select は header に常設されているので、
              // ここではエラー文言だけ出し、別 encoding 選択で再読込できる。
              <p className="pane-message error">{editor.error && resolveMessage(t, editor.error)}</p>
            ) : (
              <>
                {editor.error && <p className="editor-error">{resolveMessage(t, editor.error)}</p>}
                <textarea
                  className="editor-textarea"
                  aria-label={t('editor.fileContents')}
                  value={editor.content}
                  spellCheck={false}
                  disabled={editor.status === 'saving'}
                  autoFocus
                  onKeyDown={(event) => {
                    // editor 固有: Mod+S で保存、Escape で閉じる。
                    if (event.key === 's' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      saveEditor()
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
                    {t('common.cancel')}
                  </button>
                  <button type="button" disabled={editor.status === 'saving'} onClick={saveEditor}>
                    {editor.status === 'saving' ? t('editor.saving') : t('common.save')}
                  </button>
                </div>
              </>
            )}
            {/* 右下のリサイズハンドル（pointer events）。textarea などの上に重ねる。 */}
            <div
              className="editor-resize-handle"
              role="separator"
              aria-label={t('editor.resizeAria')}
              aria-orientation="horizontal"
              onPointerDown={startEditorResize}
            />
          </div>
        </div>
      )}

      {nameDialog && (
        <div
          className="editor-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t(nameDialog.titleKey, nameDialog.titleParams)}
        >
          <div className="name-modal">
            <header className="editor-header">
              <h2>{t(nameDialog.titleKey, nameDialog.titleParams)}</h2>
            </header>
            <label className="name-field">
              <span>{t(nameDialog.labelKey)}</span>
              <input
                aria-label={t(nameDialog.labelKey)}
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
            {nameDialog.error && <p className="editor-error">{resolveMessage(t, nameDialog.error)}</p>}
            <div className="editor-actions">
              <button
                className="compact-button"
                type="button"
                disabled={nameDialog.busy}
                onClick={() => setNameDialog(null)}
              >
                {t('common.cancel')}
              </button>
              <button type="button" disabled={nameDialog.busy} onClick={submitNameDialog}>
                {nameDialog.busy ? t('dialog.working') : t(nameDialog.submitKey)}
              </button>
            </div>
          </div>
        </div>
      )}

      {externalSessions.length > 0 && (
        <section className="external-edit-banner" aria-label={t('external.sessionsAria')}>
          {externalSessions.map(({ session, status, error }) => (
            <div key={session.id} className="external-edit-session">
              <span className="external-edit-name">
                {t('external.editingExternally')} <strong>{session.name}</strong>
                <span className={`external-edit-status ${status === 'error' ? 'is-error' : ''}`}>
                  {error
                    ? resolveMessage(t, error)
                    : status === 'uploaded'
                      ? t('external.uploaded')
                      : status === 'uploading'
                        ? t('external.uploading')
                        : session.dirty
                          ? t('external.modified')
                          : t('external.clean')}
                </span>
              </span>
              <div className="external-edit-actions">
                <button
                  className="compact-button"
                  type="button"
                  disabled={status === 'uploading'}
                  onClick={() => uploadExternalSession(session.id)}
                >
                  {t('external.uploadChanges')}
                </button>
                <button className="compact-button" type="button" onClick={() => revealExternalSession(session.id)}>
                  {t('external.revealLocal')}
                </button>
                <button
                  className="compact-button"
                  type="button"
                  disabled={status === 'uploading'}
                  onClick={() => discardExternalSession(session.id)}
                >
                  {t('external.discard')}
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <footer className="status-bar">
        <span className={transfer.error ? 'status-error' : undefined}>
          {transfer.error
            ? resolveMessage(t, transfer.error)
            : transfer.status
              ? resolveMessage(t, transfer.status)
              : t('status.ready')}
        </span>
        <span>list / read / write / delete / mkdir / rename</span>
      </footer>
    </main>
  )
}
