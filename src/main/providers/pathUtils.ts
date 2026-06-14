import { posix } from 'node:path'

/**
 * UI 上の仮想パスは常に POSIX 形式の絶対パスとして扱う。
 * これで SFTP / S3 どちらでも renderer 側のパス表現を統一できる。
 */
export function normalizeVirtualPath(path: string): string {
  const normalized = posix.normalize(`/${path}`)
  return normalized === '/.' ? '/' : normalized
}

export function joinVirtualPath(parent: string, name: string): string {
  return normalizeVirtualPath(posix.join(parent, name))
}

/**
 * 仮想ルートの親は存在しないので null を返す。
 */
export function parentVirtualPath(path: string): string | null {
  const normalized = normalizeVirtualPath(path)
  return normalized === '/' ? null : normalizeVirtualPath(posix.dirname(normalized))
}

/**
 * 仮想パスの末尾要素（ファイル / ディレクトリ名）を返す。
 */
export function basenameVirtual(path: string): string {
  return posix.basename(normalizeVirtualPath(path))
}

/**
 * 「正規化済みの絶対仮想エントリパス（ルート不可）」かを判定する。
 *
 * provider 側は受け取ったパスを normalizeVirtualPath で正規化するため、'//', '/.', '/foo/..',
 * 末尾スラッシュ等の曖昧入力はルートや親へ滑り込み得る。先頭スラッシュ必須・末尾スラッシュ禁止・
 * 正規化結果が入力と一致・ルートでない、を満たす canonical な入力だけを true とする。
 */
export function isCanonicalVirtualEntryPath(path: string): boolean {
  if (!path.startsWith('/') || path.endsWith('/')) return false
  const normalized = normalizeVirtualPath(path)
  return normalized !== '/' && normalized === path
}

/**
 * path が ancestor 自身、またはその配下かを判定する。
 * rename で destination が source 配下へ潜り込む不正移動を弾くために使う。
 */
export function isDescendantOrSelf(path: string, ancestor: string): boolean {
  const target = normalizeVirtualPath(path)
  const base = normalizeVirtualPath(ancestor)
  return target === base || target.startsWith(base === '/' ? '/' : `${base}/`)
}

/**
 * SFTP の実パスへ変換する。
 * rootPath より上へは出られないよう、仮想パスは正規化してから結合する。
 */
export function joinSftpPath(rootPath: string, virtualPath: string): string {
  const root = posix.resolve('/', rootPath)
  const relative = normalizeVirtualPath(virtualPath).slice(1)
  return relative ? posix.join(root, relative) : root
}

/** S3 仮想パスを bucket と object 相対 key に分解した結果。 */
export interface S3PathParts {
  /** 先頭セグメント = bucket。ルート `/` のときは null。 */
  bucket: string | null
  /** bucket 以降の object key（空文字は bucket ルート）。 */
  key: string
}

/**
 * S3 仮想パス `/<bucket>/<key...>` を bucket と object key に分解する。
 * ルート `/` は bucket=null（bucket 一覧）、`/<bucket>` は key=''（bucket ルート）。
 *
 * @param path 仮想パス
 * @returns bucket と key
 */
export function parseS3VirtualPath(path: string): S3PathParts {
  const normalized = normalizeVirtualPath(path)
  if (normalized === '/') return { bucket: null, key: '' }
  const [bucket, ...rest] = normalized.slice(1).split('/')
  return { bucket, key: rest.join('/') }
}
