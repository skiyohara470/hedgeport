import { useState } from 'react'

import { ConnectionForm } from './ConnectionForm'
import { ConnectionSelect } from './ConnectionSelect'
import type { ConnectionTarget } from './connectionTypes'

interface ConnectionManagerProps {
  targets: ConnectionTarget[]
  onSelect: (target: ConnectionTarget) => void
  onSave: (target: ConnectionTarget) => Promise<void> | void
  onDelete: (target: ConnectionTarget) => Promise<void> | void
  variant?: 'welcome' | 'tab'
}

export function ConnectionManager({
  targets,
  onSelect,
  onSave,
  onDelete,
  variant = 'welcome',
}: ConnectionManagerProps) {
  const [formTarget, setFormTarget] = useState<ConnectionTarget | null | undefined>(undefined)
  const isFormOpen = formTarget !== undefined

  if (isFormOpen) {
    return (
      <ConnectionForm
        target={formTarget ?? undefined}
        onCancel={() => setFormTarget(undefined)}
        onDelete={
          formTarget
            ? async () => {
                if (!window.confirm(`Delete "${formTarget.name}"? This cannot be undone.`)) return
                await onDelete(formTarget)
                setFormTarget(undefined)
              }
            : undefined
        }
        onSave={async (target) => {
          await onSave(target)
          setFormTarget(undefined)
        }}
      />
    )
  }

  return (
    <>
      {variant === 'welcome' && <div className="brand-mark">HP</div>}
      <p className="eyebrow">{variant === 'welcome' ? 'HedgePort' : 'New tab'}</p>
      <h1>Choose a connection</h1>
      <p className="muted">Select the storage workspace to open.</p>
      <ConnectionSelect targets={targets} onSelect={onSelect} onEdit={setFormTarget} />
      {targets.length === 0 && <p className="empty-state">No connections yet.</p>}
      <button className="secondary-button" type="button" onClick={() => setFormTarget(null)}>
        Add connection
      </button>
      <p className="scope-note">Connections are stored locally in HedgePort's application data directory.</p>
    </>
  )
}
