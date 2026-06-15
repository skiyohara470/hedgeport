# HedgePort Architecture

## 目的

このドキュメントは、現在の HedgePort の実装構成を把握しやすくするためのものです。
PLAN.md は立ち上げ時の方針を扱い、このファイルは「今のコードがどう分かれているか」を扱います。

## 全体像

HedgePort は Electron アプリです。役割は大きく 4 層に分かれています。

1. `src/main`
   Electron main process。IPC の受け口、接続設定の保存、SFTP / S3 / ローカル一覧の実処理を持つ。

2. `src/preload`
   renderer へ安全に公開する API の境界層。`ipcRenderer` を直接 UI へ渡さず、`window.hedgeport` として必要最小限の機能だけ公開する。

3. `src/renderer`
   React UI。接続先選択、ファイラー、タブ、ローカル/リモートペイン、プレビュー画面を持つ。

4. `src/shared`
   main / preload / renderer で共有するインターフェース。実装ではなく、層をまたぐデータ形状だけを置く。

## ディレクトリ役割

### `src/main`

- `index.ts`
  Electron 起動、ウィンドウ生成、IPC 登録の入口。
- `connectionStore.ts`
  接続設定のロード / 保存。`migrateConnectionTarget` で legacy S3（bucket / prefix 付き）を load / save 両方で正規化する。
- `navigationInput.ts`
  マウス戻る/進みの OS イベント→履歴方向の写像（electron 非依存の純関数。`mapAppCommand` / `mapSwipeDirection` / `handleAppCommand` / `handleSwipe`）。`index.ts` がメインウィンドウ（プレビューウィンドウは対象外）の `app-command`（Win/Linux）と `swipe`（macOS）を捕捉し、Chromium 既定遷移を preventDefault して `history:navigate` を renderer へ送る。
- `previewSession.ts`
  独立プレビューウィンドウの session 管理（electron 非依存のロジック）。`validatePreviewRequest`（source 検証、local は絶対パス・remote は canonical 仮想エントリパス、NUL/制御文字を拒否、remote は target 必須・local は target を捨てる、name は renderer 値を信用せず検証済み path の basename から導出）、`createPreviewSessionStore`（`webContents.id` をキーにした保管庫）、`handlePreviewMeta`（送信元束縛の session から name/displayPath/source のみ返す。内容ロードと独立）、`handlePreviewLoad`（送信元束縛の session だけを reader で読む。encoding は `assertReadEncoding` で境界検証。読込時点の内容 revision を session へ記録）、`readPreviewContent`（reader 注入、target/secret を返さず、表示用 `PreviewDocument`〔`byteLength` 込み〕と revision を返す）、`handlePreviewSave`（送信元束縛の session だけを保存。`validateSaveRequest` で text/encoding/bom/overwriteToken を境界検証〔target/path は受け取らない〕。保存直前に現在 revision〔live〕を再取得。overwriteToken なしで live が既知 revision と異なれば書き込まず、live へ束縛した一回限りの上書きトークンを発行して `conflict{token}` を返す。overwriteToken ありの再保存は、session の保留トークンと厳密一致が必須〔不正・別 window・再利用は拒否〕で、さらに live が発行時の conflictRevision と一致する場合だけ上書き〔再度変わっていれば新しい `conflict{token}` を返す〕。saved 時のみ writer で書き込み、書き込んだ内容の revision/byteLength で session を更新し保留トークンを破棄。保留トークンは保存成功 / 再 load / close で破棄。未ロード〔revision=null〕からの保存は拒否。競合検出も上書き可否も main 側で判定し renderer の真偽値に委ねない）、`openPreviewSession`（要求検証 → ウィンドウ生成 → session 登録 → close/render-process-gone 破棄登録 → 描画ロードを await、失敗時は session 削除 + window 破棄してから throw。electron 非依存の注入境界で単体テスト可能）。revision は `contentRevision.ts` の `computeContentRevision`（生バイト列の SHA-256、provider 非依存）で算出する。`index.ts` は `preview:open`（`openPreviewSession` に BrowserWindow を `PreviewWindowHandle` として渡すだけ）、`preview:metadata`（`event.sender.id` の session メタ）、`preview:load`（`event.sender.id` の session のみ、`readRemoteTextWithRevision`/`readLocalTextWithRevision` を再利用）、`preview:save`（`event.sender.id` の session のみ、競合検知用の `readRemoteRevision`/`readLocalRevision` と書き込みの `writeRemoteTextWithRevision`/`writeLocalTextWithRevision` を注入）を配線する。メインウィンドウや別プレビューからの metadata/load/save は session を持たないため拒否される。競合判定は常に main 側で行い renderer に委ねない。
- `settingsStore.ts`
  アプリ設定（テーマ / 文字サイズ / 表示密度 / 隠しファイル / 削除確認 / 表示言語）の load / save。`userData/settings.json` へ atomic（temp+rename）・0600 で保存し、`shared/settings` の `normalizeSettings` で未知 / 不正フィールドを既定へ補正する version migration を兼ねる。接続レコードとは別ファイル。`language` の既定のみ `app.getLocale()` 由来。
- `connectionTesting.ts`
  SFTP / S3 の接続テスト。S3 はアカウント単位のため ListBuckets + 各 bucket の region 解決でアクセス可否を確認し、設定 region 内の accessible bucket 数を報告する（特定 bucket への HeadBucket は行わない）。
- `localFileListing.ts`
  ローカルファイル一覧取得。
- `fileTransfer.ts`
  単一ファイルの download / downloadToDirectory / upload / read-text / write-text / delete。入力検証（接続設定・リモート仮想パス・ローカル絶対パス）とテキスト編集の安全上限（NUL / サイズ）をここで担保する。バイト列は main 内で完結させ、renderer IPC へ往復させない。文字コードは `iconv-lite` で一元 decode/encode（utf-8 / shift_jis / euc-jp）。read は `auto`（自動判定）または concrete を受け、`TextDocument {text, encoding, bom}` を返す（encoding は常に concrete で BOM 有無を保持）。write は concrete のみ受け付け BOM を既定維持する。utf-8 不正時は文字コード選択を促す専用エラー。shift_jis / euc-jp は write 前に encode→decode の厳密 roundtrip を行い、表現不能文字（'?' 置換）を検出したら保存せずエラーにする。
