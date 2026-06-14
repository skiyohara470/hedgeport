// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectionForm } from './ConnectionForm'
import type { ConnectionTarget } from './connectionTypes'

afterEach(cleanup)

describe('ConnectionForm', () => {
  it('SFTP接続を追加できる', () => {
    const onSave = vi.fn()
    render(<ConnectionForm onSave={onSave} onCancel={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Production SFTP' } })
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'sftp.example.com' } })
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '2222' } })
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'deploy' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'sftp-password' } })
    fireEvent.change(screen.getByLabelText('Start path'), { target: { value: '/exports' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'sftp',
        name: 'Production SFTP',
        host: 'sftp.example.com',
        port: 2222,
        username: 'deploy',
        password: 'sftp-password',
        rootPath: '/exports',
      })
    )
  })

  it('S3を選択して接続を追加できる', () => {
    const onSave = vi.fn()
    render(<ConnectionForm onSave={onSave} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('S3'))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Archive account' } })
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'us-west-2' } })
    fireEvent.change(screen.getByLabelText('Access Key ID'), { target: { value: 'AKIAEXAMPLE' } })
    fireEvent.change(screen.getByLabelText('Secret Access Key'), { target: { value: 'secret' } })
    fireEvent.change(screen.getByLabelText('Session Token'), { target: { value: 'token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))

    // bucket / prefix は持たない（アカウント単位）。
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 's3',
        name: 'Archive account',
        region: 'us-west-2',
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      })
    )
    const saved = onSave.mock.calls[0][0]
    expect(saved).not.toHaveProperty('bucket')
    expect(saved).not.toHaveProperty('prefix')
    // Bucket / Prefix / Fetch buckets の UI は無い。
    expect(screen.queryByLabelText('Bucket')).toBeNull()
    expect(screen.queryByLabelText('Prefix')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Fetch buckets' })).toBeNull()
  })

  it('既存接続を編集するとIDと種別を維持する', () => {
    const target: ConnectionTarget = {
      id: 'sftp-1',
      name: 'Old name',
      kind: 'sftp',
      host: 'old.example.com',
      port: 22,
      username: 'old-user',
      password: 'old-password',
      rootPath: '/',
      lastLocalPath: '/workspace',
    }
    const onSave = vi.fn()
    render(<ConnectionForm target={target} onSave={onSave} onCancel={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'New name' } })
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'new.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(onSave).toHaveBeenCalledWith({
      ...target,
      name: 'New name',
      host: 'new.example.com',
    })
    expect(screen.queryByLabelText('SFTP')).toBeNull()
    expect(screen.queryByLabelText('S3')).toBeNull()
    expect(screen.getByText('SFTP')).toBeTruthy()
  })

  it('Cancelで保存せず閉じる', () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    render(<ConnectionForm onSave={onSave} onCancel={onCancel} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('編集時に削除操作を呼べる', () => {
    const target: ConnectionTarget = {
      id: 's3-1',
      name: 'Archive',
      kind: 's3',
      region: 'ap-northeast-1',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      sessionToken: '',
    }
    const onDelete = vi.fn()
    render(<ConnectionForm target={target} onSave={vi.fn()} onCancel={vi.fn()} onDelete={onDelete} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete connection' }))

    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('入力中のS3設定で接続テストして結果を表示する', async () => {
    const testConnection = vi
      .fn()
      .mockResolvedValue({ ok: true, message: 'Connected to S3 (ap-northeast-1): 3 accessible bucket(s).' })
    Object.defineProperty(window, 'hedgeport', {
      configurable: true,
      value: { testConnection },
    })
    render(<ConnectionForm onSave={vi.fn()} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('S3'))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Archive' } })
    fireEvent.change(screen.getByLabelText('Access Key ID'), { target: { value: 'access-key' } })
    fireEvent.change(screen.getByLabelText('Secret Access Key'), { target: { value: 'secret-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))

    expect((await screen.findByRole('status')).textContent).toBe(
      'Connected to S3 (ap-northeast-1): 3 accessible bucket(s).'
    )
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 's3',
        accessKeyId: 'access-key',
        secretAccessKey: 'secret-key',
      })
    )
  })
})
