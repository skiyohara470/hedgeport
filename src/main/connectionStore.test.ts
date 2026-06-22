import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getPath, isEncryptionAvailable } = vi.hoisted(() => ({
  getPath: vi.fn<(name: string) => string>(),
  isEncryptionAvailable: vi.fn<() => boolean>(() => true),
}))

// node:fs/promises はトップレベルでモックし、テストごとに実装を切り替える。
// デフォルトは実際の実装を使い、一部のテストで失敗を注入する。
const { fsMock } = vi.hoisted(() => ({ fsMock: { failRename: false, renameCallCount: 0 } }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      fsMock.renameCallCount++
      if (fsMock.failRename && fsMock.renameCallCount === 2) {
        // 2 回目の rename（connections.json）だけ失敗させる。
        throw new Error('disk full (injected)')
      }
      return actual.rename(...args)
    },
  }
})

// safeStorage は可逆な疑似実装にする（`enc:` プレフィックスで暗号化/復号を模す）。
vi.mock('electron', () => ({
  app: { getPath },
  safeStorage: {
    isEncryptionAvailable,
    encryptString: (text: string) => Buffer.from(`enc:${text}`, 'utf8'),
    decryptString: (data: Buffer) => data.toString('utf8').replace(/^enc:/, ''),
  },
}))

import { getStoredSecrets } from './connectionSecrets'
import { isConnectionTarget, loadConnections, saveConnections } from './connectionStore'