- `storageMutations.ts`
  ディレクトリ作成 / リネーム（remote / local）。名前検証（空白のみ・`.`・`..`・`/`・`\`・NUL 拒否）、canonical パス構築、source 自身 / 配下 / ルートへの移動拒否、既存名衝突拒否をここで担保し、provider / fs へ委譲する。
- `batchOperations.ts`
  複数選択の一括処理（remote/local の delete、download、upload）。逐次処理し `BatchOperationResult {succeeded, failures[]}` を返す（all-or-nothing を偽装しない）。各項目で path / type を検証。local delete は lstat で symlink を追跡せず、directory は非再帰。
- `clipboard.ts`
  アプリ内クリップボードの貼り付け。remote↔local の 4 組合せ（download / upload / fs.copyFile / provider.copyFile・異接続は read→write）を main 内で処理。ディレクトリ copy は対象外。同名は `name copy.ext` 形式で衝突回避（`safeCopyName`）。
- `dialogs.ts`
  保存先ディレクトリ選択ダイアログ。`event.sender` から親ウィンドウを得て attach し、キャンセル時は null を返す。
- `textCodec.ts`
  文字コードの decode/encode と自動判定を一元化（`decodeTextDocument` / `encodeTextDocument` / `detectEncoding` / `resolveEncoding` / `resolveReadEncoding`）。fileTransfer / fileOpening が共有する純ロジック。
  read は `auto | TextEncoding` を受け、返す `TextDocument.encoding` は常に concrete（保存にそのまま使える）。write は concrete のみ受け付け、`auto` は拒否する。`decodeTextDocument` のサイズ上限は注入可能（`DecodeOptions { maxBytes, tooLargeMessage }`、decode 前に判定）。既定は編集用 `MAX_EDITABLE_TEXT_BYTES`（1 MiB）、プレビューは `MAX_PREVIEW_TEXT_BYTES`（20 MiB）を注入し用途別の超過メッセージを出す。`readTextFile` / `readLocalText` がこの options を透過するため、編集・プレビューで読み込み・decode・各種安全検証を共有しつつ上限だけ差し替えられる（重複実装なし）。
  **自動判定の方針（`detectEncoding`）**: ① サイズ上限 / NUL（バイナリ）は呼び出し側の `decodeTextDocument` で先に弾く。② UTF-8 BOM → utf-8。③ fatal な UTF-8 デコードが通る（ASCII / 空を含む）→ utf-8。④ それ以外は Shift_JIS / EUC-JP を構造的に検証し、妥当な候補が 1 つだけならそれを採用。⑤ 両方妥当なときだけ「日本語らしさスコア」（ひらがな・全角カタカナ・漢字を加点、置換文字 U+FFFD を減点。半角カナは誤デコードで多発するため数えない）を比較し、差が `SCORE_MARGIN`（=2）以上の明確な勝者がいる場合のみ採用。⑥ 曖昧 / どちらも不正なら黙って選ばず、手動選択を促す例外を投げる。
  **限界**: ヒューリスティックのため短いバイト列や日本語をほぼ含まない非 UTF-8 は曖昧判定になりやすく、その場合は手動 encoding 選択が必要。ISO-2022-JP / UTF-16 等は対象外。
- `fileOpening.ts`
  ローカルテキストの読み書き（built-in editor / preview 用）。open（`O_NOFOLLOW`, `O_CREAT` なし）→ fstat で通常ファイルを確認 → 同一 handle で read / truncate+write し、symlink・不在・差し替え（TOCTOU）を防ぐ。`O_NOFOLLOW` 非対応 OS は open 前 lstat（symlink 拒否）＋ open 後の dev/ino identity 比較でフォールバック。Choose Application はアプリ選択 → `spawn(shell:false, 引数配列)` で起動（mac は `open -a`、exit code / `error` を監視し失敗は reject）。
- `externalEdit.ts`
  リモート外部編集セッション。`target.id` + canonical remote path で一意管理し、start / upload / discard を per-key で**直列化**（single-flight）して二重生成や競合を防ぐ。app 所有の per-session temp（`getPath(temp)/hedgeport-edit/<uuid>`、dir 0700 / file 0600、basename のみで path traversal 防止）へ download して外部アプリ起動。mkdir 後の失敗（writeFile / launch）は**トランザクション的に巻き戻し**（map 登録解除＋temp 削除）再利用可能な残骸を残さない。Upload は temp を検証 handle で読み戻し、リモートの**削除 / 型変更 / メタデータ変化（modifiedAt/size）を conflict として block**。dirty は temp の stat スナップショット（mtime/size）と比較して main が判定し、`external:list` で id/status/dirty のみ公開（temp パスは非公開）。Discard で temp 片付け、アプリ終了は `will-quit` を一度保留して cleanup を await してから再 quit（失敗は非致命でログ）。外部プロセス終了は upload/discard を意味しない。
- `providers/`
  ストレージ抽象と具体実装。

### `src/preload`

- `index.ts`
  `window.hedgeport` を公開する。renderer はここで定義された API だけを使って main process と通信する。

### `src/renderer`

- `App.tsx`
  renderer の最上位。接続一覧ロード、画面分岐、ワークスペース表示を管理する。
- `features/connection/`
  接続先の作成、編集、選択 UI。起動時の選択画面（welcome variant）では各行を**ドラッグ＆ドロップ**で並び替えできる（native HTML5 DnD、新規依存なし）。各行左端に控えめな drag handle（grip dots、`aria-label="Drag <name> to reorder"`）を置き、handle だけを draggable にして接続選択 / 編集クリックを邪魔しない。ドラッグ中は控えめな挿入インジケータ（行の上/下境界）を表示し、drop 位置（before/after）はポインタ Y で判定する。DnD payload は ID のみ。タブ内の New tab 接続選択（tab variant）では並び替え不可。並び替え結果は即 `saveConnections` で永続化し、保存中は新しいドラッグを抑止（drag handle を draggable=false）。保存成功時のみ state を更新し、失敗時は順序を変えず既存の storageError 表示経路で通知。並び替えの純ロジック（source/target/before-after → 新配列、同位置 no-op・不明 ID は null）は `connectionReorder.ts` に分離（単体テスト済み）。可視↑↓ボタンとキーボード単独並び替えは今回スコープ外（接続選択 / 編集のキーボード操作は維持）。
- `features/filer/`
  ファイラー本体。タブ、選択、ソート、ローカル/リモートペインなどを持つ。
- `features/filer/fileActions.ts`
  アクション capability / menu 定義 / ショートカット判定を集約した純粋モジュール。context menu・toolbar・キーボードショートカットはすべてこの定義から駆動し齟齬を防ぐ（単体テスト済み）。
- `features/settings/`
  設定モーダル（`SettingsDialog`）と `SettingsProvider`（設定を配下へ供給し、ルート要素へ `data-theme` / `data-font-size` / `data-density` / `lang` を反映。theme=system は matchMedia に追従し listener を cleanup）。`appearance.ts` の `resolveTheme` / `applyAppearance` は純関数で単体テスト可能。設定ボタン（gear）は起動画面右上と workspace ツールバー（Show/Hide local files の隣）に置き、同じダイアログを開く（New tab 接続選択には出さない）。Save/Cancel 方式で、変更は即時プレビュー（draft を Provider に流す）し Cancel で元へ戻す。
- `features/i18n/`
  日本語 / 英語の軽量辞書（`translations.ts`、typed `TranslationKey`、`{name}` プレースホルダ置換）と `createTranslator` 純関数、`I18nProvider` / `useTranslation`。language 変更は再起動なしで即反映し `html lang` も更新する。renderer の可視文字列（ConnectionForm / FilerWorkspace / FileTable / 入力ダイアログ / エディタ・プレビュー / 外部編集バナー / context menu / toolbar / ナビ / status bar / fallback error）はすべて translator 経由。renderer 生成の status / validation は「翻訳キー + params」（main/server 由来は `raw`）の構造化状態で保持し、言語切替で再翻訳され、開いたままのフォーム / ダイアログ / エディタも即時更新される。複数 / 件数表現は言語別の明示キー（en は単数/複数を分離）。一覧の日付は OS ロケールではなく選択言語（`ja-JP` / `en-US`）で整形する。`fileActions` のラベルも translator 経由で context menu / toolbar の齟齬を防ぐ。未翻訳の可視リテラル混入（属性 / インライン JSX テキスト / `window.confirm` 等 / 英文 string literal）は contract test（`i18n.contract.test.ts`、技術名 allowlist 付き、回帰 fixture 付き）で検知する。`ConnectionForm` は `noValidate` で標準 constraint validation を無効化し、独自 validate を表示言語で出す。
- `features/icons/Icon.tsx`
  アプリ共通アイコン（gear=settings を含む）。循環参照回避のため独立モジュール化。
- `features/preview/`
  別ウィンドウのプレビュー画面。メインと同じ設定を load して同じ外観・言語を適用する。`PreviewWindow.tsx` は main 管理 session から `previewMetadata()` でヘッダ用メタ情報（name/source/path）を内容読込と分離して取得し、`loadPreview(encoding)` で本文を取得する（target/secret は受け取らない）。メタを分離しているため、decode/read 失敗中でもファイル名 / source / path は表示でき、その間も encoding select を操作して再試行できる。読み取り専用テキストは React の text node として描画する（`dangerouslySetInnerHTML` 不使用）。encoding select（Auto/UTF-8/Shift_JIS/EUC-JP）はユーザーの選択値を保持し、Auto を選んだら Auto のまま（再読込で再判定）で、検出された encoding は選択値を変えずに Auto ラベルへ補足表示する。手動変更で再読込し、request-id で古い結果の上書きを防ぐ。`previewSearch.ts` はウィンドウ内検索の純ロジック（文字列リテラル検索、case-insensitive でも index は原文対応〔UTF-16 code unit・長さ保存 folding。astral や長さが変わる文字は畳まない〕、`MAX_MATCHES` 上限、`searchText` / `buildSegments` / `next`・`prevMatchIndex` / `clampActiveIndex`）で、Chromium の `findInPage` に依存しない。Ctrl/Cmd+F で検索バーを開き（Enter=次 / Shift+Enter=前 / Esc=バーを閉じる。Esc は input 以外へ focus 移動後でも window keydown で効く）、query なしは本文を単一 text node、query ありのみ segment 化する。ヘッダの「編集」ボタンで編集モードへ切替（`view`/`edit`）。編集は `PreviewDocument.byteLength` が編集上限（1 MiB）以下のときのみ許可し、超過時は i18n メッセージを出して閲覧を継続する（編集には入らない）。編集バッファは読込済み doc の concrete encoding / BOM / 本文を seed し、encoding/BOM を Built-in Editor と同様に選べる（encoding 変更は再読込で再 decode）。encoding 変更は再読込で再 decode するが、再読込結果が編集上限超なら編集バッファへ反映せず閲覧へ戻して editTooLarge を出す。Ctrl/Cmd+S で `savePreview({ text, encoding, bom, overwriteToken? })` を呼ぶ（target/path は渡さない）。`conflict{token}` が返ったらユーザー確認のうえ main 発行の token を添えて再保存する（renderer の真偽値で任意上書きしない）。保存成功時は表示中 doc を保存内容（text/encoding/bom と main が返した byteLength）へ更新し、Cancel→view や再 Edit で旧本文を再保存して巻き戻すのを防ぐ。未保存（dirty）のままウィンドウを閉じる際は確認する（Close ボタンの自前確認 + OS のウィンドウ閉じ用に `beforeunload` で `window.confirm` を出し拒否時だけ close をキャンセル。自前確認済みの close は二重確認しない）。編集モードでは検索バー（Ctrl/Cmd+F）は開かない。
- `global.d.ts`
  preload が公開した `window.hedgeport` の型定義。

### `src/shared`

- `connections.ts`
  接続設定（SFTP / アカウント単位 S3）と接続テスト結果の契約。
- `settings.ts`
  versioned `AppSettings`（theme / fontSize / density / showHiddenFiles / confirmBeforeDelete / language）と既定・正規化（`normalizeSettings`）・`defaultLanguage` 純関数。
- `storage.ts`
  ファイル一覧の 1 エントリを表す契約。
- `transfer.ts`
  単一ファイル操作・ディレクトリ作成 / リネーム・バッチ / クリップボードの要求契約（download / upload / read-text / write-text / download-to-directory / create-directory / rename / batch / paste）と、`BatchOperationResult` / `ClipboardEntry` / `PasteRequest` / `TextDocument` / `TextEncoding` / `OpenMode`、テキスト編集の最大バイト数 `MAX_EDITABLE_TEXT_BYTES`（1 MiB）とプレビューの最大バイト数 `MAX_PREVIEW_TEXT_BYTES`（20 MiB）。

## IPC 配線

renderer から main への通信は、必ず preload を経由します。

| renderer API                                              | preload                                                                  | main                                                   | 実処理                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `openPreview(request)`                                    | `ipcRenderer.invoke('preview:open', request)`                            | `ipcMain.handle('preview:open', ...)`                  | 要求検証 → プレビューウィンドウ生成 + session 登録（描画ロード失敗は cleanup して reject）                                           |
| `previewMetadata()`                                       | `ipcRenderer.invoke('preview:metadata')`                                 | `ipcMain.handle('preview:metadata', ...)`              | 送信元束縛 session のメタ（name/path/source）を内容ロードと独立に返す                                                                |
| `loadPreview(encoding?)`                                  | `ipcRenderer.invoke('preview:load', encoding)`                           | `ipcMain.handle('preview:load', ...)`                  | 送信元に束縛された session のファイルを読む（target/secret は返さない）                                                              |
| `savePreview(request)`                                    | `ipcRenderer.invoke('preview:save', request)`                            | `ipcMain.handle('preview:save', ...)`                  | 送信元束縛 session へ保存（target/path 非送信。競合検知・上書き可否は main 側。saved{revision,byteLength} / conflict{token} を返す） |
| `loadConnections()`                                       | `ipcRenderer.invoke('connections:load')`                                 | `ipcMain.handle('connections:load', ...)`              | 接続設定を読む                                                                                                                       |
| `saveConnections(targets)`                                | `ipcRenderer.invoke('connections:save', targets)`                        | `ipcMain.handle('connections:save', ...)`              | 接続設定を保存する                                                                                                                   |
| `testConnection(target)`                                  | `ipcRenderer.invoke('connections:test', target)`                         | `ipcMain.handle('connections:test', ...)`              | 接続テスト                                                                                                                           |
| `loadSettings()`                                          | `ipcRenderer.invoke('settings:load')`                                    | `ipcMain.handle('settings:load', ...)`                 | アプリ設定を読む（無ければ既定）                                                                                                     |
| `saveSettings(settings)`                                  | `ipcRenderer.invoke('settings:save', settings)`                          | `ipcMain.handle('settings:save', ...)`                 | アプリ設定を保存（全体置換・main 再検証）                                                                                            |
| `listStorage(target, path)`                               | `ipcRenderer.invoke('storage:list', target, path)`                       | `ipcMain.handle('storage:list', ...)`                  | SFTP / S3 一覧取得（S3 のルート `/` は bucket 一覧）                                                                                 |
| `listLocal(path?)`                                        | `ipcRenderer.invoke('local:list', path)`                                 | `ipcMain.handle('local:list', ...)`                    | ローカル一覧取得                                                                                                                     |
| `downloadFile(target, remotePath, localPath)`             | `ipcRenderer.invoke('storage:download', ...)`                            | `ipcMain.handle('storage:download', ...)`              | リモート→ローカルへ単一ファイル転送                                                                                                  |
| `uploadFile(target, localPath, remotePath)`               | `ipcRenderer.invoke('storage:upload', ...)`                              | `ipcMain.handle('storage:upload', ...)`                | ローカル→リモートへ単一ファイル転送                                                                                                  |
| `readText(target, path, encoding?)`                       | `ipcRenderer.invoke('storage:read-text', target, path, encoding)`        | `ipcMain.handle('storage:read-text', ...)`             | リモートファイルをテキストで読む（auto 自動判定 / utf-8 / shift_jis / euc-jp、既定 auto）                                            |
| `writeText(target, path, text, encoding?)`                | `ipcRenderer.invoke('storage:write-text', target, path, text, encoding)` | `ipcMain.handle('storage:write-text', ...)`            | リモートファイルへ指定文字コードで保存                                                                                               |
| `deleteFile(target, path)`                                | `ipcRenderer.invoke('storage:delete', target, path)`                     | `ipcMain.handle('storage:delete', ...)`                | リモートファイル削除                                                                                                                 |
| `downloadToDirectory(target, remotePath, localDirectory)` | `ipcRenderer.invoke('storage:download-to-directory', ...)`               | `ipcMain.handle('storage:download-to-directory', ...)` | リモート→指定ローカルディレクトリへ保存（名前結合は main）                                                                           |
| `createRemoteDirectory(target, parentPath, name)`         | `ipcRenderer.invoke('storage:create-directory', ...)`                    | `ipcMain.handle('storage:create-directory', ...)`      | リモートに空ディレクトリ作成                                                                                                         |
| `renameRemote(target, sourcePath, newName, entryType)`    | `ipcRenderer.invoke('storage:rename', ...)`                              | `ipcMain.handle('storage:rename', ...)`                | リモートのファイル/ディレクトリ改名                                                                                                  |
| `createLocalDirectory(parentPath, name)`                  | `ipcRenderer.invoke('local:create-directory', ...)`                      | `ipcMain.handle('local:create-directory', ...)`        | ローカルに空ディレクトリ作成                                                                                                         |
| `renameLocal(sourcePath, newName, entryType)`             | `ipcRenderer.invoke('local:rename', ...)`                                | `ipcMain.handle('local:rename', ...)`                  | ローカルのファイル/ディレクトリ改名                                                                                                  |
| `pickDirectory()`                                         | `ipcRenderer.invoke('dialog:pick-directory')`                            | `ipcMain.handle('dialog:pick-directory', ...)`         | 保存先ディレクトリ選択ダイアログ（親ウィンドウ付き、キャンセルは null）                                                              |
| `batchDeleteRemote(target, items)`                        | `ipcRenderer.invoke('storage:batch-delete', ...)`                        | `ipcMain.handle('storage:batch-delete', ...)`          | リモート複数エントリ一括削除（file+directory）                                                                                       |
| `batchDeleteLocal(items)`                                 | `ipcRenderer.invoke('local:batch-delete', items)`                        | `ipcMain.handle('local:batch-delete', ...)`            | ローカル複数エントリ一括削除（directory は非再帰）                                                                                   |
| `batchDownload(target, remotePaths, localDirectory)`      | `ipcRenderer.invoke('storage:batch-download', ...)`                      | `ipcMain.handle('storage:batch-download', ...)`        | リモート複数ファイル一括ダウンロード                                                                                                 |
| `batchUpload(target, localPaths, remoteDirectory)`        | `ipcRenderer.invoke('storage:batch-upload', ...)`                        | `ipcMain.handle('storage:batch-upload', ...)`          | ローカル複数ファイル一括アップロード                                                                                                 |
| `paste(request)`                                          | `ipcRenderer.invoke('clipboard:paste', request)`                         | `ipcMain.handle('clipboard:paste', ...)`               | アプリ内クリップボードの貼り付け（remote/local 4 組合せ）                                                                            |
| `openLocalPath(path)`                                     | `ipcRenderer.invoke('local:open-path', path)`                            | `ipcMain.handle('local:open-path', ...)`               | ローカルを OS 既定アプリで開く（openPath 非空エラーは例外化）                                                                        |
| `revealInFolder(path)`                                    | `ipcRenderer.invoke('local:reveal', path)`                               | `ipcMain.handle('local:reveal', ...)`                  | Finder/Explorer/File Manager で表示（showItemInFolder）                                                                              |
| `readLocalText(path, encoding?)`                          | `ipcRenderer.invoke('local:read-text', path, encoding)`                  | `ipcMain.handle('local:read-text', ...)`               | ローカルテキスト読み（auto 自動判定、built-in/preview、symlink 不可）                                                                |
| `writeLocalText(path, text, encoding?, bom?)`             | `ipcRenderer.invoke('local:write-text', path, text, encoding, bom)`      | `ipcMain.handle('local:write-text', ...)`              | ローカルテキスト保存（regular file のみ）                                                                                            |
| `chooseApplication(filePath)`                             | `ipcRenderer.invoke('local:open-with', filePath)`                        | `ipcMain.handle('local:open-with', ...)`               | アプリ選択→shell:false spawn 起動（キャンセルは null）                                                                               |
| `startExternalEdit(target, remotePath, mode)`             | `ipcRenderer.invoke('external:open', ...)`                               | `ipcMain.handle('external:open', ...)`                 | リモートを temp へ download→外部アプリ起動（重複は再利用、cancel は null）                                                           |
| `uploadExternalEdit(sessionId)`                           | `ipcRenderer.invoke('external:upload', sessionId)`                       | `ipcMain.handle('external:upload', ...)`               | 外部編集を書き戻し（temp 検証＋remote conflict block）                                                                               |
| `discardExternalEdit(sessionId)`                          | `ipcRenderer.invoke('external:discard', sessionId)`                      | `ipcMain.handle('external:discard', ...)`              | 外部編集を破棄して temp 片付け（冪等）                                                                                               |
| `revealExternalEdit(sessionId)`                           | `ipcRenderer.invoke('external:reveal', sessionId)`                       | `ipcMain.handle('external:reveal', ...)`               | temp ファイルを Finder/Explorer で表示                                                                                               |
| `listExternalSessions()`                                  | `ipcRenderer.invoke('external:list')`                                    | `ipcMain.handle('external:list', ...)`                 | 外部編集セッション一覧（id/name/remotePath/dirty、temp パス非公開）                                                                  |

## 共通のストレージ操作

SFTP と S3 は実装が異なりますが、呼び出し側は同じ操作で扱えるようにしています。
その共通窓口が `StorageProvider` です。

共通操作は次の 8 つです。

- `list(path)`
- `read(path)`
- `write(path, data)`
- `delete(path)`
- `createDirectory(path)`
- `rename(sourcePath, destinationPath, entryType)`
- `deleteDirectory(path)`（SFTP は非再帰 rmdir、S3 は prefix 配下を一括削除）
- `copyFile(sourcePath, destinationPath)`（S3 は CopyObject、SFTP は get+put）

現在の実装は次の 2 つです。

- `SftpProvider`（mkdir / rename はネイティブに対応。衝突は `exists` で事前確認）
- `S3Provider`（仮想パス `/<bucket>/<key>`。`list('/')` は region 内 bucket を pagination 込みで列挙しディレクトリエントリとして返す。`list('/<bucket>...')` は当該 bucket を Delimiter='/' で 1 階層列挙。read/write/delete/createDirectory/rename/deleteDirectory/copyFile は path から bucket を導出し、ルート / bare bucket への object 操作は明示エラーで弾く（bucket への generic な Put/Delete は出さない）。bucket 作成・削除は対象外。ディレクトリは末尾スラッシュ marker。file rename/copy は CopyObject（source bucket を CopySource、dest bucket へ）で別 bucket 間も対応、file rename は copy 後に source を DeleteObject。directory rename は prefix 配下を pagination 列挙→全 copy 成功後に 1000 件 chunk で DeleteObjects。copy 失敗時は元を残す）
  - S3 directory rename の atomicity 注意: 「全 copy 完了 → 元を削除」の順で行う。copy 途中失敗時は元を残すが、削除フェーズで DeleteObjects が `Errors`（HTTP 200 でも個別失敗を返す）を含む場合は明示エラーを throw する。この時点で source / destination の双方が残り得る（完全な atomicity は保証不能）ため、エラー通知を受けて再試行 / 手動確認が必要。source が 0 件なら不在として明示エラーにする。

接続設定の `kind` を見て `createStorageProvider()` が具体実装を選びます。

## 共有インターフェース

### `ConnectionTarget`

接続先の設定を表す合併型です。

- `SftpConnectionTarget`
  `host`, `port`, `username`, `password`, `rootPath`
- `S3ConnectionTarget`（アカウント/認証情報単位。bucket / prefix は持たない）
  `region`, `accessKeyId`, `secretAccessKey`, `sessionToken`
  仮想パスは `/<bucket>/<key...>`。ルート `/` は region 内の bucket 一覧、`/<bucket>` は bucket ルート。
  legacy レコード（bucket / prefix 付き）は `connectionStore.migrateConnectionTarget` が load / save の両方で正規化して除去する（IPC 等から legacy shape が渡っても保存 JSON には bucket / prefix を残さない）。

どちらも共通で `id`, `name`, `lastLocalPath` を持ちます。

### `StorageEntry`

ファイラーの一覧表示に使う共通エントリです。

- `name`
- `path`
- `type`
- `size?`
- `modifiedAt?`

SFTP / S3 / ローカルの違いはここで吸収し、renderer は同じ形で一覧を扱います。

## 画面フロー

1. アプリ起動時に `App.tsx` が `window.hedgeport.loadConnections()` を呼ぶ。
2. 接続先を選ぶと `FilerWorkspace` が開く。
3. リモート側は `listStorage()`、ローカル側は `listLocal()` で一覧を取得する。
4. プレビュー操作は `openPreview(request)` を呼び、別ウィンドウを開く（実ファイルは main session 経由で `loadPreview` する）。

## テスト方針

現在のテストは主に次の層にあります。

- `src/main/providers/`
  path 変換、StorageProvider 契約、S3 / SFTP の個別ロジック。
- `src/main/connectionStore.test.ts`
  接続保存 / 読込。
- `src/main/fileTransfer.test.ts`
  download / downloadToDirectory / upload / read-text / write-text / delete の委譲と入力検証・テキスト安全上限・文字コード（shift_jis roundtrip / utf-8 不正 / 未対応 encoding）。
- `src/main/storageMutations.test.ts`
  remote / local の mkdir / rename。名前検証、canonical パス、同名 / 衝突拒否。
- `src/main/batchOperations.test.ts`
  remote / local の一括 delete / download / upload。振り分け・逐次処理・部分失敗・検証。
- `src/main/clipboard.test.ts`
  4 組合せの paste と `safeCopyName`、ディレクトリ拒否、衝突採番。
- `src/renderer/src/features/filer/fileActions.test.ts`
  アクション capability 算出・件数ラベル・ショートカット判定（pure module）。
- `src/main/textCodec.test.ts`
  decode/encode（BOM 保持・不正 UTF-8・SJIS roundtrip 拒否・未対応 encoding）と自動判定（UTF-8 BOM / ASCII・空 / UTF-8 JP / SJIS JP / EUC-JP JP / 曖昧で例外 / NUL バイナリ）。
- `src/main/fileOpening.test.ts`
  ローカル read/write（symlink/不在/非regular 拒否、O_NOFOLLOW 非対応フォールバックの identity 検証）・Choose Application（spawn shell:false / 引数配列 / spawn error→reject / キャンセル）。
- `src/main/externalEdit.test.ts`
  temp 隔離・重複再利用・launch 失敗 surface・upload（conflict block / symlink 拒否）・discard cleanup。
- `src/main/providers/SftpProvider.test.ts` / `S3Provider.test.ts`
  mkdir / rename の実装（S3 は root bucket 列挙 + region 絞り込み + pagination、bucket-root/deep 列挙、path ごとの bucket routing、root/bare-bucket mutation 拒否、cross-bucket rename/copy、marker / file copy→delete / directory pagination+chunk delete / copy 失敗時の元保持）。
- `src/preload/index.test.ts`
  公開 API が各 IPC channel を正しい引数で呼ぶこと。
- `src/main/connectionTesting.test.ts`
  入力検証と接続テストの主要分岐。
- `src/main/localFileListing.test.ts`
  ローカル一覧取得。
- `src/renderer/src/features/`
  接続 UI、タブモデル、選択モデル、ファイラー UI。

現状、ユニットテストは厚めですが、preload と main の「IPC のつなぎ目」自体を直接見る統合テストはまだ薄いです。

## 現状の注意点

- 接続情報は `userData/connections.json` に保存している。
- ファイル権限は `0600` にしているが、認証情報の暗号化はまだ未対応。
- 別ウィンドウのプレビュー画面は実ファイルを表示する（local/remote、既定は読み取り専用ビューア）。既定 Open または Open… > Preview が `openPreview(request)` を呼んで独立ウィンドウを開き、main は session（送信元ウィンドウ束縛）越しに `readRemoteTextWithRevision`/`readLocalTextWithRevision` を再利用して読む。認証情報・ローカル絶対パスは URL/hash/query に載せない。ウィンドウ内検索は Ctrl/Cmd+F。プレビューウィンドウ自身の「編集」ボタンでその場編集に切り替えられる（1 MiB 以下のみ。`savePreview` で local/SFTP/S3 へ保存、競合検知は main 側、Ctrl/Cmd+S 保存、未保存クローズは確認）。ファイラー内の Open… > Built-in Editor も従来どおり利用でき、保存後に一覧を再ロードする。プレビューウィンドウの diff は未実装。
- 複数選択に対応。context menu / toolbar / ショートカットは現在の選択全体に作用する。右クリックは対象が選択内なら選択を維持、選択外ならその 1 件へ置換する。Rename / Open は単一選択時のみ有効。
- 転送（download / upload）と copy はファイルのみ対象。ディレクトリの一括転送 / copy は対象外（rename / delete はディレクトリも対象）。delete の directory は SFTP / local が非再帰（非空はエラー）、S3 は prefix 配下を一括削除。
- アプリ内 Copy/Paste（Mod+C / Mod+V）は remote↔local の 4 組合せに対応。同名は上書きせず `name copy.ext` で採番。クリップボードは接続設定スナップショットを含み、タブ切替後も保持する。**大容量 / 大量ファイルは現 Provider が全量を一度に read/write する制約があり、メモリ使用に注意（ストリーミング / 進捗は将来対応）。**
- S3 接続はアカウント単位。初期ページ（仮想ルート `/`）は region 内の bucket をディレクトリとして表示し、Open / ダブルクリックで `/<bucket>` へ入る。パンくずは `/ > bucket > …`、Up で bucket ルートから bucket 一覧へ戻る。bucket 一覧ルートでは bucket への mutation / 転送 / open-with（New Folder・Paste・Upload・Rename・Delete・Copy・Download・Copy path・編集/開く）を UI 上も無効化し、ディレクトリ（bucket）の Open/移動と検索・更新・ローカル側操作だけを許す（`fileActions` の `isBucketListRoot`）。bucket 内では通常の S3 アクションが有効に戻る。
- マウス戻る/進む（Win/Linux の app-command、macOS のトラックパッド swipe）と DOM の補助マウスボタン（button 3/4）で、focus 中ペインのディレクトリ履歴を移動する。経路は main（OS イベント捕捉→preventDefault→`history:navigate` 送信、メインウィンドウのみ）→ preload（`onHistoryNavigation` で direction のみ購読・解除可）→ renderer。renderer 側では FilerWorkspace が、入力発生時点の宛先（pane / tabId）を固定したアイテムをキューへ積み、各ペインが公開する imperative handle（`PaneHandle.navigate`）経由で 1 件ずつ await しながら focus 中ペインへ適用する（drain 時に active tab でなければ破棄、対象ペイン未マウントなら no-op）。各ペインの `navigateBack`/`navigateForward` はヘッダボタンと外部要求で共有する。履歴・path・表示の更新は read 成功時にのみ確定し（commit-on-success）、失敗時は現在地・履歴・表示を保持して error だけを立てる（breadcrumb / entries / back-forward 可否が壊れず再操作可能）。履歴なし / loading 中 / 未接続 / aria-modal ダイアログ表示中 / 入力フォーカス中は no-op（error 中でも known-good な履歴へは戻れる）。IPC と DOM が同一入力を二重通知する場合は「同方向 × 別 source × 短時間」だけ dedupe し、reject した観測も記録する（直後の同 source 正規入力を落とさない）。同 source 連続は都度実行する。DOM 補助ボタンは Chromium 既定遷移を常に preventDefault し、`event.target` が入力要素ならナビゲーションせず抑止だけ行う。remote / local の履歴は独立、アクティブタブのみ対象。
- 設定はテーマ（system/light/dark）・文字サイズ（small/medium/large）・表示密度（compact/comfortable）・隠しファイル表示・削除確認・表示言語（ja/en）を提供する。色は `styles.css` の `--c-*` セマンティックトークンに集約し、`:root`（dark）と `:root[data-theme='light']` で切替（ハードコード色なし）。文字サイズは font-size を rem 化し root font-size で一括スケール、密度は `--density-scale` を主要 padding（table 行 / connection list / context menu）へ適用。
- 隠しファイル: `showHiddenFiles=false` のとき名前が `.` 始まりの entry を一覧表示から除外する（local / SFTP / S3 共通、設定変更で即反映）。選択・検索は表示中（filtered）エントリ基準で、隠れた選択は操作対象に残らない。
- 削除確認: `confirmBeforeDelete=true`（既定）のとき remote/local の一括削除と接続削除で confirm を出す。false なら省略。タブ close や encoding 再読込など削除以外の confirm には影響しない。
- バッチ結果は逐次処理で成功 / 失敗件数を status bar に集計表示する（部分失敗を許容）。
- 各ペインは「nav 行（接続名/パンくず/移動）＋検索 input + action toolbar 帯」を固定し、一覧（`.file-table-scroll`）だけがスクロールする（flex レイアウトでマジック値なし）。検索 input は可視ラベルを持たず `aria-label="Search files"`。空ディレクトリでも検索 / toolbar は表示維持。
- リモート / ローカルテキストは文字コード選択に対応（utf-8 / shift_jis / euc-jp、iconv-lite で main 一元変換）。Built-in Editor とプレビューウィンドウの初回読みは `auto` で自動判定する。Built-in Editor は検出された concrete encoding を select に表示し、保存も常に concrete で行う（`auto` では保存しない）。未編集時の encoding 変更は即再読込、編集済みは確認後。プレビューウィンドウ（閲覧モード）は Auto の選択を保持し、検出結果を Auto ラベルへ補足表示する。判定不能 / UTF-8 不正時も画面を閉じず、別 encoding を選んで再読込できる。プレビューの編集モードは Built-in Editor と同様に concrete encoding / BOM を選べ、encoding 変更は再読込で再 decode する。サイズ上限は編集（Built-in Editor / プレビュー編集）が 1 MiB（`MAX_EDITABLE_TEXT_BYTES`、保存は encode 時にも判定）、プレビュー表示が 20 MiB（`MAX_PREVIEW_TEXT_BYTES`）で、上限超過はそれぞれ専用文言のエラーにする（decode 前に判定。編集可否は読込時の `byteLength` で判断し、超過ファイルはメッセージを出して閲覧継続）。**現 Provider / fs reader はファイル全量を一度に読むため、上限判定はメモリ取得後に行う制約がある（ストリーミング読みは将来対応）。**
- ローカルは Finder/Explorer/File Manager 表示（`Show in …` = showItemInFolder、`Open Folder in …` = openPath）に対応。OS により表記を出し分ける。
- ファイルの開き方は Open（既定）/ Open…（方式選択）。toolbar は eye の split button（本体=Open / ▼=Open…）。`OpenMode` = preview / built-in / system-default / choose-app。**file の既定 Open は pane 種別（local/SFTP/S3）に依らず Preview（独立ウィンドウの読み取り専用ビューア、main session 経由・ウィンドウ内検索つき）に統一**。Built-in Editor / System Default / Choose Application は Open… から明示選択する。Built-in Editor は remote/local 双方対応（local は regular file のみ、symlink 不可）。Choose Application は `spawn(shell:false, 引数配列)` でアプリ起動（パス検証）。macOS では選択ダイアログの `defaultPath` を `/Applications` にし `.app` のみへ絞る（`.app` は OS が単一ファイル扱いのため内部実行ファイルは選ばれない）。Windows / Linux は従来どおり `defaultPath` / filter なし。workspace 右上の旧 preview eye ボタンは廃止。
- file の既定 Open（ダブルクリック / Enter / toolbar eye 本体 / context menu の Open）はすべて共通 dispatch（`onAction('open')` → 親 `handleRemoteAction`/`handleLocalAction` の open）を通って Preview を開く。directory（S3 バケット一覧含む）は同 4 経路すべてでペイン内移動。チェックボックスや行内コントロール（`input` / `button` / `.checkbox-cell`）由来のダブルクリックではファイルを開かない。
- Built-in Editor モーダルは移動・リサイズ可能（名前入力モーダルは対象外）。ヘッダのタイトル領域（`.editor-drag-handle`）を pointer events + pointer capture でドラッグ移動し、ヘッダの操作系（encoding / BOM / Close）はドラッグ起点にならない。右下ハンドル（`.editor-resize-handle`）で両方向にリサイズ。位置・サイズの純粋ジオメトリは `defaultEditorSize` / `centeredEditorPosition` / `clampEditorRect` / `resizeEditorRect`（最小 `MIN_EDITOR_WIDTH` x `MIN_EDITOR_HEIGHT`）に切り出して単体テストする。`clampEditorRect` は位置を考慮してモーダル全体を viewport 内へ収め（サイズを viewport 上限へ収めた上で左上を `[0, viewport - size]` に制限）、ドラッグ・viewport リサイズ・初期配置で共通利用する。`resizeEditorRect` は左上を固定し最大サイズを現在位置で使える領域（`viewport - position`）に制限するため、右端・下端と操作系が常に到達可能。viewport が設定 min より小さい場合は実効最小を viewport 寸法まで縮退させ overflow させない。新規ファイルを開くたびに中央・sensible サイズへ reset する。ドラッグ / リサイズの window リスナーはエディタが途中で閉じても確実に解除する。textarea は flex で本体サイズに追従（`min-height` で可用性担保）。Preview はOSネイティブの独立ウィンドウとして移動・リサイズする。
- remote の System Default / Choose Application は外部編集セッション（`externalEdit.ts`）で対応。temp へ download→外部アプリ起動し、画面下部のバナーに `Upload Changes` / `Reveal Local Copy` / `Discard` と状態（open / uploading / uploaded / error）を表示。自動 upload はせず、明示操作のみ。外部プロセス終了で破棄/アップロードはしない。同一ファイルの再オープンは既存セッションを再利用する。
- 表示ラベル類（タブ / ヘッダー / パンくず / 一覧名 / メニュー）は `user-select: none`。input / textarea / editor は選択可能のまま。
- ダウンロードは 2 系統。`Download to Local`（⌘/Ctrl+D）はローカルペインの現在ディレクトリへ即時保存し、ローカルペイン未表示時は無効化する。`Download file…`（⌘/Ctrl+Shift+D）は保存先をダイアログで選ぶ（キャンセルは no-op）。
- ディレクトリ作成 / 改名は共通の入力モーダル（Enter 実行 / Escape 取消、rename は現名称を初期値）で行い、成功後は該当ペインのみ再ロードする。空白右クリックとエントリ右クリックの両方に New Folder… を出す。
- キーボードショートカットはフォーカス中ペインの単一選択エントリにのみ作用し、入力中（input/textarea）は発火しない。OS に応じてメニューの修飾キー表記を ⌘ / Ctrl で出し分ける。
- 左右ペインは独立。RemoteFilePane の初期化は `target.id` のみに依存し、ローカル移動に伴う接続設定保存（参照更新）でリモートをルートへ戻さない。

## Future work（未実装。設計メモのみ）

- **設定画面からの接続情報インポート / エクスポート**: 専用の設定画面を新設してそこから提供する（今回は実装しない）。共有用 DTO は端末固有 / アプリ内部値（`lastLocalPath`・`id`）を除外し、インポート時は受信側で新しい `id` を採番する。
  - インポート時の重複除外: SFTP は `normalize(host を小文字化 / trim) + port + username(trim)` が一致すれば「同じサーバー・ユーザー」とみなして除外する（`rootPath` / `password` / `name` は重複判定に含めない）。
  - S3 は「同じサーバー・ユーザー」概念が無いため別ルールが必要。候補は `accessKeyId + region`（`secretAccessKey` / `sessionToken` / `name` は含めない）だが、実装時に仕様確定する。

## 今後ドキュメントを足すなら

- 接続情報保存仕様
- IPC 契約一覧の詳細
- ファイラー画面の状態遷移
- 将来のアップロード / ダウンロード設計
