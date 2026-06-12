import { useState } from 'react'

import { ConnectionSelect } from './features/connection/ConnectionSelect'
import type { ConnectionTarget } from './features/connection/connectionTypes'
import { FilerWorkspace } from './features/filer/FilerWorkspace'
import { PreviewWindow } from './features/preview/PreviewWindow'

const connectionTargets: ConnectionTarget[] = [
  { id: 'sftp-placeholder', name: 'SFTP connection', kind: 'sftp' },
  { id: 's3-placeholder', name: 'S3 connection', kind: 's3' },
]

export function App() {
  const [selectedTarget, setSelectedTarget] = useState<ConnectionTarget | null>(null)

  if (window.location.hash === '#preview') {
    return <PreviewWindow />
  }

  if (selectedTarget) {
    return (
      <FilerWorkspace
        target={selectedTarget}
        targets={connectionTargets}
        onDisconnect={() => setSelectedTarget(null)}
      />
    )
  }

  return (
    <main className="connection-screen">
      <section className="connection-card">
        <div className="brand-mark">HP</div>
        <p className="eyebrow">HedgePort</p>
        <h1>Choose a connection</h1>
        <p className="muted">Select the storage workspace to open.</p>
        <ConnectionSelect targets={connectionTargets} onSelect={setSelectedTarget} />
        <button className="secondary-button" type="button" disabled>
          Add connection
        </button>
        <p className="scope-note">Connection persistence and authentication are planned for a later phase.</p>
      </section>
    </main>
  )
}
