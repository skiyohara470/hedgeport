import { basename, isAbsolute } from 'node:path'

import { isConnectionTarget } from './connectionStore'
import { basenameVirtual, isCanonicalVirtualEntryPath } from './providers/pathUtils'
import { isPreviewSource, type PreviewDocument, type PreviewMeta, type PreviewOpenRequest } from '../shared/preview'
import { TEXT_ENCODINGS, type ReadEncoding, type TextDocument, type TextEncoding } from '../shared/transfer'

/**
 * main が保持するプレビューセッション。
 * 送信元ウィンドウ（webContents.id）へ束縛し、renderer から任意 path/target を指定させない。
 */
export interface PreviewSession {
  request: PreviewOpenRequest
}

/**
 * プレビュー読み出しに使う reader 群。
 * 既存の readTextFile / readLocalText を注入し、テスト時は差し替える。
 * path/target/NUL/サイズ/encoding の検証は reader 側（既存実装）が担保する。
 */
export interface PreviewReaders {
  readRemote: (target: unknown, path: string, encoding?: ReadEncoding) => Promise<TextDocument>
  readLocal: (path: string, encoding?: ReadEncoding) => Promise<TextDocument>
}

/**
 * 文字列に NUL / 制御文字（タブ・改行等を含む）を含むか。
 * パス名へ制御文字が混ざるのは異常入力なので main 境界で弾く。
 */
function hasControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value)
}

/**
 * open request を検証して正規化する。
 * - source は local/remote
 * - path は NUL / 制御文字を含まないこと
 * - local は絶対パス、remote は canonical な仮想エントリパス（ルート不可）
 * - name は renderer 値を信用せず、検証済み path から main 側で導出する（trim 後 非空必須）
 * - remote は有効な ConnectionTarget 必須、local は target を保持しない（接続情報の混入を許さない）
 *
 * ディレクトリかどうか等の中身検証は reader（既存実装）に委ねる。
 *
 * @param value renderer から来た未検証の要求
 * @returns 正規化済み PreviewOpenRequest（name は path 由来）
 * @throws 形状・source・path・target が不正な場合
 */
export function validatePreviewRequest(value: unknown): PreviewOpenRequest {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid preview request.')
  const candidate = value as Record<string, unknown>
  if (!isPreviewSource(candidate.source)) throw new Error('Invalid preview source.')
  if (typeof candidate.path !== 'string' || candidate.path.length === 0 || hasControlChars(candidate.path)) {
    throw new Error('Invalid preview path.')
  }
  const path = candidate.path

  if (candidate.source === 'remote') {
    if (!isConnectionTarget(candidate.target)) throw new Error('Invalid connection settings.')
    if (!isCanonicalVirtualEntryPath(path)) throw new Error('Invalid preview path.')
    const name = basenameVirtual(path)
    if (name.trim().length === 0) throw new Error('Invalid preview path.')
    return { source: 'remote', path, name, target: candidate.target }
  }

  if (!isAbsolute(path)) throw new Error('Invalid preview path.')
  const name = basename(path)
  if (name.trim().length === 0) throw new Error('Invalid preview path.')
  // local は target を捨てる。
  return { source: 'local', path, name }
}

/**
 * preview:load の encoding 引数を main 境界で検証する。
 * 未指定 / 'auto' は自動判定、それ以外は対応 TextEncoding のみ許す。
 *
 * @param encoding renderer から来た未検証の encoding
 * @throws 未対応の encoding の場合
 */
function assertReadEncoding(encoding: unknown): asserts encoding is ReadEncoding | undefined {
  if (encoding === undefined || encoding === 'auto') return
  if (typeof encoding !== 'string' || !TEXT_ENCODINGS.includes(encoding as TextEncoding)) {
    throw new Error('Unsupported encoding.')
  }
}

/**
 * セッションの request を対応する reader で読み、表示用 PreviewDocument を返す。
 * 接続先 target / 認証情報は返さない。
 *
 * @param request セッションが保持する要求
 * @param encoding 読み出し文字コード（auto / concrete、未指定は reader 既定 = auto）
 * @param readers remote/local reader
 * @returns 表示用ドキュメント
 */
export async function loadPreviewDocument(
  request: PreviewOpenRequest,
  encoding: ReadEncoding | undefined,
  readers: PreviewReaders
): Promise<PreviewDocument> {
  const document =
    request.source === 'remote'
      ? await readers.readRemote(request.target, request.path, encoding)
      : await readers.readLocal(request.path, encoding)
  return { name: request.name, displayPath: request.path, source: request.source, document }
}