const connectionsFile = 'connections.json'
const secretsFile = 'connectionSecrets.json'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('connectionStore', () => {
  let tempDir: string

  beforeEach(async () => {
    isEncryptionAvailable.mockReturnValue(true)
    fsMock.failRename = false
    fsMock.renameCallCount = 0
    tempDir = await mkdtemp(join(tmpdir(), 'hedgeport-connection-store-'))
    getPath.mockReturnValue(tempDir)
  })

  afterEach(async () => {
    fsMock.failRename = false
    fsMock.renameCallCount = 0
    vi.clearAllMocks()
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  })

  it('secret を含まないメタデータ形状を受け入れる', () => {
    expect(
      isConnectionTarget({
        id: 'sftp-1',
        name: 'SFTP',
        kind: 'sftp',
        host: 'example.com',
        port: 22,
        username: 'alice',
        rootPath: '/exports',
      })
    ).toBe(true)

    // アカウント単位の S3 は region だけがメタデータの必須項目。
    expect(isConnectionTarget({ id: 's3-1', name: 'S3', kind: 's3', region: 'ap-northeast-1' })).toBe(true)

    // 旧形式の平文 secret が混じっていても、メタデータとしては妥当（余分なフィールドは無視）。
    expect(
      isConnectionTarget({
        id: 'sftp-1',
        name: 'SFTP',
        kind: 'sftp',
        host: 'example.com',
        port: 22,
        username: 'alice',
        password: 'secret',
        rootPath: '/exports',
      })
    ).toBe(true)
  })

  it('メタデータの必須項目が欠けた接続設定は拒否する', () => {
    // SFTP は host を欠く。
    expect(
      isConnectionTarget({ id: 'sftp-1', name: 'SFTP', kind: 'sftp', port: 22, username: 'alice', rootPath: '/' })
    ).toBe(false)
    // S3 は region を欠く。
    expect(isConnectionTarget({ id: 's3-1', name: 'S3', kind: 's3' })).toBe(false)
  })

  it('保存時に secret を connections.json から分離し、暗号化ストアへ入れる', async () => {
    await saveConnections([
      {
        id: 'sftp-1',
        name: 'SFTP',
        kind: 'sftp',
        host: 'example.com',
        port: 22,
        username: 'alice',
        password: 'sftp-secret',
        rootPath: '/exports',
      },
      {
        id: 's3-1',
        name: 'S3',
        kind: 's3',
        region: 'ap-northeast-1',
        accessKeyId: 'AKIA...',
        secretAccessKey: 's3-secret',
        sessionToken: 'token',
      },
    ])

    // connections.json には平文 secret が一切残らない。
    const persisted = await readFile(join(tempDir, connectionsFile), 'utf8')
    expect(persisted).not.toContain('sftp-secret')
    expect(persisted).not.toContain('s3-secret')
    expect(persisted).not.toContain('password')
    expect(persisted).not.toContain('accessKeyId')
    expect(persisted).not.toContain('token')

    // 暗号化ストアには暗号化済み（平文でない）値だけが入る。
    const secretsRaw = await readFile(join(tempDir, secretsFile), 'utf8')
    expect(secretsRaw).not.toContain('sftp-secret')
    expect(secretsRaw).not.toContain('s3-secret')
    // 値は base64(暗号化バイト列)。'ZW5j' は疑似暗号化マーカー 'enc' の base64 先頭。
    expect(secretsRaw).toContain('ZW5j')

    // load はメタデータだけを返す（secret を含まない）。
    await expect(loadConnections()).resolves.toEqual([
      { id: 'sftp-1', name: 'SFTP', kind: 'sftp', host: 'example.com', port: 22, username: 'alice', rootPath: '/exports' },
      { id: 's3-1', name: 'S3', kind: 's3', region: 'ap-northeast-1' },
    ])

    // 復号すると元の secret に戻る（main 内でのみ復号する）。
    expect(getStoredSecrets('sftp-1')).toEqual({ password: 'sftp-secret' })
    expect(getStoredSecrets('s3-1')).toEqual({
      accessKeyId: 'AKIA...',
      secretAccessKey: 's3-secret',
      sessionToken: 'token',
    })
  })

  it('secret 欄が空の保存（編集の再入力なし）は既存の secret を維持する', async () => {
    await saveConnections([
      { id: 'sftp-1', name: 'SFTP', kind: 'sftp', host: 'example.com', port: 22, username: 'alice', password: 'keep-me', rootPath: '/' },
    ])

    // password を空にして（= 再入力せず）lastLocalPath だけ更新して再保存。
    await saveConnections([
      { id: 'sftp-1', name: 'SFTP', kind: 'sftp', host: 'example.com', port: 22, username: 'alice', password: '', rootPath: '/', lastLocalPath: '/work' },
    ])

    expect(getStoredSecrets('sftp-1')).toEqual({ password: 'keep-me' })
    const metadata = await loadConnections()
    expect(metadata[0].lastLocalPath).toBe('/work')
  })

  it('保存対象から外れた接続の secret は暗号化ストアから取り除く（prune）', async () => {
    await saveConnections([
      { id: 'a', name: 'A', kind: 'sftp', host: 'h', port: 22, username: 'u', password: 'pa', rootPath: '/' },
      { id: 'b', name: 'B', kind: 'sftp', host: 'h', port: 22, username: 'u', password: 'pb', rootPath: '/' },
    ])
    expect(getStoredSecrets('a')).toEqual({ password: 'pa' })

    // a を削除した配列で保存。
    await saveConnections([
      { id: 'b', name: 'B', kind: 'sftp', host: 'h', port: 22, username: 'u', password: '', rootPath: '/' },
    ])

    expect(getStoredSecrets('a')).toBeNull()
    expect(getStoredSecrets('b')).toEqual({ password: 'pb' })
  })

  it('未保存時は空配列を返す', async () => {
    await expect(loadConnections()).resolves.toEqual([])
  })

  it('不正な内容の接続ファイルは拒否する', async () => {
    await writeFile(join(tempDir, connectionsFile), JSON.stringify([{ id: 'broken' }]), 'utf8')
    await expect(loadConnections()).rejects.toThrow('Connections file has an invalid format.')
  })

  describe('平文からの移行', () => {
    it('旧形式（平文 secret + legacy bucket/prefix）を load 時に暗号化ストアへ移行する', async () => {
      await writeFile(
        join(tempDir, connectionsFile),
        JSON.stringify([
          { id: 'sftp-1', name: 'SFTP', kind: 'sftp', host: 'example.com', port: 22, username: 'alice', password: 'old-pass', rootPath: '/exports' },
          { id: 's3-legacy', name: 'Legacy S3', lastLocalPath: '/work', kind: 's3', region: 'ap-northeast-1', bucket: 'bucket-a', prefix: 'daily/', accessKeyId: 'AKIA...', secretAccessKey: 'old-secret', sessionToken: '' },
        ]),
        'utf8'
      )

      // load で移行し、メタデータだけを返す（legacy bucket/prefix も除去）。
      await expect(loadConnections()).resolves.toEqual([
        { id: 'sftp-1', name: 'SFTP', kind: 'sftp', host: 'example.com', port: 22, username: 'alice', rootPath: '/exports' },
        { id: 's3-legacy', name: 'Legacy S3', lastLocalPath: '/work', kind: 's3', region: 'ap-northeast-1' },
      ])

      // connections.json から平文 secret は除去される。
      const persisted = await readFile(join(tempDir, connectionsFile), 'utf8')
      expect(persisted).not.toContain('old-pass')
      expect(persisted).not.toContain('old-secret')
      expect(persisted).not.toContain('password')
      expect(persisted).not.toContain('accessKeyId')
      expect(persisted).not.toContain('bucket')
      expect(persisted).not.toContain('prefix')

      // 移行後も secret は復号可能。
      expect(getStoredSecrets('sftp-1')).toEqual({ password: 'old-pass' })
      expect(getStoredSecrets('s3-legacy')).toEqual({ accessKeyId: 'AKIA...', secretAccessKey: 'old-secret', sessionToken: '' })
    })
  })

  describe('safeStorage が利用不可のとき', () => {
    it('secret を含む保存は明確に失敗し、ファイルを書き換えない', async () => {
      isEncryptionAvailable.mockReturnValue(false)

      await expect(
        saveConnections([
          { id: 'sftp-1', name: 'SFTP', kind: 'sftp', host: 'h', port: 22, username: 'u', password: 'secret', rootPath: '/' },
        ])
      ).rejects.toThrow(/Secure credential storage is unavailable/)

      // 平文フォールバックはしない。connections.json も secret ストアも作らない。
      expect(await exists(join(tempDir, connectionsFile))).toBe(false)
      expect(await exists(join(tempDir, secretsFile))).toBe(false)
    })

    it('平文移行は明確に失敗し、connections.json を部分的に書き換えない', async () => {
      isEncryptionAvailable.mockReturnValue(false)
      const original = JSON.stringify([
        { id: 'sftp-1', name: 'SFTP', kind: 'sftp', host: 'h', port: 22, username: 'u', password: 'old-pass', rootPath: '/' },
      ])
      await writeFile(join(tempDir, connectionsFile), original, 'utf8')

      await expect(loadConnections()).rejects.toThrow(/Secure credential storage is unavailable/)

      // connections.json は元のまま（平文を含む）。secret ストアは作られない。
      expect(await readFile(join(tempDir, connectionsFile), 'utf8')).toBe(original)
      expect(await exists(join(tempDir, secretsFile))).toBe(false)
    })
  })

  describe('saveConnections の書き込み失敗耐性', () => {
    it('connections.json の書き込み失敗時に削除対象 secret を消去しない（prune は後回し）', async () => {
      // a と b を保存しておく。
      await saveConnections([
        { id: 'a', name: 'A', kind: 'sftp', host: 'h', port: 22, username: 'u', password: 'pa', rootPath: '/' },
        { id: 'b', name: 'B', kind: 'sftp', host: 'h', port: 22, username: 'u', password: 'pb', rootPath: '/' },
      ])

      // 次の saveConnections で connections.json の rename（2 回目）だけを失敗させる。
      // 1 回目は connectionSecrets.json（addMap 書き込み）、2 回目が connections.json。
      fsMock.failRename = true
      fsMock.renameCallCount = 0

      await expect(
        saveConnections([
          { id: 'b', name: 'B', kind: 'sftp', host: 'h', port: 22, username: 'u', password: '', rootPath: '/' },
          // a を除外（削除想定）。
        ])
      ).rejects.toThrow('disk full (injected)')

      fsMock.failRename = false

      // connections.json 書き込みが失敗したため、ロールバックにより a の secret は復元されているべき。
      // （prune は connections.json 書き込み成功後なので a の secret を先に消す操作は発生しない）
      expect(getStoredSecrets('a')).toEqual({ password: 'pa' })
      expect(getStoredSecrets('b')).toEqual({ password: 'pb' })
    })

    it('prune 成功後は削除済み id の secret は消える', async () => {
      // a と b を保存して a を削除。prune が正常に動くケース。
      await saveConnections([
        { id: 'a', name: 'A', kind: 'sftp', host: 'h', port: 22, username: 'u', password: 'pa', rootPath: '/' },
        { id: 'b', name: 'B', kind: 'sftp', host: 'h', port: 22, username: 'u', password: 'pb', rootPath: '/' },
      ])
      await saveConnections([
        { id: 'b', name: 'B', kind: 'sftp', host: 'h', port: 22, username: 'u', password: '', rootPath: '/' },
      ])
      // a は prune で削除される。b は残る。
      expect(getStoredSecrets('a')).toBeNull()
      expect(getStoredSecrets('b')).toEqual({ password: 'pb' })
    })
  })

  describe('validation', () => {
    it('S3 で secretAccessKey だけあり accessKeyId が空の下書きは失敗する（partial secret 拒否）', async () => {
      await expect(
        saveConnections([
          {
            id: 's3-1',
            name: 'S3',
            kind: 's3',
            region: 'ap-northeast-1',
            accessKeyId: '',
            secretAccessKey: 'sec',
            sessionToken: '',
          },
        ])
      ).rejects.toThrow(/incomplete/)
    })

    it('非文字列 password は secret なし扱いで保存する（不正型を暗号化しない）', async () => {
      // IPC 由来で number が来た場合（TypeScript の型は通るが runtime では不正値）。
      await saveConnections([
        {
          id: 'sftp-1',
          name: 'SFTP',
          kind: 'sftp',
          host: 'h',
          port: 22,
          username: 'u',
          password: 42 as unknown as string,
          rootPath: '/',
        },
      ])
      // 非 string は secret なし扱い（暗号化ストアへ保存しない）。
      expect(getStoredSecrets('sftp-1')).toBeNull()
    })
  })
})
