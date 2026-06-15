import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { createDefaultSettings, type AppSettings } from '../../../../shared/settings'
import type { PreviewDocument, PreviewMeta } from '../../../../shared/preview'
import {
  MAX_EDITABLE_TEXT_BYTES,
  TEXT_ENCODINGS,
  type ReadEncoding,
  type TextEncoding,
} from '../../../../shared/transfer'
import { I18nProvider, useTranslation } from '../i18n/I18nContext'
import { resolveMessage, type Message } from '../i18n/translations'
import { SettingsProvider } from '../settings/SettingsContext'
import { Icon } from '../icons/Icon'
import {
  MAX_MATCHES,
  buildSegments,
  clampActiveIndex,
  nextMatchIndex,
  prevMatchIndex,
  searchText,
} from './previewSearch'

type ViewerStatus = 'loading' | 'ready' | 'error'

/**
 * 実ファイルを表示する読み取り専用ビューア本体。
 * main 管理セッション（送信元ウィンドウ束縛）から `loadPreview` で内容を取得し、
 * 文字コード切替・ウィンドウ内検索（Ctrl/Cmd+F）を提供する。target/secret は受け取らない。
 */
function PreviewViewer() {
  const { t } = useTranslation()
  // メタ情報（name/source/path）は内容ロードと独立に取得し、読み込み失敗中でも header を出せる。
  const [meta, setMeta] = useState<PreviewMeta | null>(null)
  const [doc, setDoc] = useState<PreviewDocument | null>(null)
  const [status, setStatus] = useState<ViewerStatus>('loading')
  const [error, setError] = useState<Message | null>(null)
  // 選択モード（ユーザーの意図）。Auto はそのまま保持し、Reload も Auto なら再判定する。
  const [selected, setSelected] = useState<ReadEncoding>('auto')
  // 自動判定で実際に採用された concrete encoding（表示用。選択モードとは分離する）。
  const [detected, setDetected] = useState<TextEncoding | null>(null)

  // 古い load 結果が後から新しい選択を上書きしないための request id（abort 相当）。
  const requestIdRef = useRef(0)

  // メタ情報を取得する（session があれば内容ロードと無関係に必ず取れる）。
  useEffect(() => {
    window.hedgeport
      .previewMetadata()
      .then(setMeta)
      .catch(() => undefined)
  }, [])

  /**
   * 指定 encoding でセッションのファイルを読み込む。race 対策で最新 request のみ反映する。
   * selected（選択モード）は上書きしない。検出結果は detected に分離して保持する。
   */
  const load = useCallback((encoding: ReadEncoding) => {
    const id = ++requestIdRef.current
    setStatus('loading')
    setError(null)
    window.hedgeport
      .loadPreview(encoding)
      .then((loaded) => {
        if (requestIdRef.current !== id) return
        setDoc(loaded)
        setDetected(loaded.document.encoding)
        setStatus('ready')
      })
      .catch((reason: unknown) => {
        if (requestIdRef.current !== id) return
        setError(reason instanceof Error ? { raw: reason.message } : { key: 'editor.couldNotOpenFile' })
        setStatus('error')
      })
  }, [])

  useEffect(() => {
    load('auto')
  }, [load])

  // ウィンドウタイトルへファイル名を反映する（main 設定の title をページ側でも維持）。
  useEffect(() => {
    if (meta) document.title = `${meta.name} — HedgePort Preview`
  }, [meta])

  /**
   * encoding を切り替えて再読込する。error 中でも操作でき、文字コードを変えて再試行できる。
   * Auto を選び直したときは Auto のまま（再判定）になる。
   */
  const changeEncoding = (value: ReadEncoding): void => {
    if (value === selected) return
    setSelected(value)
    load(value)
  }

  // 編集モード。view は読み取り専用ビューア、edit は textarea で編集する。
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  // 編集バッファと保存設定（concrete encoding / BOM）。entering edit で doc から seed する。
  const [editText, setEditText] = useState('')
  const [editEncoding, setEditEncoding] = useState<TextEncoding>('utf-8')
  const [editBom, setEditBom] = useState(false)
  const [dirty, setDirty] = useState(false)
  // 保存 / encoding 再読込中は編集系コントロールを抑止する。
  const [editBusy, setEditBusy] = useState(false)
  const [saveError, setSaveError] = useState<Message | null>(null)
  const [saved, setSaved] = useState(false)
  // 編集不可（サイズ超過）などのお知らせ。閲覧は継続する。
  const [editNotice, setEditNotice] = useState<Message | null>(null)

  // 編集上限のラベル（例: "1 MiB"）。メッセージのプレースホルダへ渡す。
  const editLimitLabel = `${MAX_EDITABLE_TEXT_BYTES / (1024 * 1024)} MiB`

  /**
   * 編集モードへ入る。サイズ超過時は明確なメッセージを出して閲覧を継続する（編集には入らない）。
   * 現在の doc の concrete encoding / BOM / 本文を編集バッファへ seed する。
   */
  const startEdit = (): void => {
    if (!doc) return
    if (doc.byteLength > MAX_EDITABLE_TEXT_BYTES) {
      setEditNotice({ key: 'preview.editTooLarge', params: { limit: editLimitLabel } })
      return
    }
    setEditNotice(null)
    setSearchOpen(false)
    setEditText(doc.document.text)
    setEditEncoding(doc.document.encoding)
    setEditBom(doc.document.bom)
    setDirty(false)
    setSaveError(null)
    setSaved(false)
    setEditBusy(false)
    setMode('edit')
  }

  /**
   * 編集を中断して閲覧へ戻る。未保存変更があれば確認する。
   */
  const cancelEdit = (): void => {
    if (dirty && !window.confirm(t('preview.confirmDiscard'))) return
    setMode('view')
    setDirty(false)
    setSaveError(null)
  }

  /**
   * 編集モードで文字コードを切り替え、その encoding で再読込して編集バッファを置き換える（既存エディタと同様）。
   * 未保存変更があれば確認する。race 対策で最新 request のみ反映する。
   */
  const changeEditEncoding = (value: TextEncoding): void => {
    if (value === editEncoding) return
    if (dirty && !window.confirm(t('confirm.reloadEncoding'))) return
    const id = ++requestIdRef.current
    setSelected(value)
    setEditBusy(true)
    setSaveError(null)
    window.hedgeport
      .loadPreview(value)
      .then((loaded) => {
        if (requestIdRef.current !== id) return
        setDoc(loaded)
        setDetected(loaded.document.encoding)
        setEditBusy(false)
        // 再読込結果が編集上限を超えるなら編集バッファへ入れず、閲覧へ戻してメッセージを出す
        // （20MiB まで読めるプレビューと違い、編集は 1MiB 以下のみ）。
        if (loaded.byteLength > MAX_EDITABLE_TEXT_BYTES) {
          setMode('view')
          setDirty(false)
          setEditNotice({ key: 'preview.editTooLarge', params: { limit: editLimitLabel } })
          return
        }
        setEditText(loaded.document.text)
        setEditEncoding(loaded.document.encoding)
        setEditBom(loaded.document.bom)
        setDirty(false)
      })
      .catch((reason: unknown) => {
        if (requestIdRef.current !== id) return
        setSaveError(reason instanceof Error ? { raw: reason.message } : { key: 'editor.couldNotOpenFile' })
        setEditBusy(false)
      })
  }

  /**
   * 編集内容を保存する。競合（読込後にファイル変更）は main が検知して conflict{token} を返すので、
   * ユーザー確認のうえ main 発行の overwriteToken を添えて再保存する（任意上書きを renderer 単独で行わない）。
   * 保存成功時は doc を保存内容（text/encoding/bom と main が返した byteLength）へ更新し、
   * Cancel→view や再 Edit で古い本文を再保存して巻き戻すのを防ぐ。
   *
   * @param overwriteToken 競合確認後の再保存に添える main 発行トークン
   */
  const save = (overwriteToken?: string): void => {
    setEditBusy(true)
    setSaveError(null)
    setSaved(false)
    // 保存したスナップショット（解決時に doc へ反映する。途中の編集と取り違えない）。
    const savedText = editText
    const savedEncoding = editEncoding
    const savedBom = editBom
    window.hedgeport
      .savePreview({ text: savedText, encoding: savedEncoding, bom: savedBom, overwriteToken })
      .then((result) => {
        setEditBusy(false)
        if (result.status === 'conflict') {
          // 競合確認はユーザーへ。承認時だけ main 発行トークンで再保存する。
          if (window.confirm(t('preview.confirmOverwrite'))) save(result.token)
          return
        }
        // 保存成功: 表示中 doc を保存内容へ更新（main が返した実 byteLength を使う）。
        setDoc((current) =>
          current
            ? {
                ...current,
                document: { text: savedText, encoding: savedEncoding, bom: savedBom },
                byteLength: result.byteLength,
              }
            : current
        )
        setDetected(savedEncoding)
        setDirty(false)
        setSaved(true)
      })
      .catch((reason: unknown) => {
        setEditBusy(false)
        setSaveError(reason instanceof Error ? { raw: reason.message } : { key: 'editor.couldNotSaveFile' })
      })
  }

  // window レベルの keydown / beforeunload が最新の mode / dirty / translator を見るための ref。
  const modeRef = useRef(mode)
  modeRef.current = mode
  const dirtyRef = useRef(false)
  dirtyRef.current = mode === 'edit' && dirty
  const tRef = useRef(t)
  tRef.current = t
  // 自前の確認を済ませた close では beforeunload の確認を二重に出さないためのバイパス。
  const bypassUnloadRef = useRef(false)

  // 未保存のまま OS のウィンドウ閉じ（X）が来たときの確認。
  // Electron の beforeunload は returnValue を立てるだけだと無言でキャンセルになるため、
  // dirty 時は実際に確認ダイアログを出し、拒否されたときだけ close をキャンセルする
  // （Close ボタンと同じ確認挙動）。自前確認済み（requestClose）はバイパスする。
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent): void => {
      if (!dirtyRef.current || bypassUnloadRef.current) return
      if (!window.confirm(tRef.current('preview.confirmDiscard'))) {
        event.preventDefault()
        // Electron は returnValue が立っていると close をキャンセルする。
        ;(event as unknown as { returnValue: boolean }).returnValue = false
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  /** Close ボタン: 未保存変更があれば確認し、承認時のみ閉じる。 */
  const requestClose = (): void => {
    if (dirtyRef.current && !window.confirm(t('preview.confirmDiscard'))) return
    bypassUnloadRef.current = true
    window.close()
  }

  const text = doc?.document.text ?? ''

  // 検索状態。
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const activeMatchRef = useRef<HTMLElement>(null)

  const search = useMemo(() => searchText(text, query, caseSensitive), [text, query, caseSensitive])
  // 次/前ボタンが常に最新 match 数を見るための ref。
  const matchesRef = useRef(search.matches)
  matchesRef.current = search.matches

  // query / 区別切替の変更時は先頭 match へ。
  useEffect(() => {
    setActiveIndex(matchesRef.current.length > 0 ? 0 : -1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive])

  // 本文変更（encoding 再読込）時は query を保ったまま active を範囲内へ reconcile する。
  useEffect(() => {
    setActiveIndex((prev) => clampActiveIndex(prev, matchesRef.current.length))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  // active match を中央へスクロールする。
  useEffect(() => {
    activeMatchRef.current?.scrollIntoView({ block: 'center' })
  }, [activeIndex])

  const openSearch = useCallback(() => {
    setSearchOpen(true)
    // 既に開いていても再 focus + 全選択する。
    const input = searchInputRef.current
    if (input) {
      input.focus()
      input.select()
    }
  }, [])

  // searchOpen になった初回は描画後に focus + 全選択する。
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
  }, [searchOpen])

  const closeSearch = useCallback(() => setSearchOpen(false), [])
  const goNext = useCallback(() => setActiveIndex((i) => nextMatchIndex(i, matchesRef.current.length)), [])
  const goPrev = useCallback(() => setActiveIndex((i) => prevMatchIndex(i, matchesRef.current.length)), [])

  // window レベルの keydown で Escape を扱うための最新 searchOpen 参照。
  const searchOpenRef = useRef(searchOpen)
  searchOpenRef.current = searchOpen

  // Ctrl+F / Cmd+F で検索バーを開き標準 find を抑止。Escape は focus 位置に依らず検索バーだけ閉じる。
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
        // 検索バー（mark ハイライト）は閲覧モード専用。編集中は textarea なので開かない。
        if (modeRef.current !== 'view') return
        event.preventDefault()
        openSearch()
      } else if (event.key === 'Escape' && searchOpenRef.current) {
        // 検索バー内のボタンや本文へ focus が移っていてもバーを閉じる（ウィンドウは閉じない）。
        event.preventDefault()
        closeSearch()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSearch, closeSearch])

  /** 検索入力内のキー操作: Enter=次 / Shift+Enter=前（Escape は window ハンドラで処理）。 */
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) goPrev()
      else goNext()
    }
  }

  const matchCount = search.matches.length
  const segments = useMemo(
    () => buildSegments(text, search.matches, query.length, activeIndex),
    [text, search.matches, query.length, activeIndex]
  )

  /** 検索結果ステータス（aria-live で読み上げ）。query 空は表示なし。 */
  const searchStatus = (): string => {
    if (query.length === 0) return ''
    if (matchCount === 0) return t('preview.search.noMatches')
    const base = t('preview.search.status', { current: activeIndex + 1, total: matchCount })
    return search.truncated ? `${base} · ${t('preview.search.truncated', { max: MAX_MATCHES })}` : base
  }

  return (
    <main className="preview-window">
      <header className="preview-header">
        <div className="preview-meta">
          <span className="preview-source-badge">
            {meta ? t(meta.source === 'local' ? 'preview.sourceLocal' : 'preview.sourceRemote') : ''}
          </span>
          <h1 className="preview-name">{meta?.name ?? ''}</h1>
          {meta && (
            <span
              className="preview-path"
              title={meta.displayPath}
              aria-label={`${t('preview.pathLabel')}: ${meta.displayPath}`}
            >
              {meta.displayPath}
            </span>
          )}
        </div>
        <div className="preview-tools">
          <label className="preview-encoding">
            <span>{t('editor.encoding')}</span>
            {mode === 'edit' ? (
              // 編集モードは保存用の concrete encoding を選ぶ（Auto なし。変更で再読込）。
              <select
                aria-label={t('editor.encoding')}
                value={editEncoding}
                disabled={editBusy}
                onChange={(event) => changeEditEncoding(event.target.value as TextEncoding)}
              >
                {TEXT_ENCODINGS.map((encoding) => (
                  <option key={encoding} value={encoding}>
                    {encoding}
                  </option>
                ))}
              </select>
            ) : (
              <select
                aria-label={t('editor.encoding')}
                value={selected}
                disabled={status === 'loading'}
                onChange={(event) => changeEncoding(event.target.value as ReadEncoding)}
              >
                {/* Auto は選択モードとして保持し、検出された encoding は補足表示する。 */}
                <option value="auto">
                  {detected ? t('preview.encodingAutoDetected', { encoding: detected }) : t('preview.encodingAuto')}
                </option>
                {TEXT_ENCODINGS.map((encoding) => (
                  <option key={encoding} value={encoding}>
                    {encoding}
                  </option>
                ))}
              </select>
            )}
          </label>
          {/* BOM は編集モードの utf-8 のときだけ。切替は dirty 扱い（保存形式に影響する）。 */}
          {mode === 'edit' && editEncoding === 'utf-8' && (
            <label className="preview-encoding">
              <input
                type="checkbox"
                aria-label="UTF-8 BOM"
                checked={editBom}
                disabled={editBusy}
                onChange={(event) => {
                  setEditBom(event.target.checked)
                  setDirty(true)
                  setSaved(false)
                }}
              />
              <span>BOM</span>
            </label>
          )}
          {/* 編集ボタンは閲覧モードでファイル読込成功時のみ。サイズ超過は startEdit がメッセージで弾く。 */}
          {mode === 'view' && status === 'ready' && (
            <button
              className="compact-button"
              type="button"
              aria-label={t('preview.edit')}
              title={t('preview.edit')}
              onClick={startEdit}
            >
              {t('preview.edit')}
            </button>
          )}
          {mode === 'edit' ? (
            <>
              <button className="compact-button" type="button" disabled={editBusy} onClick={cancelEdit}>
                {t('common.cancel')}
              </button>
              <button type="button" disabled={editBusy || !dirty} onClick={() => save()}>
                {editBusy ? t('editor.saving') : t('common.save')}
              </button>
            </>
          ) : (
            <button
              className="icon-button"
              type="button"
              aria-label={t('preview.reload')}
              title={t('preview.reload')}
              disabled={status === 'loading'}
              onClick={() => load(selected)}
            >
              <Icon name="refresh" />
            </button>
          )}
          <button
            className="icon-button"
            type="button"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={requestClose}
          >
            <Icon name="close" />
          </button>
        </div>
      </header>

      {/* 編集不可（サイズ超過）のお知らせ。閲覧は継続。 */}
      {mode === 'view' && editNotice && <p className="preview-message error">{resolveMessage(t, editNotice)}</p>}
      {/* 保存エラー / 保存成功の表示（編集モード）。 */}
      {mode === 'edit' && saveError && <p className="preview-message error">{resolveMessage(t, saveError)}</p>}
      {mode === 'edit' && saved && !dirty && (
        <p className="preview-saved-note" aria-live="polite">
          {t('preview.saved')}
        </p>
      )}

      {mode === 'view' && searchOpen && (
        <div className="preview-search" role="search" aria-label={t('preview.search.label')}>
          <input
            ref={searchInputRef}
            type="search"
            className="preview-search-input"
            aria-label={t('preview.search.placeholder')}
            placeholder={t('preview.search.placeholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          <button
            className="icon-button"
            type="button"
            aria-label={t('preview.search.previous')}
            title={t('preview.search.previous')}
            disabled={matchCount === 0}
            onClick={goPrev}
          >
            <span aria-hidden="true">↑</span>
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={t('preview.search.next')}
            title={t('preview.search.next')}
            disabled={matchCount === 0}
            onClick={goNext}
          >
            <span aria-hidden="true">↓</span>
          </button>
          <span className="preview-search-status" aria-live="polite">
            {searchStatus()}
          </span>
          <label className="preview-search-case">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(event) => setCaseSensitive(event.target.checked)}
            />
            <span>{t('preview.search.caseSensitive')}</span>
          </label>
          <button
            className="icon-button"
            type="button"
            aria-label={t('preview.search.close')}
            title={t('preview.search.close')}
            onClick={closeSearch}
          >
            <Icon name="close" />
          </button>
        </div>
      )}

      {status === 'loading' ? (
        <p className="preview-message">{t('editor.loading')}</p>
      ) : status === 'error' ? (
        <div className="preview-message error">
          <p>{error && resolveMessage(t, error)}</p>
          <button className="compact-button" type="button" onClick={() => load(selected)}>
            {t('common.tryAgain')}
          </button>
        </div>
      ) : mode === 'edit' ? (
        <textarea
          className="preview-editor"
          aria-label={t('editor.fileContents')}
          value={editText}
          spellCheck={false}
          disabled={editBusy}
          autoFocus
          onChange={(event) => {
            setEditText(event.target.value)
            setDirty(true)
            setSaved(false)
          }}
          onKeyDown={(event) => {
            // 編集中: Ctrl/Cmd+S で保存（未編集や処理中は無視）。
            if (event.key === 's' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              if (dirty && !editBusy) save()
            }
          }}
        />
      ) : text.length === 0 ? (
        <p className="preview-message">{t('preview.empty')}</p>
      ) : (
        <pre className="preview-body" aria-label={t('editor.fileContents')} tabIndex={0}>
          {searchOpen && query.length > 0
            ? segments.map((segment, index) =>
                segment.highlight === 'none' ? (
                  <Fragment key={index}>{segment.text}</Fragment>
                ) : (
                  <mark
                    key={index}
                    ref={segment.highlight === 'active' ? activeMatchRef : undefined}
                    className={segment.highlight === 'active' ? 'preview-match-active' : 'preview-match'}
                  >
                    {segment.text}
                  </mark>
                )
              )
            : // query なしは本文を単一 text node として描画する。
              text}
        </pre>
      )}
    </main>
  )
}

/**
 * 別ウィンドウのプレビュー画面。
 * メインウィンドウと同じ設定をロードし、テーマ / 文字サイズ / 密度 / 言語を適用する。
 */
export function PreviewWindow() {
  const [settings, setSettings] = useState<AppSettings>(() => createDefaultSettings(navigator.language))

  useEffect(() => {
    void window.hedgeport
      .loadSettings()
      .then(setSettings)
      .catch(() => undefined)
  }, [])

  return (
    <SettingsProvider settings={settings}>
      <I18nProvider language={settings.language}>
        <PreviewViewer />
      </I18nProvider>
    </SettingsProvider>
  )
}
