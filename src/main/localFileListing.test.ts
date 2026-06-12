import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { listLocalEntries } from './localFileListing'

describe('listLocalEntries', () => {
  let tempDir: string

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  })

  it('ディレクトリ優先でエントリを返す', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hedgeport-local-list-'))
    await mkdir(join(tempDir, 'beta'))
    await writeFile(join(tempDir, 'alpha.txt'), 'hello', 'utf8')
    await mkdir(join(tempDir, 'alpha-dir'))

    const result = await listLocalEntries(tempDir)

    expect(result.path).toBe(tempDir)
    expect(result.parentPath).toBe(join(tempDir, '..'))
    expect(result.entries.map((entry) => ({ name: entry.name, type: entry.type }))).toEqual([
      { name: 'alpha-dir', type: 'directory' },
      { name: 'beta', type: 'directory' },
      { name: 'alpha.txt', type: 'file' },
    ])
    expect(result.entries.find((entry) => entry.name === 'alpha.txt')).toMatchObject({
      size: 5,
      modifiedAt: expect.any(String),
    })
  })

  it('空ディレクトリでも親パス付きで返す', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hedgeport-local-list-'))

    const result = await listLocalEntries(tempDir)

    expect(result).toEqual({
      path: tempDir,
      parentPath: join(tempDir, '..'),
      entries: [],
    })
  })
})