import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { createDefaultSettings, type AppSettings } from '../../../../shared/settings'
import type { PreviewDocument, PreviewMeta } from '../../../../shared/preview'
import { TEXT_ENCODINGS, type ReadEncoding, type TextEncoding } from '../../../../shared/transfer'
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
          </label>
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
          <button
            className="icon-button"
            type="button"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={() => window.close()}
          >
            <Icon name="close" />
          </button>
        </div>
      </header>

      {searchOpen && (
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
