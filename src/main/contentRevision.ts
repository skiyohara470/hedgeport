import { createHash } from 'node:crypto'

/**
 * ファイルの生バイト列から安定した内容リビジョンを計算する。
 *
 * 同一バイト列は常に同一値、1 バイトでも異なれば別値になる。provider 非依存（local / SFTP / S3 共通）で、
 * 空ファイルも安定値を返す。プレビュー編集の保存直前に「読込後にファイルが変更されたか」を main 側で
 * 判定するために使う（renderer へ判断を委ねない）。
 *
 * @param data ファイルの生バイト列
 * @returns SHA-256 ダイジェスト（16 進文字列）
 */
export function computeContentRevision(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}
