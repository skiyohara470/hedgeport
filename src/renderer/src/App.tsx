import { useEffect, useState } from 'react'

import { createDefaultSettings, type AppSettings } from '../../shared/settings'
import { ConnectionManager } from './features/connection/ConnectionManager'
import type { ConnectionDraft, ConnectionTarget } from './features/connection/connectionTypes'
import { FilerWorkspace } from './features/filer/FilerWorkspace'
import { Icon } from './features/icons/Icon'
import { I18nProvider } from './features/i18n/I18nContext'
import { createTranslator, resolveMessage, type Message } from './features/i18n/translations'
import { applyFullScreen, applyPlatform } from './features/platform/platform'
import { PreviewWindow } from './features/preview/PreviewWindow'
import { SettingsDialog } from './features/settings/SettingsDialog'
import { SettingsProvider } from './features/settings/SettingsContext'

/**
 * renderer 側の最上位コンポーネント。
 * 接続一覧と設定のロード、接続選択状態、設定モーダル、プレビュー画面への分岐をまとめて管理する。
 * 通知メッセージは構造化（key|raw）で保持し、表示時に現在言語で解決する。
 */
export function App() {
  const [targets, setTargets] = useState<ConnectionTarget[]>([])
  const [selectedTarget, setSelectedTarget] = useState<ConnectionTarget | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [storageError, setStorageError] = useState<Message | null>(null)
  // 並び替え保存中は新しいドラッグを抑止する（save 競合防止）。
  const [reorderBusy, setReorderBusy] = useState(false)
  // 設定モーダル。draft は即時プレビュー用、Cancel で破棄する。
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsError, setSettingsError] = useState<Message | null>(null) // 保存失敗（dialog 表示）
  const [settingsLoadError, setSettingsLoadError] = useState<Message | null>(null) // ロード失敗（welcome 通知）

  useEffect(() => {
    // 接続と設定を同時にロードする。設定ロード失敗時は既定で起動して通知する。
    void Promise.allSettled([window.hedgeport.loadConnections(), window.hedgeport.loadSettings()])
      .then(([connectionsResult, settingsResult]) => {
        if (connectionsResult.status === 'fulfilled') {
          setTargets(connectionsResult.value)
        } else {
          const reason = connectionsResult.reason
          setStorageError(reason instanceof Error ? { raw: reason.message } : { key: 'connection.couldNotLoad' })
        }
        if (settingsResult.status === 'fulfilled') {
          setSettings(settingsResult.value)
        } else {
          // 既定で起動し、設定ロード完了後の選択言語へ追従できるよう key で通知を保持する。
          setSettings(createDefaultSettings(navigator.language))
          setSettingsLoadError({ key: 'settings.couldNotLoad' })
        }
      })
      .finally(() => setIsLoading(false))
  }, [])

  // OS 種別と全画面状態をルート要素へ反映する（macOS 統合タイトルバーの drag 領域 / 左余白の出し分け）。
  // App は main / preview（#preview）双方のトップなので、ここで一括して扱う。
  useEffect(() => {
    applyPlatform(document.documentElement, window.hedgeport?.platform)
    return window.hedgeport?.onFullScreenChange?.((fullScreen) => applyFullScreen(document.documentElement, fullScreen))
  }, [])

  // プレビューと providers 用の実効設定（ロード前 / draft プレビュー込み）。
  const effectiveSettings = settingsDraft ?? settings ?? createDefaultSettings(navigator.language)
  const t = createTranslator(effectiveSettings.language)

  /**
   * 新規追加と既存更新を同じ保存経路で扱う。
   * 下書きには secret が含まれ得るが、main 側で分離・暗号化されるため、戻り値の
   * 機密でないメタデータ配列で state を確定する（renderer の state に secret を残さない）。
   * 保存後は一覧と選択中ターゲットの両方を同期する。
   */
  const saveTarget = async (draft: ConnectionDraft): Promise<void> => {
    const exists = targets.some((item) => item.id === draft.id)
    const next: ConnectionDraft[] = exists
      ? targets.map((item) => (item.id === draft.id ? draft : item))
      : [...targets, draft]
    const saved = await window.hedgeport.saveConnections(next)
    setTargets(saved)
    setStorageError(null)
    setSelectedTarget((current) => (current ? (saved.find((item) => item.id === current.id) ?? current) : current))
  }

  /**
   * 接続を削除し、現在その接続を表示中なら選択解除する。
   */
  const deleteTarget = async (target: ConnectionTarget): Promise<void> => {
    const next = targets.filter((item) => item.id !== target.id)
    const saved = await window.hedgeport.saveConnections(next)
    setTargets(saved)
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
      const saved = await window.hedgeport.saveConnections(next)
      setTargets(saved)
      setStorageError(null)
    } catch (error) {
      setStorageError(error instanceof Error ? { raw: error.message } : { key: 'connection.couldNotReorder' })
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
      setSettingsLoadError(null)
      setSettingsOpen(false)
      setSettingsDraft(null)
    } catch (error) {
      setSettingsError(error instanceof Error ? { raw: error.message } : { key: 'settings.couldNotSave' })
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
          {storageError && <p className="storage-error">{resolveMessage(t, storageError)}</p>}
          {settingsLoadError && !settingsOpen && (
            <p className="storage-error">{resolveMessage(t, settingsLoadError)}</p>
          )}
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
            error={settingsError ? resolveMessage(t, settingsError) : null}
          />
        )}
      </I18nProvider>
    </SettingsProvider>
  )
}
