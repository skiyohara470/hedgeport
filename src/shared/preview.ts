/**
 * 独立プレビューウィンドウの IPC 契約。
 * 認証情報やローカル絶対パスを URL/hash/query へ埋め込まず、main 管理のセッション越しに
 * ファイルを読むためのデータ形状だけをここへ置く（実装は持たない）。
 */
import type { ConnectionTarget } from './connections'
import type { TextDocument } from './transfer'

/** プレビュー対象の取得元。 */
export type PreviewSource = 'local' | 'remote'

/**
 * プレビューウィンドウを開く要求。
 * remote のときだけ接続先 target を含む（main がセッションへ保持し、renderer へは返さない）。
 */
export interface PreviewOpenRequest {
  source: PreviewSource
  /** local は絶対パス、remote は仮想パス。 */
  path: string
  /** 表示・ウィンドウタイトル用のファイル名。 */
  name: string
  /** remote のみ。接続先設定。 */
  target?: ConnectionTarget
}

/**
 * プレビューウィンドウ renderer へ返す表示用メタ情報。
 * 内容ロードとは独立に取得でき、文字コードエラー中でも file 名 / source / path を表示できる。
 * 接続先 target や認証情報は含めない（main 所有境界）。
 */
export interface PreviewMeta {
  name: string
  displayPath: string
  source: PreviewSource
}

/**
 * プレビューウィンドウ renderer へ返す表示用ドキュメント。
 * 接続先 target や認証情報は含めない（main 所有境界）。
 */
export interface PreviewDocument {
  /** ファイル名（表示・タイトル用）。 */
  name: string
  /** 表示用のパス（local 絶対パス / remote 仮想パス）。 */
  displayPath: string
  /** 取得元種別（UI の Local/Remote 表示に使う）。 */
  source: PreviewSource
  /** デコード済みテキストと concrete encoding / BOM。 */
  document: TextDocument
}

/**
 * 値が PreviewSource か判定する型ガード。
 *
 * @param value 任意の値
 * @returns 'local' / 'remote' のとき true
 */
export function isPreviewSource(value: unknown): value is PreviewSource {
  return value === 'local' || value === 'remote'
}
