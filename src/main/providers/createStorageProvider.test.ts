import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConnectionTarget } from '../../shared/connections'

const { getStoredSecrets } = vi.hoisted(() => ({ getStoredSecrets: vi.fn() }))

// connectionSecrets は getStoredSecrets だけモックし、validator 関数は実装を使う。
vi.mock('../connectionSecrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../connectionSecrets')>()
  return { ...actual, getStoredSecrets }
})

// provider 構築時に受け取る解決済み接続（secret 含む）を捕捉する。
const { sftpArg, s3Arg } = vi.hoisted(() => ({ sftpArg: vi.fn(), s3Arg: vi.fn() }))
vi.mock('./SftpProvider', () => ({
  SftpProvider: class {
    constructor(connection: unknown) {
      sftpArg(connection)
    }
  },
}))
vi.mock('./S3Provider', () => ({
  S3Provider: class {
    constructor(connection: unknown) {
      s3Arg(connection)
    }
  },
}))

import { createStorageProvider, resolveConnection } from './createStorageProvider'

const sftpTarget: ConnectionTarget = {
  id: 'sftp-1',
  name: 'SFTP',
  kind: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'alice',
  rootPath: '/exports',
}

const s3Target: ConnectionTarget = { id: 's3-1', name: 'S3', kind: 's3', region: 'ap-northeast-1' }

describe('createStorageProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('SFTP provider に復号済み password を注入して構築する', () => {
    getStoredSecrets.mockReturnValue({ password: 'decrypted-pass' })

    createStorageProvider(sftpTarget)

    expect(sftpArg).toHaveBeenCalledWith({ ...sftpTarget, password: 'decrypted-pass' })
  })

  it('SFTP は secret 未保存なら空 password で構築する（鍵認証等）', () => {
    getStoredSecrets.mockReturnValue(null)

    expect(resolveConnection(sftpTarget)).toEqual({ ...sftpTarget, password: '' })
  })

  it('S3 provider に復号済みアクセスキー類を注入して構築する', () => {
    getStoredSecrets.mockReturnValue({ accessKeyId: 'AKIA', secretAccessKey: 'sec', sessionToken: 'tok' })

    createStorageProvider(s3Target)

    expect(s3Arg).toHaveBeenCalledWith({
      ...s3Target,
      accessKeyId: 'AKIA',
      secretAccessKey: 'sec',
      sessionToken: 'tok',
    })
  })

  it('S3 は secret 未保存なら明確に失敗する（再入力を促す）', () => {
    getStoredSecrets.mockReturnValue(null)

    expect(() => createStorageProvider(s3Target)).toThrow(/Missing stored credentials/)
    expect(s3Arg).not.toHaveBeenCalled()
  })

  it('SFTP target に S3 secret が保存されていたら明確に失敗する（kind 不一致）', () => {
    // S3 secret shape（accessKeyId 等）が SFTP id に紐付いている壊れた状態。
    getStoredSecrets.mockReturnValue({ accessKeyId: 'AKIA', secretAccessKey: 'sec', sessionToken: '' })

    expect(() => resolveConnection(sftpTarget)).toThrow(/unexpected format/)
    expect(sftpArg).not.toHaveBeenCalled()
  })

  it('S3 target に SFTP secret が保存されていたら明確に失敗する（kind 不一致）', () => {
    // SFTP secret shape（password）が S3 id に紐付いている壊れた状態。
    getStoredSecrets.mockReturnValue({ password: 'wrong-kind' })

    expect(() => resolveConnection(s3Target)).toThrow(/unexpected format/)
    expect(s3Arg).not.toHaveBeenCalled()
  })

  it('非 string secret（壊れた値）が SFTP id に保存されていたら明確に失敗する', () => {
    getStoredSecrets.mockReturnValue({ password: 42 })

    expect(() => resolveConnection(sftpTarget)).toThrow(/unexpected format/)
  })

  it('accessKeyId が空の部分的 S3 secret は明確に失敗する', () => {
    getStoredSecrets.mockReturnValue({ accessKeyId: '', secretAccessKey: 'sec', sessionToken: '' })

    expect(() => resolveConnection(s3Target)).toThrow(/unexpected format/)
  })
})
