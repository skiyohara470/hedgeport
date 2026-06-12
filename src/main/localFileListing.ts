import { join } from 'node:path'
import { homedir } from 'node:os'
import { readdir, stat } from 'node:fs/promises'

import type { StorageEntry } from '../shared/storage'

export interface LocalListResult {
  path: string
  parentPath: string | null
  entries: StorageEntry[]
}

/**
 * ローカルファイル一覧もリモート一覧と同じ並びに寄せる。
 * renderer 側が接続種別ごとに別のソート規則を持たないため。
 */
export async function listLocalEntries(requestedPath?: string): Promise<LocalListResult> {
  const path = requestedPath || homedir()
  const dirents = await readdir(path, { withFileTypes: true })
  const entries = await Promise.all(
    dirents.map(async (dirent) => {
      const entryPath = join(path, dirent.name)
      const metadata = await stat(entryPath)
      return {
        name: dirent.name,
        path: entryPath,
        type: dirent.isDirectory() ? ('directory' as const) : ('file' as const),
        size: dirent.isDirectory() ? undefined : metadata.size,
        modifiedAt: metadata.mtime.toISOString(),
      }
    })
  )

  // リモート一覧と見た目を揃えるため、ディレクトリ優先でソートする。
  entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
    return left.name.localeCompare(right.name)
  })

  return {
    path,
    parentPath: path === homedir() ? null : join(path, '..'),
    entries,
  }
}