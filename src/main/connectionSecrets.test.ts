import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getPath, isEncryptionAvailable } = vi.hoisted(() => ({
  getPath: vi.fn<(name: string) => string>(),
  isEncryptionAvailable: vi.fn<() => boolean>(() => true),
}))

vi.mock('electron', () => ({
  app: { getPath },
  safeStorage: {
    isEncryptionAvailable,
    encryptString: (text: string) => Buffer.from(`enc:${text}`, 'utf8'),
    decryptString: (data: Buffer) => data.toString('utf8').replace(/^enc:/, ''),
  },
}))

import {
  encryptSecrets,
  extractSecrets,
  getStoredSecrets,
  isValidConnectionSecrets,
  isValidS3Secrets,
  isValidSftpSecrets,
  parseSecretEnvelope,
  readEncryptedMap,
  requireEncryptionAvailable,
  serializeSecretEnvelope,
  writeEncryptedMap,
} from './connectionSecrets'

describe('extractSecrets', () => {
  it('SFTP: password を secret に分離し、メタデータから除く', () => {
    const { metadata, secrets } = extractSecrets({
      id: 'sftp-1',
      name: 'SFTP',
      kind: 'sftp',
      host: 'h',
      port: 22,
      username: 'u',
      password: 'pw',
      rootPath: '/',
    })
    expect(secrets).toEqual({ password: 'pw' })
    expect(metadata).toEqual({ id: 'sftp-1', name: 'SFTP', kind: 'sftp', host: 'h', port: 22, username: 'u', rootPath: '/' })
    expect(metadata).not.toHaveProperty('password')
  })

  it('SFTP: password が空なら secret なし（既存維持）', () => {
    expect(
      extractSecrets({ id: 'sftp-1', name: 'SFTP', kind: 'sftp', host: 'h', port: 22, username: 'u', rootPath: '/' }).secrets
    ).toBeNull()
  })

  it('S3: アクセスキー類を secret に分離し、legacy フィールドを除く', () => {
    const { metadata, secrets } = extractSecrets({
      id: 's3-1',
      name: 'S3',
      kind: 's3',
      region: 'ap-northeast-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'sec',
      sessionToken: '',
      // legacy フィールドが残っていても無視する。
      ...({ bucket: 'b', prefix: 'p/' } as object),
    } as Parameters<typeof extractSecrets>[0])
    expect(secrets).toEqual({ accessKeyId: 'AKIA', secretAccessKey: 'sec', sessionToken: '' })
    expect(metadata).toEqual({ id: 's3-1', name: 'S3', kind: 's3', region: 'ap-northeast-1' })
    expect(metadata).not.toHaveProperty('bucket')
  })

  it('S3: secretAccessKey が空なら secret なし（既存維持）', () => {
    expect(extractSecrets({ id: 's3-1', name: 'S3', kind: 's3', region: 'ap-northeast-1' }).secrets).toBeNull()
  })

  it('S3: 非文字列 secretAccessKey は secret なし扱い（IPC 由来の不正型を暗号化しない）', () => {
    const { secrets } = extractSecrets({
      id: 's3-1',
      name: 'S3',
      kind: 's3',
      region: 'ap-northeast-1',
      secretAccessKey: 42 as unknown as string,
    })
    expect(secrets).toBeNull()
  })

  it('S3: secretAccessKey はあるが accessKeyId が空なら throw する（partial secret 拒否）', () => {
    expect(() =>
      extractSecrets({
        id: 's3-1',
        name: 'S3',
        kind: 's3',
        region: 'ap-northeast-1',
        accessKeyId: '',
        secretAccessKey: 'sec',
        sessionToken: '',
      })
    ).toThrow(/incomplete/)
  })

  it('SFTP: 非文字列 password は secret なし扱い（IPC 由来の不正型を暗号化しない）', () => {
    const { secrets } = extractSecrets({
      id: 'sftp-1',
      name: 'SFTP',
      kind: 'sftp',
      host: 'h',
      port: 22,
      username: 'u',
      password: null as unknown as string,
      rootPath: '/',
    })
    expect(secrets).toBeNull()
  })
})

