import { useEffect, useMemo, useState } from 'react'

import { ConnectionSelect } from '../connection/ConnectionSelect'
import type { ConnectionTarget } from '../connection/connectionTypes'
import { activateTab, closeTab, openTab, type TabsState } from './tabsModel'

interface FilerWorkspaceProps {
  target: ConnectionTarget
  targets: ConnectionTarget[]
  onDisconnect: () => void
}

interface PaneProps {
  label: string
  path: string
}

interface IconProps {
  name: 'columns' | 'eye' | 'connections' | 'plus' | 'close' | 'up'
}

function Icon({ name }: IconProps) {
  const paths = {
    columns: <path d="M4 5h16v14H4zM12 5v14" />,
    eye: <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Zm9.5 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />,
    connections: <path d="M9 7 4 12l5 5M4 12h12M15 4h5v16h-5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m7 7 10 10M17 7 7 17" />,
    up: <path d="m6 14 6-6 6 6" />,
  }

  return (
    <svg className="button-icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

const remoteEntries = [
  { name: 'archive', type: 'Folder', size: '-' },
  { name: 'incoming', type: 'Folder', size: '-' },
  { name: 'README.md', type: 'Markdown', size: '4 KB' },
  { name: 'report-2026.csv', type: 'CSV', size: '128 KB' },
]

function RemoteFilePane({ label, path }: PaneProps) {
  return (
    <section className="file-pane">
      <header className="pane-header">
        <span>{label}</span>
        <span className="path">{path}</span>
      </header>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Size</th>
          </tr>
        </thead>
        <tbody>
          {remoteEntries.map((entry) => (
            <tr key={entry.name}>
              <td>{entry.name}</td>
              <td>{entry.type}</td>
              <td>{entry.size}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="placeholder-note">Layout placeholder. StorageProvider data is not connected yet.</p>
    </section>
  )
}

function LocalFilePane() {
  const [directory, setDirectory] = useState<LocalDirectory | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadDirectory = async (path?: string): Promise<void> => {
    try {
      setError(null)
      setDirectory(await window.hedgeport.listLocal(path))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not read this directory.')
    }
  }

  useEffect(() => {
    void loadDirectory()
  }, [])

  return (
    <section className="file-pane">
      <header className="pane-header">
        <span>Local files</span>
        <span className="path">{directory?.path ?? 'Loading...'}</span>
      </header>
      {directory?.parentPath && (
        <button
          className="compact-button parent-directory"
          type="button"
          title="Up one directory"
          onClick={() => void loadDirectory(directory.parentPath!)}
        >
          <Icon name="up" />
          <span>Parent</span>
        </button>
      )}
      {error ? (
        <p className="pane-error">{error}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {directory?.entries.map((entry) => (
              <tr key={entry.path}>
                <td>
                  {entry.type === 'directory' ? (
                    <button className="directory-link" type="button" onClick={() => void loadDirectory(entry.path)}>
                      {entry.name}
                    </button>
                  ) : (
                    entry.name
                  )}
                </td>
                <td>{entry.type === 'directory' ? 'Folder' : 'File'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function TabConnectionSelect({
  targets,
  onSelect,
}: {
  targets: ConnectionTarget[]
  onSelect: (target: ConnectionTarget) => void
}) {
  return (
    <section className="tab-connection-select">
      <div className="tab-connection-card">
        <p className="eyebrow">New tab</p>
        <h1>Choose a connection</h1>
        <p className="muted">Select the storage workspace to open in this tab.</p>
        <ConnectionSelect targets={targets} onSelect={onSelect} />
      </div>
    </section>
  )
}

export function FilerWorkspace({ target, targets, onDisconnect }: FilerWorkspaceProps) {
  const [tabs, setTabs] = useState<TabsState>({
    tabs: [{ id: 'root', title: target.name }],
    activeId: 'root',
  })
  const [tabTargets, setTabTargets] = useState<Record<string, ConnectionTarget | null>>({
    root: target,
  })
  const [showLocalFiles, setShowLocalFiles] = useState(false)
  const nextTabNumber = useMemo(() => tabs.tabs.length + 1, [tabs.tabs.length])

  const addTab = (): void => {
    const id = `tab-${Date.now()}`
    setTabs((state) => openTab(state, { id, title: `New tab ${nextTabNumber}` }))
    setTabTargets((state) => ({ ...state, [id]: null }))
  }

  const selectConnection = (selectedTarget: ConnectionTarget): void => {
    const activeId = tabs.activeId
    if (!activeId) return

    setTabTargets((state) => ({ ...state, [activeId]: selectedTarget }))
    setTabs((state) => ({
      ...state,
      tabs: state.tabs.map((tab) => (tab.id === activeId ? { ...tab, title: selectedTarget.name } : tab)),
    }))
  }

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
        <TabConnectionSelect targets={targets} onSelect={selectConnection} />
      ) : (
        <div className={showLocalFiles ? 'pane-grid split' : 'pane-grid'}>
          <RemoteFilePane label="Remote files" path="/" />
          {showLocalFiles && <LocalFilePane />}
        </div>
      )}

      <footer className="status-bar">
        <span>Ready</span>
        <span>list / read / write / delete</span>
      </footer>
    </main>
  )
}
