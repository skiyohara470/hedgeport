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

/**
 * 接続選択画面と接続編集フォームの切り替えを担う。
 * 一覧表示時は選択 UI、編集中は ConnectionForm へ責務を委譲する。
 */
export function ConnectionManager({
  targets,
  onSelect,
  onSave,
  onDelete,
  variant = 'welcome',
}: ConnectionManagerProps) {
  // undefined: フォームを閉じる, null: 新規作成, ConnectionTarget: 既存編集
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
