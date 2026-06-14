import { useEffect, useState } from 'react'

import { createDefaultSettings, type AppSettings } from '../../shared/settings'
import { ConnectionManager } from './features/connection/ConnectionManager'
import type { ConnectionTarget } from './features/connection/connectionTypes'
import { FilerWorkspace } from './features/filer/FilerWorkspace'
import { Icon } from './features/icons/Icon'
import { I18nProvider } from './features/i18n/I18nContext'
import { createTranslator } from './features/i18n/translations'
import { PreviewWindow } from './features/preview/PreviewWindow'
import { SettingsDialog } from './features/settings/SettingsDialog'
import { SettingsProvider } from './features/settings/SettingsContext'

/**
 * renderer 側の最上位コンポーネント。
 * 接続一覧と設定のロード、接続選択状態、設定モーダル、プレビュー画面への分岐をまとめて管理する。
 */
export function App() {
  const [targets, setTargets] = useState<ConnectionTarget[]>([])
  const [selectedTarget, setSelectedTarget] = useState<ConnectionTarget | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [storageError, setStorageError] = useState<string | null>(null)
  // 並び替え保存中は新しいドラッグを抑止する（save 競合防止）。
  const [reorderBusy, setReorderBusy] = useState(false)
  // 設定モーダル。draft は即時プレビュー用、Cancel で破棄する。
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)

  useEffect(() => {
    // 接続と設定を同時にロードする。設定ロード失敗時は既定で起動して通知する。
    void Promise.allSettled([window.hedgeport.loadConnections(), window.hedgeport.loadSettings()])
      .then(([connectionsResult, settingsResult]) => {
        if (connectionsResult.status === 'fulfilled') {
          setTargets(connectionsResult.value)
        } else {
          const reason = connectionsResult.reason
          setStorageError(reason instanceof Error ? reason.message : 'Could not load connections.')
        }
        if (settingsResult.status === 'fulfilled') {
          setSettings(settingsResult.value)
        } else {
          setSettings(createDefaultSettings(navigator.language))
          setSettingsError('settings.couldNotLoad')
        }
      })
      .finally(() => setIsLoading(false))
  }, [])

  // プレビューと providers 用の実効設定（ロード前 / draft プレビュー込み）。
  const effectiveSettings = settingsDraft ?? settings ?? createDefaultSettings(navigator.language)
  const t = createTranslator(effectiveSettings.language)

  /**
   * 新規追加と既存更新を同じ保存経路で扱う。
   * 保存後は一覧と選択中ターゲットの両方を同期する。
   */
  const saveTarget = async (target: ConnectionTarget): Promise<void> => {
    const exists = targets.some((item) => item.id === target.id)
    const next = exists ? targets.map((item) => (item.id === target.id ? target : item)) : [...targets, target]
    await window.hedgeport.saveConnections(next)
    setTargets(next)
    setStorageError(null)
    setSelectedTarget((current) => (current?.id === target.id ? target : current))
  }

  /**
   * 接続を削除し、現在その接続を表示中なら選択解除する。
   */
  const deleteTarget = async (target: ConnectionTarget): Promise<void> => {
    const next = targets.filter((item) => item.id !== target.id)
    await window.hedgeport.saveConnections(next)
    setTargets(next)
    setStorageError(null)
    setSelectedTarget((current) => (current?.id === target.id ? null : current))
  }

  /**
   * 接続のドラッグ並び替え結果を保存して反映する。
   * 保存中は新しいドラッグを抑止し、保存成功時のみ state を更新する。失敗時は順序維持でエラー通知。
   */
  const reorderTargets = async (next: ConnectionTarget[]): Promise<void> => {
    try {
      setReorderBusy(true)
      await window.hedgeport.saveConnections(next)
      setTargets(next)
      setStorageError(null)
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : t('connection.couldNotReorder'))
    } finally {
      setReorderBusy(false)
    }
  }

  /** 設定モーダルを開く（現在値を draft に複製してプレビュー開始）。 */
  const openSettings = (): void => {
    setSettingsError(null)
    setSettingsDraft(settings ?? effectiveSettings)
    setSettingsOpen(true)
  }

  /** Cancel: draft を破棄して閉じる（プレビューは元へ戻る）。 */
  const cancelSettings = (): void => {
    setSettingsOpen(false)
    setSettingsDraft(null)
    setSettingsError(null)
  }

  /** Save: 正規化済みの結果を永続化し、成功時のみ確定する。 */
  const saveSettings = async (): Promise<void> => {
    if (!settingsDraft) return
    try {
      setSettingsSaving(true)
      setSettingsError(null)
      const saved = await window.hedgeport.saveSettings(settingsDraft)
      setSettings(saved)
      setSettingsOpen(false)
      setSettingsDraft(null)
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : t('settings.couldNotSave'))
    } finally {
      setSettingsSaving(false)
    }
  }

  if (window.location.hash === '#preview') {
    return <PreviewWindow />
  }

  let content
  if (isLoading || !settings) {
    content = (
      <main className="connection-screen">
        <p className="loading-state">{t('workspace.loadingConnections')}</p>
      </main>
    )
  } else if (selectedTarget) {
    content = (
      <FilerWorkspace
        target={selectedTarget}
        targets={targets}
        settings={settings}
        onOpenSettings={openSettings}
        onSaveTarget={saveTarget}
        onDeleteTarget={deleteTarget}
        onDisconnect={() => setSelectedTarget(null)}
      />
    )
  } else {
    content = (
      <main className="connection-screen">
        <section className="connection-card">
          <div className="connection-card-toolbar">
            <button
              className="icon-button"
              type="button"
              aria-label={t('settings.open')}
              title={t('settings.open')}
              onClick={openSettings}
            >
              <Icon name="settings" />
            </button>
          </div>
          {storageError && <p className="storage-error">{storageError}</p>}
          {settingsError && !settingsOpen && <p className="storage-error">{t('settings.couldNotLoad')}</p>}
          <ConnectionManager
            targets={targets}
            settings={settings}
            onSelect={setSelectedTarget}
            onSave={saveTarget}
            onDelete={deleteTarget}
            onReorder={reorderTargets}
            reorderBusy={reorderBusy}
          />
        </section>
      </main>
    )
  }

  return (
    <SettingsProvider settings={effectiveSettings}>
      <I18nProvider language={effectiveSettings.language}>
        {content}
        {settingsOpen && settingsDraft && (
          <SettingsDialog
            value={settingsDraft}
            onChange={setSettingsDraft}
            onSave={saveSettings}
            onCancel={cancelSettings}
            saving={settingsSaving}
            error={settingsError && settingsError !== 'settings.couldNotLoad' ? settingsError : null}
          />
        )}
      </I18nProvider>
    </SettingsProvider>
  )
}