/**
 * 送信元ウィンドウ（webContents.id）へ束縛したプレビューセッションの保管庫。
 * key は sender id のみで、renderer から他ウィンドウのセッション id / path を指定する余地を与えない。
 */
export interface PreviewSessionStore {
  register(senderId: number, request: PreviewOpenRequest): void
  get(senderId: number): PreviewSession | undefined
  delete(senderId: number): void
  has(senderId: number): boolean
  readonly size: number
}

/**
 * プレビューセッション保管庫を生成する。
 *
 * @returns register / get / delete / has / size を持つ保管庫
 */
export function createPreviewSessionStore(): PreviewSessionStore {
  const sessions = new Map<number, PreviewSession>()
  return {
    register(senderId, request) {
      sessions.set(senderId, { request })
    },
    get(senderId) {
      return sessions.get(senderId)
    },
    delete(senderId) {
      sessions.delete(senderId)
    },
    has(senderId) {
      return sessions.has(senderId)
    },
    get size() {
      return sessions.size
    },
  }
}

/**
 * preview:metadata を処理する。送信元 id に束縛された session の表示用メタ情報だけを返す。
 * 内容ロードとは独立に必ず取得でき、文字コードエラー中でも file 名 / source / path を表示できる。
 * target / 認証情報は返さない。
 *
 * @param store セッション保管庫
 * @param senderId 呼び出し元 webContents.id
 * @returns name / displayPath / source
 * @throws 送信元にセッションが無い場合
 */
export function handlePreviewMeta(store: PreviewSessionStore, senderId: number): PreviewMeta {
  const session = store.get(senderId)
  if (!session) throw new Error('No preview session for this window.')
  return { name: session.request.name, displayPath: session.request.path, source: session.request.source }
}

/**
 * preview:load を処理する。送信元 id に束縛されたセッションだけを読める。
 * セッションが無いウィンドウ（メインウィンドウや別プレビュー）からの load は拒否する。
 *
 * @param store セッション保管庫
 * @param senderId 呼び出し元 webContents.id（event.sender.id）
 * @param encoding 読み出し文字コード（main 境界で検証する）
 * @param readers remote/local reader
 * @returns 表示用ドキュメント
 * @throws 送信元にセッションが無い / encoding が不正な場合
 */
export async function handlePreviewLoad(
  store: PreviewSessionStore,
  senderId: number,
  encoding: ReadEncoding | undefined,
  readers: PreviewReaders
): Promise<PreviewDocument> {
  assertReadEncoding(encoding)
  const session = store.get(senderId)
  if (!session) throw new Error('No preview session for this window.')
  return loadPreviewDocument(session.request, encoding, readers)
}

/**
 * プレビューウィンドウのライフサイクル抽象（electron 依存を index.ts へ閉じ込めるための注入境界）。
 */
export interface PreviewWindowHandle {
  /** 送信元束縛に使う webContents.id。 */
  id: number
  /** renderer の描画ロードを開始し、完了で解決する（失敗で reject）。 */
  loadContent: () => Promise<void>
  /** ウィンドウを破棄する。 */
  destroy: () => void
  /** ウィンドウ close 時のコールバックを登録する。 */
  onClosed: (callback: () => void) => void
  /** レンダラプロセス消失時のコールバックを登録する。 */
  onRenderProcessGone: (callback: () => void) => void
}

/**
 * プレビューを開く一連のライフサイクルを実行する（electron 非依存・テスト可能）。
 * 要求検証 → ウィンドウ生成 → session 登録 → close/render-gone で破棄を登録 → 描画ロードを await。
 * 描画ロードが失敗したら session を消し、ウィンドウも破棄してから throw する（残骸・宙ぶらりんな
 * session を残さない）。検証失敗時はウィンドウを作らない。
 *
 * @param request renderer 由来の未検証要求
 * @param store セッション保管庫
 * @param createWindow 検証済み要求からウィンドウハンドルを生成する関数
 * @throws 要求不正 / 描画ロード失敗の場合
 */
export async function openPreviewSession(
  request: unknown,
  store: PreviewSessionStore,
  createWindow: (request: PreviewOpenRequest) => PreviewWindowHandle
): Promise<void> {
  const validated = validatePreviewRequest(request)
  const handle = createWindow(validated)
  store.register(handle.id, validated)
  handle.onClosed(() => store.delete(handle.id))
  handle.onRenderProcessGone(() => store.delete(handle.id))
  try {
    await handle.loadContent()
  } catch (error) {
    store.delete(handle.id)
    handle.destroy()
    throw error
  }
}
