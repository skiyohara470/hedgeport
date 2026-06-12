import { describe, it, expect, beforeEach } from 'vitest'

import type { StorageEntry, StorageProvider } from './StorageProvider'

// このテストは StorageProvider 契約（list/read/write/delete）の整合を検証する。
// 計画 §4.2 / §6: 戻り値は Uint8Array、エラーは throw、具体実装は本タスク対象外。
// 検証には本番に置かないテスト用ダブル InMemoryStorageProvider を用いる。

/**
 * 契約検証用のインメモリ実装（テスト専用・本番コードには置かない）。
 * パスをフラットなキーとして保持し、list はディレクトリ直下の要素のみ返す。
 */
class InMemoryStorageProvider implements StorageProvider {
  private readonly files = new Map<string, Uint8Array>()

  async list(path: string): Promise<StorageEntry[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`
    const seenDirs = new Set<string>()
    const entries: StorageEntry[] = []
    for (const [filePath, data] of this.files) {
      if (!filePath.startsWith(prefix)) continue
      const rest = filePath.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) {
        entries.push({ name: rest, path: filePath, type: 'file', size: data.byteLength })
        continue
      }
      // ネストしたパスは直下ディレクトリとして1度だけ列挙する
      const dirName = rest.slice(0, slash)
      if (seenDirs.has(dirName)) continue
      seenDirs.add(dirName)
      entries.push({ name: dirName, path: `${prefix}${dirName}`, type: 'directory' })
    }
    return entries
  }

  async read(path: string): Promise<Uint8Array> {
    const data = this.files.get(path)
    if (!data) throw new Error(`not found: ${path}`)
    return data
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data)
  }

  async delete(path: string): Promise<void> {
    if (!this.files.has(path)) throw new Error(`not found: ${path}`)
    this.files.delete(path)
  }
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)

describe('StorageProvider 契約: write/read', () => {
  let provider: StorageProvider

  beforeEach(() => {
    provider = new InMemoryStorageProvider()
  })

  it('write したバイト列を read で取り出せる', async () => {
    // Given: 書き込むデータ
    const data = bytes('hello')

    // When: write してから read
    await provider.write('/inbox/report.csv', data)
    const got = await provider.read('/inbox/report.csv')

    // Then: 同じ内容が返る
    expect(text(got)).toBe('hello')
  })

  it('同じパスへ write すると上書きされる', async () => {
    // Given: 既存ファイル
    await provider.write('/a.txt', bytes('old'))

    // When: 同じパスへ再 write
    await provider.write('/a.txt', bytes('new'))

    // Then: 最新の内容が返る
    expect(text(await provider.read('/a.txt'))).toBe('new')
  })

  it('存在しないパスを read すると例外を投げる', async () => {
    // Given: 何も書き込んでいない

    // When/Then: 未知パスの read は reject
    await expect(provider.read('/missing')).rejects.toThrow()
  })

  it('テキストにできないバイト列も同一バイトで read できる', async () => {
    // Given: UTF-8 文字列にならない生バイト列（read 戻り値が Uint8Array 契約であることを担保）
    const raw = new Uint8Array([0, 1, 0xff, 0x80, 0x0a])

    // When: write してから read
    await provider.write('/bin/blob', raw)
    const got = await provider.read('/bin/blob')

    // Then: バイト列が一致する
    expect(Array.from(got)).toEqual([0, 1, 0xff, 0x80, 0x0a])
  })
})

describe('StorageProvider 契約: delete', () => {
  let provider: StorageProvider

  beforeEach(() => {
    provider = new InMemoryStorageProvider()
  })

  it('delete すると以後 read できなくなる', async () => {
    // Given: 書き込み済みファイル
    await provider.write('/tmp.txt', bytes('x'))

    // When: delete する
    await provider.delete('/tmp.txt')

    // Then: read は reject
    await expect(provider.read('/tmp.txt')).rejects.toThrow()
  })

  it('存在しないパスを delete すると例外を投げる', async () => {
    // Given: 何も書き込んでいない

    // When/Then: 未知パスの delete は reject
    await expect(provider.delete('/missing')).rejects.toThrow()
  })
})

describe('StorageProvider 契約: list', () => {
  let provider: StorageProvider

  beforeEach(() => {
    provider = new InMemoryStorageProvider()
  })

  it('空のディレクトリは空配列を返す', async () => {
    // Given: 何も書き込んでいない

    // When: ルートを list
    const entries = await provider.list('/')

    // Then: 空配列
    expect(entries).toEqual([])
  })

  it('直下のファイルを StorageEntry として返す', async () => {
    // Given: 直下に1ファイル
    await provider.write('/inbox/report.csv', bytes('abc'))

    // When: 親ディレクトリを list
    const entries = await provider.list('/inbox')

    // Then: file 型のエントリが name/path/size 付きで返る
    expect(entries).toEqual([
      { name: 'report.csv', path: '/inbox/report.csv', type: 'file', size: 3 },
    ])
  })

  it('ネストしたパスは直下ディレクトリとして1件に集約される', async () => {
    // Given: サブディレクトリ配下に複数ファイル
    await provider.write('/inbox/2026/a.csv', bytes('a'))
    await provider.write('/inbox/2026/b.csv', bytes('b'))

    // When: 親を list
    const entries = await provider.list('/inbox')

    // Then: directory 型の 2026 が1件だけ返る
    expect(entries).toEqual([{ name: '2026', path: '/inbox/2026', type: 'directory' }])
  })

  it('ファイルとサブディレクトリが混在する場合は両方を返す', async () => {
    // Given: 同一ディレクトリ直下に file と subdir を持つ構成
    await provider.write('/inbox/report.csv', bytes('abc'))
    await provider.write('/inbox/2026/old.csv', bytes('z'))

    // When: 親を list
    const entries = await provider.list('/inbox')

    // Then: file と directory の両方が列挙される（順序は契約外のため集合として検証）
    expect(entries).toHaveLength(2)
    expect(entries).toEqual(
      expect.arrayContaining([
        { name: 'report.csv', path: '/inbox/report.csv', type: 'file', size: 3 },
        { name: '2026', path: '/inbox/2026', type: 'directory' },
      ])
    )
  })
})
