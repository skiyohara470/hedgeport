import { useState, type FormEvent } from 'react'

import { useTranslation } from '../i18n/I18nContext'
import { resolveMessage, type Message, type TranslationKey } from '../i18n/translations'
import type { ConnectionDraft, ConnectionTarget } from './connectionTypes'

interface ConnectionFormProps {
  target?: ConnectionTarget
  onSave: (draft: ConnectionDraft) => Promise<void> | void
  onCancel: () => void
  onDelete?: () => Promise<void> | void
}

type ConnectionKind = ConnectionTarget['kind']

/**
 * 永続化前の新規接続に一意な仮 ID を振る。
 */
function createId(): string {
  return `connection-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * SFTP / S3 の接続設定を作成・編集するフォーム。
 * kind ごとに必要な入力をまとめ、保存前検証と疎通確認もここで行う。
 * 可視文言は翻訳キーで保持し、言語切替時も即時更新される。
 */
export function ConnectionForm({ target, onSave, onCancel, onDelete }: ConnectionFormProps) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<ConnectionKind>(target?.kind ?? 'sftp')
  const [name, setName] = useState(target?.name ?? '')
  const [host, setHost] = useState(target?.kind === 'sftp' ? target.host : '')
  const [port, setPort] = useState(target?.kind === 'sftp' ? String(target.port) : '22')
  const [username, setUsername] = useState(target?.kind === 'sftp' ? target.username : '')
  // secret（password / アクセスキー類）は renderer へ渡されないため、編集時も空欄で開始する。
  // 編集時に空欄のまま保存すると、main 側で既存の暗号化済み secret が維持される。
  const [password, setPassword] = useState('')
  const [rootPath, setRootPath] = useState(target?.kind === 'sftp' ? target.rootPath : '/')
  const [region, setRegion] = useState(target?.kind === 's3' ? target.region : 'ap-northeast-1')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [sessionToken, setSessionToken] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; message: Message } | null>(null)
  const [formError, setFormError] = useState<Message | null>(null)
  const [isTesting, setIsTesting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  // 編集中（既存接続）か。編集時は secret 空欄を許容する（既存の暗号化 secret を維持）。
  const isEditing = Boolean(target)

  /**
   * 現在の入力値を ConnectionDraft 契約へ詰め直す。
   * UI 上の文字列入力を main 側へ渡す前の整形ポイント。secret は空欄なら維持扱いになる。
   */
  const buildTarget = (): ConnectionDraft => {
    const id = target?.id ?? createId()
    const trimmedName = name.trim()

    if (kind === 'sftp') {
      return {
        id,
        kind,
        name: trimmedName,
        lastLocalPath: target?.lastLocalPath,
        host: host.trim(),
        port: Number(port),
        username: username.trim(),
        password,
        rootPath: rootPath.trim() || '/',
      }
    }

    return {
      id,
      kind,
      name: trimmedName,
      lastLocalPath: target?.lastLocalPath,
      region: region.trim(),
      accessKeyId: accessKeyId.trim(),
      secretAccessKey,
      sessionToken: sessionToken.trim(),
    }
  }

  /**
   * 接続種別ごとの必須項目を確認し、最初のエラー翻訳キーだけ返す。
   * secret は新規作成時のみ必須。編集時は空欄なら既存 secret を維持するため必須にしない。
   */
  const validate = (connection: ConnectionDraft): TranslationKey | null => {
    if (!connection.name) return 'cf.errDisplayName'
    if (connection.kind === 'sftp') {
      if (!connection.host || !connection.username || !connection.rootPath) return 'cf.errSftpFields'
      if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535) {
        return 'cf.errPort'
      }
      return null
    }
    if (!connection.region) return 'cf.errS3Fields'
    if (!isEditing && (!connection.accessKeyId || !connection.secretAccessKey)) {
      return 'cf.errS3Fields'
    }
    return null
  }

  /**
   * 保存時は先にローカル検証を行い、通過した設定だけ親へ渡す。
   */
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const connection = buildTarget()
    const validationError = validate(connection)
    if (validationError) {
      setFormError({ key: validationError })
      return
    }

    try {
      setIsSaving(true)
      setFormError(null)
      await onSave(connection)
    } catch (error) {
      // main/server 由来は raw、それ以外は renderer fallback キー。
      setFormError(error instanceof Error ? { raw: error.message } : { key: 'cf.errSave' })
    } finally {
      setIsSaving(false)
    }
  }

  /**
   * 現在の入力値で main process へ疎通確認を依頼する。
   * 保存前でも実行できるよう、buildTarget の結果をそのまま使う。
   */
  const testConnection = async (): Promise<void> => {
    const connection = buildTarget()
    const validationError = validate(connection)
    if (validationError) {
      setTestResult({ ok: false, message: { key: validationError } })
      return
    }

    try {
      setIsTesting(true)
      setTestResult(null)
      // 接続テスト結果メッセージは main 由来のため raw 表示。
      const result = await window.hedgeport.testConnection(connection)
      setTestResult({ ok: result.ok, message: { raw: result.message } })
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof Error ? { raw: error.message } : { key: 'cf.errTest' } })
    } finally {
      setIsTesting(false)
    }
  }

  /**
   * 既存接続の削除要求を親へ伝える。
   */
  const deleteConnection = async (): Promise<void> => {
    if (!onDelete) return
    try {
      setIsSaving(true)
      setFormError(null)
      await onDelete()
    } catch (error) {
      setFormError(error instanceof Error ? { raw: error.message } : { key: 'cf.errDelete' })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <form className="connection-form" noValidate onSubmit={submit}>
      <div className="form-heading">
        <div>
          <p className="eyebrow">{target ? t('cf.editConnection') : t('cf.newConnection')}</p>
          <h1>{target ? target.name : t('cf.addConnection')}</h1>
        </div>
        <button className="text-button" type="button" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>

      {target ? (
        <div className="connection-type-display">
          <span>{t('cf.connectionType')}</span>
          <strong>{target.kind.toUpperCase()}</strong>
        </div>
      ) : (
        <fieldset className="kind-selector">
          <legend>{t('cf.connectionType')}</legend>
          <label>
            <input type="radio" name="kind" value="sftp" checked={kind === 'sftp'} onChange={() => setKind('sftp')} />
            SFTP
          </label>
          <label>
            <input type="radio" name="kind" value="s3" checked={kind === 's3'} onChange={() => setKind('s3')} />
            S3
          </label>
        </fieldset>
      )}

      <label className="form-field">
        <span>{t('cf.displayName')}</span>
        <input value={name} required autoFocus onChange={(event) => setName(event.target.value)} />
      </label>

      {kind === 'sftp' ? (
        <div className="form-grid">
          <label className="form-field form-field-wide">
            <span>{t('cf.host')}</span>
            <input
              value={host}
              required
              placeholder="sftp.example.com"
              onChange={(event) => setHost(event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>{t('cf.port')}</span>
            <input
              type="number"
              value={port}
              required
              min="1"
              max="65535"
              onChange={(event) => setPort(event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>{t('cf.username')}</span>
            <input value={username} required onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label className="form-field">
            <span>{t('cf.startPath')}</span>
            <input value={rootPath} required onChange={(event) => setRootPath(event.target.value)} />
          </label>
          <label className="form-field">
            <span>{t('cf.password')}</span>
            <input
              type="password"
              value={password}
              autoComplete="off"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        </div>
      ) : (
        <div className="form-grid">
          <label className="form-field form-field-wide">
            <span>{t('cf.region')}</span>
            <input value={region} required onChange={(event) => setRegion(event.target.value)} />
          </label>
          <label className="form-field">
            <span>{t('cf.accessKeyId')}</span>
            <input
              value={accessKeyId}
              required
              autoComplete="off"
              onChange={(event) => setAccessKeyId(event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>{t('cf.secretAccessKey')}</span>
            <input
              type="password"
              value={secretAccessKey}
              required
              autoComplete="off"
              onChange={(event) => setSecretAccessKey(event.target.value)}
            />
          </label>
          <label className="form-field form-field-wide">
            <span>{t('cf.sessionToken')}</span>
            <input
              type="password"
              value={sessionToken}
              autoComplete="off"
              placeholder={t('cf.sessionTokenPlaceholder')}
              onChange={(event) => setSessionToken(event.target.value)}
            />
          </label>
        </div>
      )}

      <p className="form-note">{t('cf.credentialsNote')}</p>
      {testResult && (
        <p className={testResult.ok ? 'connection-result success' : 'connection-result error'} role="status">
          {resolveMessage(t, testResult.message)}
        </p>
      )}
      {formError && (
        <p className="connection-result error" role="alert">
          {resolveMessage(t, formError)}
        </p>
      )}
      <div className="form-actions">
        {target && onDelete && (
          <button
            className="danger-button"
            type="button"
            disabled={isSaving || isTesting}
            onClick={() => void deleteConnection()}
          >
            {t('cf.deleteConnection')}
          </button>
        )}
        <div className="form-primary-actions">
          <button
            className="secondary-action-button"
            type="button"
            disabled={isSaving || isTesting}
            onClick={() => void testConnection()}
          >
            {isTesting ? t('cf.testing') : t('cf.testConnection')}
          </button>
          <button className="primary-button" type="submit" disabled={isSaving || isTesting}>
            {isSaving ? t('cf.saving') : target ? t('cf.saveChanges') : t('cf.addConnection')}
          </button>
        </div>
      </div>
    </form>
  )
}
