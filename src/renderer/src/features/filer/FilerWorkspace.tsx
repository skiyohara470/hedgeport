import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'

import type { StorageEntry } from '../../../../shared/storage'
import { ConnectionManager } from '../connection/ConnectionManager'
import type { ConnectionTarget } from '../connection/connectionTypes'
import { emptySelection, selectEntry } from './selectionModel'
import { activateTab, closeTab, openTab, type TabsState } from './tabsModel'

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

type SortKey = 'name' | 'size' | 'modifiedAt'
type SortDirection = 'asc' | 'desc'
type PaneKind = 'remote' | 'local'

interface ContextMenuState {
  x: number
  y: number
  entry: StorageEntry
}

function ariaSortValue(key: SortKey, sortKey: SortKey, sortDirection: SortDirection): 'none' | 'ascending' | 'descending' {
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
 * 行コンテキストメニューの表示項目を組み立てる。
 * 現段階では文言と disabled 状態だけを持つプレースホルダ実装。
 */
function contextMenuItems(entry: StorageEntry, paneKind: PaneKind): Array<{ label: string; disabled?: boolean }> {
  const openLabel = entry.type === 'directory' ? 'Open' : 'Open'
  const transferLabel = paneKind === 'remote' ? 'Download' : 'Upload'

  return [
    { label: openLabel, disabled: entry.type === 'directory' ? false : false },
    { label: `${transferLabel} ${entry.type === 'directory' ? 'folder' : 'file'}` },
    { label: 'Copy path' },
    { label: 'Rename' },
    { label: 'Delete' },
    { label: 'Properties' },
  ]
}

/**
 * 単一ペイン分のファイル一覧テーブル。
 * 検索、ソート、複数選択、簡易コンテキストメニューをローカル state で持つ。
 */
function FileTable({
  entries,
  directoryKey,
  paneKind,
  s3FoldersHaveNoModifiedDate = false,
  onOpenDirectory,
}: {
  entries: StorageEntry[]
  directoryKey: string
  paneKind: PaneKind
  s3FoldersHaveNoModifiedDate?: boolean
  onOpenDirectory: (path: string) => void
}) {
  const [selection, setSelection] = useState(emptySelection)
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
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

  useEffect(() => {
    setSelection(emptySelection())
    setQuery('')
    setSortKey('name')
    setSortDirection('asc')
    setContextMenu(null)
  }, [directoryKey])

  useEffect(() => {
    const checkbox = selectAllRef.current
    if (!checkbox) return
    const selectedCount = visibleEntries.filter((entry) => selection.selectedPaths.has(entry.path)).length
    checkbox.checked = visibleEntries.length > 0 && selectedCount === visibleEntries.length
    checkbox.indeterminate = selectedCount > 0 && selectedCount < visibleEntries.length
  }, [selection.selectedPaths, visibleEntries])

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

  return (
    <div className="file-table-shell" onContextMenu={(event) => event.preventDefault()}>
      <div className="table-toolbar">
        <label className="search-box">
          <span>File search</span>
          <input
            value={query}
            placeholder="Search file names"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      {visibleEntries.length === 0 ? (
        <p className="pane-message">No files match this search.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="checkbox-cell">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  aria-label="Select all"
                  onChange={toggleSelectAll}
                />
              </th>
              <th aria-sort={ariaSortValue('name', sortKey, sortDirection)}>
                <button className="sort-button" type="button" onClick={() => toggleSort('name')}>
                  Name
                  <span aria-hidden="true">
                    {sortKey === 'name' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
                  </span>
                </button>
              </th>
              <th aria-sort={ariaSortValue('size', sortKey, sortDirection)}>
                <button className="sort-button" type="button" onClick={() => toggleSort('size')}>
                  Size
                  <span aria-hidden="true">
                    {sortKey === 'size' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
                  </span>
                </button>
              </th>
              <th aria-sort={ariaSortValue('modifiedAt', sortKey, sortDirection)}>
                <button
                  className="sort-button"
                  type="button"
                  onClick={() => toggleSort('modifiedAt')}
                >
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
                  className={[
                    entry.type === 'directory' ? 'directory-row' : '',
                    selected ? 'selected-row' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-selected={selected}
                  title={entry.type === 'directory' ? 'Double-click to open' : undefined}
                  onClick={(event) => select(event, entry.path)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    select(event, entry.path)
                    setContextMenu({ x: event.clientX, y: event.clientY, entry })
                  }}
                  onDoubleClick={
                    entry.type === 'directory' ? () => onOpenDirectory(entry.path) : undefined
                  }
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
                      <span
                        className={entry.type === 'directory' ? 'entry-icon folder' : 'entry-icon file'}
                      >
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
      {contextMenu && (
        <div
          className="context-menu"
          role="menu"
          aria-label={`${contextMenu.entry.name} actions`}
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          {contextMenuItems(contextMenu.entry, paneKind).map((item) => (
            <button key={item.label} type="button" role="menuitem" disabled={item.disabled}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * リモートストレージ側のファイルペイン。
 * パス移動と戻る/進む履歴を持ち、target 切替時にルートから再ロードする。
 */
export function RemoteFilePane({ target }: { target: ConnectionTarget }) {
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
  }, [target])

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
      ) : entries.length === 0 ? (
        <p className="pane-message">This directory is empty.</p>
      ) : (
        <FileTable
          entries={entries}
          directoryKey={path}
          paneKind="remote"
          s3FoldersHaveNoModifiedDate={target.kind === 's3'}
          onOpenDirectory={(entryPath) => void loadDirectory(entryPath, 'push')}
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
}: {
  target: ConnectionTarget
  onRememberPath: (path: string) => void
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
      ) : directory.entries.length === 0 ? (
        <p className="pane-message">This directory is empty.</p>
      ) : (
        <FileTable
          entries={directory.entries}
          directoryKey={directory.path}
          paneKind="local"
          onOpenDirectory={(entryPath) => void loadDirectory(entryPath, 'push')}
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
        <ConnectionManager
          targets={targets}
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
  onSaveTarget,
  onDeleteTarget,
  onDisconnect,
}: FilerWorkspaceProps) {
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
  /**
   * ローカルペインの現在位置を接続設定へ覚えさせる。
   */
  const rememberLocalPath = (path: string): void => {
    if (!activeTarget || activeTarget.lastLocalPath === path) return
    void saveTarget({ ...activeTarget, lastLocalPath: path })
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
          <button
            className="icon-button"
            type="button"
            aria-label="Open preview"
            title="Open preview"
            onClick={() => window.hedgeport.openPreview()}
          >
            <Icon name="eye" />
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
          <RemoteFilePane key={`${tabs.activeId}-${activeTarget.id}`} target={activeTarget} />
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
              {activeTarget && <LocalFilePane target={activeTarget} onRememberPath={rememberLocalPath} />}
            </>
          )}
        </div>
      )}

      <footer className="status-bar">
        <span>Ready</span>
        <span>list / read / write / delete</span>
      </footer>
    </main>
  )
}
