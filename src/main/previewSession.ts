import { randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'

import { isConnectionTarget } from './connectionStore'
import { basenameVirtual, isCanonicalVirtualEntryPath } from './providers/pathUtils'
import {
  isPreviewSource,
  type PreviewDocument,
  type PreviewMeta,
  type PreviewOpenRequest,
  type PreviewSaveResult,
} from '../shared/preview'
import { TEXT_ENCODINGS, type ReadEncoding, type TextDocument, type TextEncoding } from '../shared/transfer'

/**
 * 競合上書きの一回限りトークン。
 * main が競合検出時に発行し、検出時点の live revision（conflictRevision）へ束縛する。
 * 再保存はこのトークン必須で、再取得した live revision が conflictRevision と一致する場合だけ上書きを許す。
 */
export interface PendingOverwrite {
  token: string
  /** 競合検出時に観測した live revision。再保存時もこれと一致する場合だけ上書きする。 */
  conflictRevision: string
}

/**
 * main が保持するプレビューセッション。
 * 送信元ウィンドウ（webContents.id）へ束縛し、renderer から任意 path/target を指定させない。
 * revision は読込 / 保存成功時に main 側が更新する「最後に把握した内容リビジョン」で、
 * 保存直前の競合検知に使う（未ロードは null）。
 * pendingOverwrite は競合検出時に発行した一回限りの上書きトークン（保存成功 / 再 load / close で破棄）。
 */
export interface PreviewSession {
  request: PreviewOpenRequest
  revision: string | null
  pendingOverwrite: PendingOverwrite | null
}

/**
 * reader が返す読み出し結果（表示用テキスト・内容リビジョン・生バイト長）。
 */
export interface PreviewReadResult {
  document: TextDocument
  revision: string
  byteLength: number
}

/**
 * プレビュー読み出しに使う reader 群。
 * 既存の readRemoteTextWithRevision / readLocalTextWithRevision を注入し、テスト時は差し替える。
 * path/target/NUL/サイズ/encoding の検証は reader 側（既存実装）が担保する。
 * revision* は保存直前の競合検知用に「現在の内容リビジョンだけ」を取得する（decode しない）。
 */
export interface PreviewReaders {
  readRemote: (target: unknown, path: string, encoding?: ReadEncoding) => Promise<PreviewReadResult>
  readLocal: (path: string, encoding?: ReadEncoding) => Promise<PreviewReadResult>
  revisionRemote: (target: unknown, path: string) => Promise<string>
  revisionLocal: (path: string) => Promise<string>
}

/**
 * プレビュー編集の保存に使う writer 群。
 * 既存の writeRemoteTextWithRevision / writeLocalTextWithRevision を注入し、テスト時は差し替える。
 * 書き込んだ内容のリビジョンを返し、セッションの基準リビジョン更新に使う。
 */
export interface PreviewWriters {
  writeRemote: (
    target: unknown,
    path: string,
    text: string,
    encoding: TextEncoding,
    bom: boolean
  ) => Promise<{ revision: string; byteLength: number }>
  writeLocal: (
    path: string,
    text: string,
    encoding: TextEncoding,
    bom: boolean
  ) => Promise<{ revision: string; byteLength: number }>
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
 * 保存要求（renderer 由来）を main 境界で検証・正規化する。
 * target / path は受け取らない（セッションから解決する）。text / encoding / bom / overwrite だけを検証する。
 *
 * @param value renderer から来た未検証の保存要求
 * @returns 正規化済みの保存パラメータ
 * @throws 形状・text・encoding・bom・overwrite が不正な場合
 */
function validateSaveRequest(value: unknown): {
  text: string
  encoding: TextEncoding
  bom: boolean
  overwriteToken: string | undefined
} {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid save request.')
  const candidate = value as Record<string, unknown>
  if (typeof candidate.text !== 'string') throw new Error('Invalid text content.')
  if (typeof candidate.encoding !== 'string' || !TEXT_ENCODINGS.includes(candidate.encoding as TextEncoding)) {
    throw new Error('Unsupported encoding.')
  }
  if (typeof candidate.bom !== 'boolean') throw new Error('Invalid BOM flag.')
  if (candidate.overwriteToken !== undefined && typeof candidate.overwriteToken !== 'string') {
    throw new Error('Invalid overwrite token.')
  }
  return {
    text: candidate.text,
    encoding: candidate.encoding as TextEncoding,
    bom: candidate.bom,
    overwriteToken: candidate.overwriteToken as string | undefined,
  }
}

/**
 * セッションの request を対応する reader で読み、表示用 PreviewDocument と内容リビジョンを返す。
 * 接続先 target / 認証情報は返さない。
 *
 * @param request セッションが保持する要求
 * @param encoding 読み出し文字コード（auto / concrete、未指定は reader 既定 = auto）
 * @param readers remote/local reader
 * @returns 表示用ドキュメントと内容リビジョン
 */
export async function readPreviewContent(
  request: PreviewOpenRequest,
  encoding: ReadEncoding | undefined,
  readers: PreviewReaders
): Promise<{ document: PreviewDocument; revision: string }> {
  const result =
    request.source === 'remote'
      ? await readers.readRemote(request.target, request.path, encoding)
      : await readers.readLocal(request.path, encoding)
  return {
    document: {
      name: request.name,
      displayPath: request.path,
      source: request.source,
      document: result.document,
      byteLength: result.byteLength,
    },
    revision: result.revision,
  }
}

/**
 * 送信元ウィンドウ（webContents.id）へ束縛したプレビューセッションの保管庫。
 * key は sender id のみで、renderer から他ウィンドウのセッション id / path を指定する余地を与えない。
 */
export interface PreviewSessionStore {
  register(senderId: number, request: PreviewOpenRequest): void
  get(senderId: number): PreviewSession | undefined
  /** 読込 / 保存成功時に把握した内容リビジョンを更新する（競合検知の基準）。 */
  setRevision(senderId: number, revision: string): void
  /** 競合上書きトークンを設定 / 破棄する。 */
  setPendingOverwrite(senderId: number, pending: PendingOverwrite | null): void
  delete(senderId: number): void
  has(senderId: number): boolean
  readonly size: number
}

/**
 * プレビューセッション保管庫を生成する。
 *
 * @returns register / get / setRevision / setPendingOverwrite / delete / has / size を持つ保管庫
 */
export function createPreviewSessionStore(): PreviewSessionStore {
  const sessions = new Map<number, PreviewSession>()
  return {
    register(senderId, request) {
      // 登録時は未ロード（revision=null）・上書きトークンなし。最初の load で revision を確定する。
      sessions.set(senderId, { request, revision: null, pendingOverwrite: null })
    },
    get(senderId) {
      return sessions.get(senderId)
    },
    setRevision(senderId, revision) {
      const session = sessions.get(senderId)
      if (session) session.revision = revision
    },
    setPendingOverwrite(senderId, pending) {
      const session = sessions.get(senderId)
      if (session) session.pendingOverwrite = pending
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
  const { document, revision } = await readPreviewContent(session.request, encoding, readers)
  // 読込時点の内容リビジョンを保持し、後続の保存で競合検知の基準にする。
  store.setRevision(senderId, revision)
  // 再 load で基準が変わるため、保留中の上書きトークンは破棄する。
  store.setPendingOverwrite(senderId, null)
  return document
}

/**
 * preview:save を処理する。送信元 id に束縛されたセッションだけを保存できる。
 *
 * 競合検知も上書き可否も必ず main 側で行う（renderer の真偽値に委ねない）:
 * 1. 保存直前に現在の内容リビジョン（live）を再取得する。
 * 2. overwriteToken なし:
 *    - live が把握リビジョンと一致 → 書き込み（saved）。
 *    - 異なる → 書き込まず、live へ束縛した一回限りの上書きトークンを発行して conflict{token} を返す。
 * 3. overwriteToken あり（競合確認後の再保存）:
 *    - 保留トークンと一致しない（不正・別 window・再利用済み）→ 拒否。
 *    - 一致しても live が conflictRevision と更に変わっていれば、新しいトークンで conflict を返す。
 *    - live が conflictRevision と一致するときだけ上書き（saved）。
 * 4. saved 時は基準リビジョンを更新し、保留トークンを破棄する。
 *
 * 未ロード（revision=null）のセッションからの保存は基準が無いため拒否する。
 * サイズ上限（編集 1 MiB）や表現不能文字は writer（encode 側）が判定する。
 *
 * @param store セッション保管庫
 * @param senderId 呼び出し元 webContents.id（event.sender.id）
 * @param request renderer 由来の未検証保存要求（target/path を含まない）
 * @param readers 競合検知用の revision 取得を含む reader
 * @param writers remote/local writer
 * @param makeToken 上書きトークン生成（既定は randomUUID。テストで差し替え可能）
 * @returns saved（新リビジョン・バイト長付き）または conflict（一回限りトークン付き）
 * @throws セッションが無い / 未ロード / 要求が不正 / トークン不正 / 書き込み失敗の場合
 */
export async function handlePreviewSave(
  store: PreviewSessionStore,
  senderId: number,
  request: unknown,
  readers: PreviewReaders,
  writers: PreviewWriters,
  makeToken: () => string = randomUUID
): Promise<PreviewSaveResult> {
  const { text, encoding, bom, overwriteToken } = validateSaveRequest(request)
  const session = store.get(senderId)
  if (!session) throw new Error('No preview session for this window.')
  if (session.revision === null) throw new Error('Preview content is not loaded yet.')
  const { request: req } = session

  // 保存直前に現在のリビジョンを取得し、読込後に変更されていないか main 側で判定する。
  const live =
    req.source === 'remote' ? await readers.revisionRemote(req.target, req.path) : await readers.revisionLocal(req.path)

  if (overwriteToken !== undefined) {
    // 再保存: 保留中の一回限りトークンと厳密一致が必須（不正・別 window・再利用は拒否）。
    if (!session.pendingOverwrite || session.pendingOverwrite.token !== overwriteToken) {
      throw new Error('Invalid or expired overwrite token.')
    }
    // 承認した競合からさらに変更されていたら上書きせず、新しいトークンで再確認させる。
    if (live !== session.pendingOverwrite.conflictRevision) {
      const token = makeToken()
      store.setPendingOverwrite(senderId, { token, conflictRevision: live })
      return { status: 'conflict', token }
    }
    // ここまで来たら上書き可。
  } else if (live !== session.revision) {
    // 初回保存で競合検出。live へ束縛した一回限りトークンを発行する。
    const token = makeToken()
    store.setPendingOverwrite(senderId, { token, conflictRevision: live })
    return { status: 'conflict', token }
  }

  const { revision, byteLength } =
    req.source === 'remote'
      ? await writers.writeRemote(req.target, req.path, text, encoding, bom)
      : await writers.writeLocal(req.path, text, encoding, bom)
  // 保存成功後は基準リビジョンを更新し、保留トークンを破棄する。
  store.setRevision(senderId, revision)
  store.setPendingOverwrite(senderId, null)
  return { status: 'saved', revision, byteLength }
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