describe('isValidConnectionSecrets', () => {
  it('正当な SFTP secret を受け入れる（password は空可）', () => {
    expect(isValidSftpSecrets({ password: '' })).toBe(true)
    expect(isValidSftpSecrets({ password: 'pw' })).toBe(true)
  })

  it('正当な S3 secret を受け入れる', () => {
    expect(isValidS3Secrets({ accessKeyId: 'AKIA', secretAccessKey: 'sec', sessionToken: '' })).toBe(true)
    expect(isValidS3Secrets({ accessKeyId: 'AKIA', secretAccessKey: 'sec', sessionToken: 'tok' })).toBe(true)
  })

  it('不正な SFTP secret は拒否する（非文字列 password）', () => {
    expect(isValidSftpSecrets({ password: 42 })).toBe(false)
    expect(isValidSftpSecrets({ password: null })).toBe(false)
    expect(isValidSftpSecrets({})).toBe(false)
  })

  it('S3: accessKeyId が空なら拒否する', () => {
    expect(isValidS3Secrets({ accessKeyId: '', secretAccessKey: 'sec', sessionToken: '' })).toBe(false)
  })

  it('S3: secretAccessKey が空なら拒否する', () => {
    expect(isValidS3Secrets({ accessKeyId: 'AKIA', secretAccessKey: '', sessionToken: '' })).toBe(false)
  })

  it('SFTP secret は S3 validator で拒否される（kind 不一致）', () => {
    expect(isValidS3Secrets({ password: 'pw' })).toBe(false)
  })

  it('S3 secret は SFTP validator で拒否される（kind 不一致）', () => {
    expect(isValidSftpSecrets({ accessKeyId: 'AKIA', secretAccessKey: 'sec', sessionToken: '' })).toBe(false)
  })

  it('isValidConnectionSecrets は SFTP / S3 どちらも受け入れる', () => {
    expect(isValidConnectionSecrets({ password: 'pw' })).toBe(true)
    expect(isValidConnectionSecrets({ accessKeyId: 'AKIA', secretAccessKey: 'sec', sessionToken: '' })).toBe(true)
    expect(isValidConnectionSecrets({ bad: 'field' })).toBe(false)
    expect(isValidConnectionSecrets(null)).toBe(false)
  })
})

describe('secret envelope', () => {
  it('直列化と解析が往復する', () => {
    const map = { 'sftp-1': 'enc:abc', 's3-1': 'enc:def' }
    expect(parseSecretEnvelope(serializeSecretEnvelope(map))).toEqual(map)
  })

  it('不正なバージョン/形状は拒否する', () => {
    expect(() => parseSecretEnvelope(JSON.stringify({ version: 2, secrets: {} }))).toThrow(/invalid format/)
    expect(() => parseSecretEnvelope(JSON.stringify({ version: 1, secrets: { a: 1 } }))).toThrow(/invalid format/)
    expect(() => parseSecretEnvelope('null')).toThrow(/invalid format/)
  })
})

describe('暗号化ストア', () => {
  let tempDir: string

  beforeEach(async () => {
    isEncryptionAvailable.mockReturnValue(true)
    tempDir = await mkdtemp(join(tmpdir(), 'hedgeport-secrets-'))
    getPath.mockReturnValue(tempDir)
  })

  afterEach(async () => {
    vi.clearAllMocks()
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  })

  it('暗号化して保存し、復号して取り出せる', async () => {
    await writeEncryptedMap({ 'sftp-1': encryptSecrets({ password: 'pw' }) })

    // 保存ファイルには平文 secret が残らない。
    const raw = await readFile(join(tempDir, 'connectionSecrets.json'), 'utf8')
    // 平文 secret（key 名/値）は保存ファイルに現れない。
    expect(raw).not.toContain('password')
    // 値は base64(暗号化バイト列)。'ZW5j' は疑似暗号化マーカー 'enc' の base64 先頭。
    expect(raw).toContain('ZW5j')

    expect(getStoredSecrets('sftp-1')).toEqual({ password: 'pw' })
  })

  it('未保存 id は null を返す', async () => {
    await writeEncryptedMap({})
    expect(getStoredSecrets('missing')).toBeNull()
  })

  it('ファイルが無ければ空マップを返す', () => {
    expect(readEncryptedMap()).toEqual({})
  })

  it('safeStorage 不可なら暗号化を明確に拒否する', () => {
    isEncryptionAvailable.mockReturnValue(false)
    expect(() => requireEncryptionAvailable()).toThrow(/Secure credential storage is unavailable/)
    expect(() => encryptSecrets({ password: 'pw' })).toThrow(/Secure credential storage is unavailable/)
  })

  it('復号後 JSON の形状が不正なら明確に失敗する（壊れた値を provider へ渡さない）', async () => {
    // 直接不正な JSON を encryptString へ渡して保存する（encryptSecrets を迂回）。
    const badEncoded = Buffer.from(`enc:{"bad":"value"}`).toString('base64')
    await writeEncryptedMap({ 'sftp-1': badEncoded })
    expect(() => getStoredSecrets('sftp-1')).toThrow(/invalid or unrecognized format/)
  })
})
