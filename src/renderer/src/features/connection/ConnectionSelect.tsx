import { useState, type DragEvent } from 'react'

import type { DropPosition } from './connectionReorder'
import type { ConnectionTarget } from './connectionTypes'

interface ConnectionSelectProps {
  /** 表示する接続先一覧。空なら何も描画しない（空状態） */
  targets: ConnectionTarget[]
  /** 接続先が選択されたときに呼ばれる */
  onSelect: (target: ConnectionTarget) => void
  /** 接続先の編集が選択されたときに呼ばれる */
  onEdit?: (target: ConnectionTarget) => void
  /**
   * ドラッグ＆ドロップで並び替えたときに呼ばれる（welcome 画面でのみ渡す）。
   * 渡されたときだけ各行に drag handle を表示する。
   */
  onReorderDrop?: (sourceId: string, targetId: string, position: DropPosition) => void
  /** 保存中は新しいドラッグを始めさせない（drag handle を draggable=false にする） */
  reorderBusy?: boolean
}

/** ドラッグ payload に使う MIME。ID のみを載せる。 */
const DRAG_MIME = 'application/x-hedgeport-connection-id'

/**
 * 起動時の接続先選択画面。props 駆動のプレゼンテーショナルコンポーネント。
 * onReorderDrop が渡されたときだけ各行に drag handle を表示し、行同士のドラッグ＆ドロップで並び替える。
 * 接続選択 / 編集のクリック・キーボード操作は従来どおり維持する。
 * @param props 接続先一覧と各種ハンドラ
 * @returns 接続先ごとの選択ボタン一覧
 */
export function ConnectionSelect({
  targets,
  onSelect,
  onEdit,
  onReorderDrop,
  reorderBusy = false,
}: ConnectionSelectProps) {
  const canReorder = Boolean(onReorderDrop)
  // ドラッグ中の挿入位置インジケータ表示用。
  const [dropHint, setDropHint] = useState<{ overId: string; position: DropPosition } | null>(null)

  const handleDragStart = (event: DragEvent<HTMLElement>, target: ConnectionTarget): void => {
    event.dataTransfer.setData(DRAG_MIME, target.id)
    event.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (event: DragEvent<HTMLLIElement>, target: ConnectionTarget): void => {
    if (!canReorder || reorderBusy) return
    // drop を許可する（preventDefault しないと drop が発火しない）。
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const position: DropPosition = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setDropHint({ overId: target.id, position })
  }

  const handleDrop = (event: DragEvent<HTMLLIElement>, target: ConnectionTarget): void => {
    if (!canReorder || reorderBusy) return
    event.preventDefault()
    const sourceId = event.dataTransfer.getData(DRAG_MIME)
    const position = dropHint?.overId === target.id ? dropHint.position : 'before'
    setDropHint(null)
    // payload が無い（外部 drop 等）場合は無視。不明 id は純関数側で弾く。
    if (sourceId) onReorderDrop?.(sourceId, target.id, position)
  }

  return (
    <ul className="connection-list">
      {targets.map((target) => {
        const hintClass =
          dropHint?.overId === target.id ? (dropHint.position === 'before' ? 'drop-before' : 'drop-after') : ''
        return (
          <li
            key={target.id}
            className={['connection-item', hintClass].filter(Boolean).join(' ')}
            onDragOver={canReorder ? (event) => handleDragOver(event, target) : undefined}
            onDrop={canReorder ? (event) => handleDrop(event, target) : undefined}
          >
            {canReorder && (
              <span
                className="connection-drag-handle"
                aria-label={`Drag ${target.name} to reorder`}
                title="Drag to reorder"
                draggable={!reorderBusy}
                onDragStart={(event) => handleDragStart(event, target)}
                onDragEnd={() => setDropHint(null)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="9" cy="6" r="1.4" />
                  <circle cx="15" cy="6" r="1.4" />
                  <circle cx="9" cy="12" r="1.4" />
                  <circle cx="15" cy="12" r="1.4" />
                  <circle cx="9" cy="18" r="1.4" />
                  <circle cx="15" cy="18" r="1.4" />
                </svg>
              </span>
            )}
            <button
              className="connection-button"
              type="button"
              aria-label={target.name}
              onClick={() => onSelect(target)}
            >
              <span className="connection-kind">{target.kind.toUpperCase()}</span>
              <span>{target.name}</span>
              <svg className="connection-arrow" viewBox="0 0 24 24" aria-hidden="true">
                <path d="m9 5 7 7-7 7" />
              </svg>
            </button>
            {onEdit && (
              <button
                className="connection-edit"
                type="button"
                aria-label={`Edit ${target.name}`}
                title={`Edit ${target.name}`}
                onClick={() => onEdit(target)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m14 5 5 5M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z" />
                </svg>
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
