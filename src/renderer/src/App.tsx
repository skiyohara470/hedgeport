import { useEffect, useState } from 'react'

import { ConnectionManager } from './features/connection/ConnectionManager'
import type { ConnectionTarget } from './features/connection/connectionTypes'
import { FilerWorkspace } from './features/filer/FilerWorkspace'
import { PreviewWindow } from './features/preview/PreviewWindow'

export function App() {
  const [targets, setTargets] = useState<ConnectionTarget[]>([])
  const [selectedTarget, setSelectedTarget] = useState<ConnectionTarget | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [storageError, setStorageError] = useState<string | null>(null)

  useEffect(() => {
    void window.hedgeport
      .loadConnections()
      .then(setTargets)
      .catch((error: unknown) => {
        setStorageError(error instanceof Error ? error.message : 'Could not load connections.')
      })
      .finally(() => setIsLoading(false))
  }, [])

  const saveTarget = async (target: ConnectionTarget): Promise<void> => {
    const exists = targets.some((item) => item.id === target.id)
    const next = exists ? targets.map((item) => (item.id === target.id ? target : item)) : [...targets, target]
    await window.hedgeport.saveConnections(next)
    setTargets(next)
    setStorageError(null)
    setSelectedTarget((current) => (current?.id === target.id ? target : current))
  }

  const deleteTarget = async (target: ConnectionTarget): Promise<void> => {
    const next = targets.filter((item) => item.id !== target.id)
    await window.hedgeport.saveConnections(next)
    setTargets(next)
    setStorageError(null)
    setSelectedTarget((current) => (current?.id === target.id ? null : current))
  }

  if (window.location.hash === '#preview') {
    return <PreviewWindow />
  }

  if (isLoading) {
    return (
      <main className="connection-screen">
        <p className="loading-state">Loading connections...</p>
      </main>
    )
  }

  if (selectedTarget) {
    return (
      <FilerWorkspace
        target={selectedTarget}
        targets={targets}
        onSaveTarget={saveTarget}
        onDeleteTarget={deleteTarget}
        onDisconnect={() => setSelectedTarget(null)}
      />
    )
  }

  return (
    <main className="connection-screen">
      <section className="connection-card">
        {storageError && <p className="storage-error">{storageError}</p>}
        <ConnectionManager
          targets={targets}
          onSelect={setSelectedTarget}
          onSave={saveTarget}
          onDelete={deleteTarget}
        />
      </section>
    </main>
  )
}
