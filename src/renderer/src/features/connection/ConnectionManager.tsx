import { useState } from 'react'

import { ConnectionForm } from './ConnectionForm'
import { reorderConnections, type DropPosition } from './connectionReorder'
import { ConnectionSelect } from './ConnectionSelect'
import type { ConnectionTarget } from './connectionTypes'

interface ConnectionManagerProps {
  targets: ConnectionTarget[]
  onSelect: (target: ConnectionTarget) => void
  onSave: (target: ConnectionTarget) => Promise<void> | void
  onDelete: (target: ConnectionTarget) => Promise<void> | void
  variant?: 'welcome' | 'tab'
  /** 並び替え後の配列を受け取り永続化する（welcome のみ）。 */
  onReorder?: (targets: ConnectionTarget[]) => Promise<void> | void
  /** 並び替え保存中（保存完了まで新しいドラッグを抑止する）。 */
  reorderBusy?: boolean
}

/**
 * 接続選択画面と接続編集フォームの切り替えを担う。
 * 一覧表示時は選択 UI、編集中は ConnectionForm へ責務を委譲する。
 * 並び替え（ドラッグ＆ドロップ）は welcome 画面でのみ有効で、タブ内の New tab 接続選択には出さない。
 */
export function ConnectionManager({
  targets,
  onSelect,
  onSave,
  onDelete,
  variant = 'welcome',
  onReorder,
  reorderBusy = false,
}: ConnectionManagerProps) {
  // undefined: フォームを閉じる, null: 新規作成, ConnectionTarget: 既存編集
  const [formTarget, setFormTarget] = useState<ConnectionTarget | null | undefined>(undefined)
  const isFormOpen = formTarget !== undefined
  // 並び替えは welcome 画面でのみ有効。
  const canReorder = variant === 'welcome' && Boolean(onReorder)

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

  /**
   * ドラッグ＆ドロップの結果を並び替え配列に変換し、変化があるときだけ永続化を依頼する。
   */
  const handleReorderDrop = (sourceId: string, targetId: string, position: DropPosition): void => {
    if (!onReorder) return
    const next = reorderConnections(targets, sourceId, targetId, position)
    if (next) void onReorder(next)
  }

  return (
    <>
      {variant === 'welcome' && <div className="brand-mark">HP</div>}
      <p className="eyebrow">{variant === 'welcome' ? 'HedgePort' : 'New tab'}</p>
      <h1>Choose a connection</h1>
      <p className="muted">Select the storage workspace to open.</p>
      <ConnectionSelect
        targets={targets}
        onSelect={onSelect}
        onEdit={setFormTarget}
        onReorderDrop={canReorder ? handleReorderDrop : undefined}
        reorderBusy={reorderBusy}
      />
      {targets.length === 0 && <p className="empty-state">No connections yet.</p>}
      <button className="secondary-button" type="button" onClick={() => setFormTarget(null)}>
        Add connection
      </button>
      <p className="scope-note">Connections are stored locally in HedgePort's application data directory.</p>
    </>
  )
}
