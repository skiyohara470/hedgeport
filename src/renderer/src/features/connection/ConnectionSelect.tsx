import type { ConnectionTarget } from './connectionTypes'

interface ConnectionSelectProps {
  /** 表示する接続先一覧。空なら何も描画しない（空状態） */
  targets: ConnectionTarget[]
  /** 接続先が選択されたときに呼ばれる */
  onSelect: (target: ConnectionTarget) => void
  /** 接続先の編集が選択されたときに呼ばれる */
  onEdit?: (target: ConnectionTarget) => void
}

/**
 * 起動時の接続先選択画面。props 駆動のプレゼンテーショナルコンポーネントで、
 * 接続先データやダミーを内部に持たない。
 * @param props 接続先一覧と選択ハンドラ
 * @returns 接続先ごとの選択ボタン一覧
 */
export function ConnectionSelect({ targets, onSelect, onEdit }: ConnectionSelectProps) {
  return (
    <ul className="connection-list">
      {targets.map((target) => (
        <li key={target.id} className="connection-item">
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
      ))}
    </ul>
  )
}
