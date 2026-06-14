import { useState } from 'react'

import { createDefaultSettings, type AppSettings } from '../../../../shared/settings'
import { useTranslation } from '../i18n/I18nContext'
import { ConnectionForm } from './ConnectionForm'
import { reorderConnections, type DropPosition } from './connectionReorder'
import { ConnectionSelect } from './ConnectionSelect'
import type { ConnectionTarget } from './connectionTypes'

interface ConnectionManagerProps {
  targets: ConnectionTarget[]
  /** 削除確認の有無に使う設定。未指定時は既定（確認あり）。 */
  settings?: AppSettings
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
  settings = createDefaultSettings('en'),
  onSelect,
  onSave,
  onDelete,
  variant = 'welcome',
  onReorder,
  reorderBusy = false,
}: ConnectionManagerProps) {
  const { t } = useTranslation()
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
                // confirmBeforeDelete=false なら確認を省略する。
                if (
                  settings.confirmBeforeDelete &&
                  !window.confirm(t('connection.deleteConfirm', { name: formTarget.name }))
                ) {
                  return
                }
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
      <p className="eyebrow">
        {variant === 'welcome' ? t('connection.welcomeEyebrow') : t('connection.newTabEyebrow')}
      </p>
      <h1>{t('connection.choose')}</h1>
      <p className="muted">{t('connection.chooseHint')}</p>
      <ConnectionSelect
        targets={targets}
        onSelect={onSelect}
        onEdit={setFormTarget}
        onReorderDrop={canReorder ? handleReorderDrop : undefined}
        reorderBusy={reorderBusy}
      />
      {targets.length === 0 && <p className="empty-state">{t('connection.empty')}</p>}
      <button className="secondary-button" type="button" onClick={() => setFormTarget(null)}>
        {t('connection.add')}
      </button>
      <p className="scope-note">{t('connection.storedLocally')}</p>
    </>
  )
}
