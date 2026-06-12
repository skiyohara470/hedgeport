import { useEffect, useState } from 'react'

import { ConnectionManager } from './features/connection/ConnectionManager'
import type { ConnectionTarget } from './features/connection/connectionTypes'
import { FilerWorkspace } from './features/filer/FilerWorkspace'
import { PreviewWindow } from './features/preview/PreviewWindow'

/**
 * renderer 側の最上位コンポーネント。
 * 接続一覧のロード、接続選択状態、プレビュー画面への分岐をまとめて管理する。
 */
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
