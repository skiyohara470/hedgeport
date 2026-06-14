import { useState, type FormEvent } from 'react'

import type { ConnectionTarget } from './connectionTypes'

interface ConnectionFormProps {
  target?: ConnectionTarget
  onSave: (target: ConnectionTarget) => Promise<void> | void
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
 */
export function ConnectionForm({ target, onSave, onCancel, onDelete }: ConnectionFormProps) {
  const [kind, setKind] = useState<ConnectionKind>(target?.kind ?? 'sftp')
  const [name, setName] = useState(target?.name ?? '')
  const [host, setHost] = useState(target?.kind === 'sftp' ? target.host : '')
  const [port, setPort] = useState(target?.kind === 'sftp' ? String(target.port) : '22')
  const [username, setUsername] = useState(target?.kind === 'sftp' ? target.username : '')
  const [password, setPassword] = useState(target?.kind === 'sftp' ? target.password : '')
  const [rootPath, setRootPath] = useState(target?.kind === 'sftp' ? target.rootPath : '/')
  const [region, setRegion] = useState(target?.kind === 's3' ? target.region : 'ap-northeast-1')
  const [accessKeyId, setAccessKeyId] = useState(target?.kind === 's3' ? target.accessKeyId : '')
  const [secretAccessKey, setSecretAccessKey] = useState(target?.kind === 's3' ? target.secretAccessKey : '')
  const [sessionToken, setSessionToken] = useState(target?.kind === 's3' ? target.sessionToken : '')
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [isTesting, setIsTesting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  /**
   * 現在の入力値を ConnectionTarget 契約へ詰め直す。
   * UI 上の文字列入力を main 側へ渡す前の整形ポイント。
   */
  const buildTarget = (): ConnectionTarget => {
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
   * 接続種別ごとの必須項目を確認し、最初のエラー文言だけ返す。
   */
  const validate = (connection: ConnectionTarget): string | null => {
    if (!connection.name) return 'Display name is required.'
    if (connection.kind === 'sftp') {
      if (!connection.host || !connection.username || !connection.rootPath) return 'Complete all required SFTP fields.'
      if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535) {
        return 'Port must be between 1 and 65535.'
      }
      return null
    }
    if (!connection.region || !connection.accessKeyId || !connection.secretAccessKey) {
      return 'Complete all required S3 fields.'
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
      setFormError(validationError)
      return
    }

    try {
      setIsSaving(true)
      setFormError(null)
      await onSave(connection)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not save this connection.')
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
      setTestResult({ ok: false, message: validationError })
      return
    }

    try {
      setIsTesting(true)
      setTestResult(null)
      setTestResult(await window.hedgeport.testConnection(connection))
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : 'Connection test failed.',
      })
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
      setFormError(error instanceof Error ? error.message : 'Could not delete this connection.')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <form className="connection-form" onSubmit={submit}>
      <div className="form-heading">
        <div>
          <p className="eyebrow">{target ? 'Edit connection' : 'New connection'}</p>
          <h1>{target ? target.name : 'Add connection'}</h1>
        </div>
        <button className="text-button" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {target ? (
        <div className="connection-type-display">
          <span>Connection type</span>
          <strong>{target.kind.toUpperCase()}</strong>
        </div>
      ) : (
        <fieldset className="kind-selector">
          <legend>Connection type</legend>
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
        <span>Display name</span>
        <input value={name} required autoFocus onChange={(event) => setName(event.target.value)} />
      </label>

      {kind === 'sftp' ? (
        <div className="form-grid">
          <label className="form-field form-field-wide">
            <span>Host</span>
            <input
              value={host}
              required
              placeholder="sftp.example.com"
              onChange={(event) => setHost(event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>Port</span>
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
            <span>Username</span>
            <input value={username} required onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label className="form-field">
            <span>Start path</span>
            <input value={rootPath} required onChange={(event) => setRootPath(event.target.value)} />
          </label>
          <label className="form-field">
            <span>Password</span>
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
            <span>Region</span>
            <input value={region} required onChange={(event) => setRegion(event.target.value)} />
          </label>
          <label className="form-field">
            <span>Access Key ID</span>
            <input
              value={accessKeyId}
              required
              autoComplete="off"
              onChange={(event) => setAccessKeyId(event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>Secret Access Key</span>
            <input
              type="password"
              value={secretAccessKey}
              required
              autoComplete="off"
              onChange={(event) => setSecretAccessKey(event.target.value)}
            />
          </label>
          <label className="form-field form-field-wide">
            <span>Session Token</span>
            <input
              type="password"
              value={sessionToken}
              autoComplete="off"
              placeholder="Optional for temporary credentials"
              onChange={(event) => setSessionToken(event.target.value)}
            />
          </label>
        </div>
      )}

      <p className="form-note">Credentials are stored in a local JSON file with owner-only file permissions.</p>
      {testResult && (
        <p className={testResult.ok ? 'connection-result success' : 'connection-result error'} role="status">
          {testResult.message}
        </p>
      )}
      {formError && (
        <p className="connection-result error" role="alert">
          {formError}
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
            Delete connection
          </button>
        )}
        <div className="form-primary-actions">
          <button
            className="secondary-action-button"
            type="button"
            disabled={isSaving || isTesting}
            onClick={() => void testConnection()}
          >
            {isTesting ? 'Testing...' : 'Test connection'}
          </button>
          <button className="primary-button" type="submit" disabled={isSaving || isTesting}>
            {isSaving ? 'Saving...' : target ? 'Save changes' : 'Add connection'}
          </button>
        </div>
      </div>
    </form>
  )
}
