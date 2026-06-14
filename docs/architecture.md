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
  接続設定のロード / 保存。
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
  read は `auto | TextEncoding` を受け、返す `TextDocument.encoding` は常に concrete（保存にそのまま使える）。write は concrete のみ受け付け、`auto` は拒否する。
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
  接続先の作成、編集、選択 UI。
- `features/filer/`
  ファイラー本体。タブ、選択、ソート、ローカル/リモートペインなどを持つ。
- `features/filer/fileActions.ts`
  アクション capability / menu 定義 / ショートカット判定を集約した純粋モジュール。context menu・toolbar・キーボードショートカットはすべてこの定義から駆動し齟齬を防ぐ（単体テスト済み）。
- `features/preview/`
  別ウィンドウのプレビュー画面。
- `global.d.ts`
  preload が公開した `window.hedgeport` の型定義。

### `src/shared`

- `connections.ts`
  接続設定（SFTP / アカウント単位 S3）と接続テスト結果の契約。
- `storage.ts`
  ファイル一覧の 1 エントリを表す契約。
- `transfer.ts`
  単一ファイル操作・ディレクトリ作成 / リネーム・バッチ / クリップボードの要求契約（download / upload / read-text / write-text / download-to-directory / create-directory / rename / batch / paste）と、`BatchOperationResult` / `ClipboardEntry` / `PasteRequest` / `TextDocument` / `TextEncoding` / `OpenMode`、テキスト編集の最大バイト数 `MAX_EDITABLE_TEXT_BYTES`。

## IPC 配線

renderer から main への通信は、必ず preload を経由します。

| renderer API                                              | preload                                                                  | main                                                   | 実処理                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `openPreview()`                                           | `ipcRenderer.send('preview:open')`                                       | `ipcMain.on('preview:open', ...)`                      | プレビュー用ウィンドウを開く                                               |
| `loadConnections()`                                       | `ipcRenderer.invoke('connections:load')`                                 | `ipcMain.handle('connections:load', ...)`              | 接続設定を読む                                                             |
| `saveConnections(targets)`                                | `ipcRenderer.invoke('connections:save', targets)`                        | `ipcMain.handle('connections:save', ...)`              | 接続設定を保存する                                                         |
| `testConnection(target)`                                  | `ipcRenderer.invoke('connections:test', target)`                         | `ipcMain.handle('connections:test', ...)`              | 接続テスト                                                                 |
| `listStorage(target, path)`                               | `ipcRenderer.invoke('storage:list', target, path)`                       | `ipcMain.handle('storage:list', ...)`                  | SFTP / S3 一覧取得（S3 のルート `/` は bucket 一覧）                       |
| `listLocal(path?)`                                        | `ipcRenderer.invoke('local:list', path)`                                 | `ipcMain.handle('local:list', ...)`                    | ローカル一覧取得                                                           |
| `downloadFile(target, remotePath, localPath)`             | `ipcRenderer.invoke('storage:download', ...)`                            | `ipcMain.handle('storage:download', ...)`              | リモート→ローカルへ単一ファイル転送                                        |
| `uploadFile(target, localPath, remotePath)`               | `ipcRenderer.invoke('storage:upload', ...)`                              | `ipcMain.handle('storage:upload', ...)`                | ローカル→リモートへ単一ファイル転送                                        |
| `readText(target, path, encoding?)`                       | `ipcRenderer.invoke('storage:read-text', target, path, encoding)`        | `ipcMain.handle('storage:read-text', ...)`             | リモートファイルをテキストで読む（auto 自動判定 / utf-8 / shift_jis / euc-jp、既定 auto）|
| `writeText(target, path, text, encoding?)`                | `ipcRenderer.invoke('storage:write-text', target, path, text, encoding)` | `ipcMain.handle('storage:write-text', ...)`            | リモートファイルへ指定文字コードで保存                                     |
| `deleteFile(target, path)`                                | `ipcRenderer.invoke('storage:delete', target, path)`                     | `ipcMain.handle('storage:delete', ...)`                | リモートファイル削除                                                       |
| `downloadToDirectory(target, remotePath, localDirectory)` | `ipcRenderer.invoke('storage:download-to-directory', ...)`               | `ipcMain.handle('storage:download-to-directory', ...)` | リモート→指定ローカルディレクトリへ保存（名前結合は main）                 |
| `createRemoteDirectory(target, parentPath, name)`         | `ipcRenderer.invoke('storage:create-directory', ...)`                    | `ipcMain.handle('storage:create-directory', ...)`      | リモートに空ディレクトリ作成                                               |
| `renameRemote(target, sourcePath, newName, entryType)`    | `ipcRenderer.invoke('storage:rename', ...)`                              | `ipcMain.handle('storage:rename', ...)`                | リモートのファイル/ディレクトリ改名                                        |
| `createLocalDirectory(parentPath, name)`                  | `ipcRenderer.invoke('local:create-directory', ...)`                      | `ipcMain.handle('local:create-directory', ...)`        | ローカルに空ディレクトリ作成                                               |
| `renameLocal(sourcePath, newName, entryType)`             | `ipcRenderer.invoke('local:rename', ...)`                                | `ipcMain.handle('local:rename', ...)`                  | ローカルのファイル/ディレクトリ改名                                        |
| `pickDirectory()`                                         | `ipcRenderer.invoke('dialog:pick-directory')`                            | `ipcMain.handle('dialog:pick-directory', ...)`         | 保存先ディレクトリ選択ダイアログ（親ウィンドウ付き、キャンセルは null）    |
| `batchDeleteRemote(target, items)`                        | `ipcRenderer.invoke('storage:batch-delete', ...)`                        | `ipcMain.handle('storage:batch-delete', ...)`          | リモート複数エントリ一括削除（file+directory）                             |
| `batchDeleteLocal(items)`                                 | `ipcRenderer.invoke('local:batch-delete', items)`                        | `ipcMain.handle('local:batch-delete', ...)`            | ローカル複数エントリ一括削除（directory は非再帰）                         |
| `batchDownload(target, remotePaths, localDirectory)`      | `ipcRenderer.invoke('storage:batch-download', ...)`                      | `ipcMain.handle('storage:batch-download', ...)`        | リモート複数ファイル一括ダウンロード                                       |
| `batchUpload(target, localPaths, remoteDirectory)`        | `ipcRenderer.invoke('storage:batch-upload', ...)`                        | `ipcMain.handle('storage:batch-upload', ...)`          | ローカル複数ファイル一括アップロード                                       |
| `paste(request)`                                          | `ipcRenderer.invoke('clipboard:paste', request)`                         | `ipcMain.handle('clipboard:paste', ...)`               | アプリ内クリップボードの貼り付け（remote/local 4 組合せ）                  |
| `openLocalPath(path)`                                     | `ipcRenderer.invoke('local:open-path', path)`                            | `ipcMain.handle('local:open-path', ...)`               | ローカルを OS 既定アプリで開く（openPath 非空エラーは例外化）              |
| `revealInFolder(path)`                                    | `ipcRenderer.invoke('local:reveal', path)`                               | `ipcMain.handle('local:reveal', ...)`                  | Finder/Explorer/File Manager で表示（showItemInFolder）                    |
| `readLocalText(path, encoding?)`                          | `ipcRenderer.invoke('local:read-text', path, encoding)`                  | `ipcMain.handle('local:read-text', ...)`               | ローカルテキスト読み（auto 自動判定、built-in/preview、symlink 不可）      |
| `writeLocalText(path, text, encoding?, bom?)`             | `ipcRenderer.invoke('local:write-text', path, text, encoding, bom)`      | `ipcMain.handle('local:write-text', ...)`              | ローカルテキスト保存（regular file のみ）                                  |
| `chooseApplication(filePath)`                             | `ipcRenderer.invoke('local:open-with', filePath)`                        | `ipcMain.handle('local:open-with', ...)`               | アプリ選択→shell:false spawn 起動（キャンセルは null）                     |
| `startExternalEdit(target, remotePath, mode)`             | `ipcRenderer.invoke('external:open', ...)`                               | `ipcMain.handle('external:open', ...)`                 | リモートを temp へ download→外部アプリ起動（重複は再利用、cancel は null） |
| `uploadExternalEdit(sessionId)`                           | `ipcRenderer.invoke('external:upload', sessionId)`                       | `ipcMain.handle('external:upload', ...)`               | 外部編集を書き戻し（temp 検証＋remote conflict block）                     |
| `discardExternalEdit(sessionId)`                          | `ipcRenderer.invoke('external:discard', sessionId)`                      | `ipcMain.handle('external:discard', ...)`              | 外部編集を破棄して temp 片付け（冪等）                                     |
| `revealExternalEdit(sessionId)`                           | `ipcRenderer.invoke('external:reveal', sessionId)`                       | `ipcMain.handle('external:reveal', ...)`               | temp ファイルを Finder/Explorer で表示                                     |
| `listExternalSessions()`                                  | `ipcRenderer.invoke('external:list')`                                    | `ipcMain.handle('external:list', ...)`                 | 外部編集セッション一覧（id/name/remotePath/dirty、temp パス非公開）        |

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
4. プレビュー操作は `openPreview()` を呼び、別ウィンドウを開く。

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
- 別ウィンドウのプレビュー画面は現時点ではプレースホルダのまま。テキストの閲覧 / 編集はファイラー内のモーダル（`Open`）で行い、保存後にリモート一覧を再ロードする。
- 複数選択に対応。context menu / toolbar / ショートカットは現在の選択全体に作用する。右クリックは対象が選択内なら選択を維持、選択外ならその 1 件へ置換する。Rename / Open は単一選択時のみ有効。
- 転送（download / upload）と copy はファイルのみ対象。ディレクトリの一括転送 / copy は対象外（rename / delete はディレクトリも対象）。delete の directory は SFTP / local が非再帰（非空はエラー）、S3 は prefix 配下を一括削除。
- アプリ内 Copy/Paste（Mod+C / Mod+V）は remote↔local の 4 組合せに対応。同名は上書きせず `name copy.ext` で採番。クリップボードは接続設定スナップショットを含み、タブ切替後も保持する。**大容量 / 大量ファイルは現 Provider が全量を一度に read/write する制約があり、メモリ使用に注意（ストリーミング / 進捗は将来対応）。**
- S3 接続はアカウント単位。初期ページ（仮想ルート `/`）は region 内の bucket をディレクトリとして表示し、Open / ダブルクリックで `/<bucket>` へ入る。パンくずは `/ > bucket > …`、Up で bucket ルートから bucket 一覧へ戻る。bucket 一覧ルートでは bucket への mutation / 転送 / open-with（New Folder・Paste・Upload・Rename・Delete・Copy・Download・Copy path・編集/開く）を UI 上も無効化し、ディレクトリ（bucket）の Open/移動と検索・更新・ローカル側操作だけを許す（`fileActions` の `isBucketListRoot`）。bucket 内では通常の S3 アクションが有効に戻る。
- バッチ結果は逐次処理で成功 / 失敗件数を status bar に集計表示する（部分失敗を許容）。
- 各ペインは「nav 行（接続名/パンくず/移動）＋検索 input + action toolbar 帯」を固定し、一覧（`.file-table-scroll`）だけがスクロールする（flex レイアウトでマジック値なし）。検索 input は可視ラベルを持たず `aria-label="Search files"`。空ディレクトリでも検索 / toolbar は表示維持。
- リモート / ローカルテキストは文字コード選択編集に対応（utf-8 / shift_jis / euc-jp、iconv-lite で main 一元変換）。Built-in Editor / Preview の初回読みは `auto` で自動判定し、検出された concrete encoding をエディタ header の encoding select に表示する（保存は常に concrete で行い、`auto` で保存しない）。未編集時の encoding 変更は即再読込、編集済みは確認後。判定不能 / UTF-8 不正時はモーダルを閉じず別 encoding で再読込できる。
- ローカルは Finder/Explorer/File Manager 表示（`Show in …` = showItemInFolder、`Open Folder in …` = openPath）に対応。OS により表記を出し分ける。
- ファイルの開き方は Open（既定）/ Open…（方式選択）。toolbar は eye の split button（本体=Open / ▼=Open…）。`OpenMode` = preview / built-in / system-default / choose-app。既定は remote=Built-in Editor、local=System Default。Preview は読み取り専用ビューア。Built-in Editor は remote/local 双方対応（local は regular file のみ、symlink 不可）。Choose Application は `spawn(shell:false, 引数配列)` でアプリ起動（パス検証）。macOS では選択ダイアログの `defaultPath` を `/Applications` にし `.app` のみへ絞る（`.app` は OS が単一ファイル扱いのため内部実行ファイルは選ばれない）。Windows / Linux は従来どおり `defaultPath` / filter なし。workspace 右上の旧 preview eye ボタンは廃止。
- 一覧行のダブルクリックは既定の Open を実行する。ディレクトリはペイン内移動、ファイルは Enter / eye button / context menu の Open と同じ既定アクション（remote=Built-in Editor / local=System Default）を開く。チェックボックスや行内コントロール（`input` / `button` / `.checkbox-cell`）由来のダブルクリックではファイルを開かない。
- Built-in Editor / Preview モーダルは移動・リサイズ可能（名前入力モーダルは対象外）。ヘッダのタイトル領域（`.editor-drag-handle`）を pointer events + pointer capture でドラッグ移動し、ヘッダの操作系（encoding / BOM / Close）はドラッグ起点にならない。右下ハンドル（`.editor-resize-handle`）で両方向にリサイズ。位置・サイズの純粋ジオメトリは `defaultEditorSize` / `centeredEditorPosition` / `clampEditorRect` / `resizeEditorRect`（最小 `MIN_EDITOR_WIDTH` x `MIN_EDITOR_HEIGHT`）に切り出して単体テストする。`clampEditorRect` は位置を考慮してモーダル全体を viewport 内へ収め（サイズを viewport 上限へ収めた上で左上を `[0, viewport - size]` に制限）、ドラッグ・viewport リサイズ・初期配置で共通利用する。`resizeEditorRect` は左上を固定し最大サイズを現在位置で使える領域（`viewport - position`）に制限するため、右端・下端と操作系が常に到達可能。viewport が設定 min より小さい場合は実効最小を viewport 寸法まで縮退させ overflow させない。新規ファイルを開くたびに中央・sensible サイズへ reset する。ドラッグ / リサイズの window リスナーはエディタが途中で閉じても確実に解除する。textarea は flex で本体サイズに追従（`min-height` で可用性担保）。
- remote の System Default / Choose Application は外部編集セッション（`externalEdit.ts`）で対応。temp へ download→外部アプリ起動し、画面下部のバナーに `Upload Changes` / `Reveal Local Copy` / `Discard` と状態（open / uploading / uploaded / error）を表示。自動 upload はせず、明示操作のみ。外部プロセス終了で破棄/アップロードはしない。同一ファイルの再オープンは既存セッションを再利用する。
- 表示ラベル類（タブ / ヘッダー / パンくず / 一覧名 / メニュー）は `user-select: none`。input / textarea / editor は選択可能のまま。
- ダウンロードは 2 系統。`Download to Local`（⌘/Ctrl+D）はローカルペインの現在ディレクトリへ即時保存し、ローカルペイン未表示時は無効化する。`Download file…`（⌘/Ctrl+Shift+D）は保存先をダイアログで選ぶ（キャンセルは no-op）。
- ディレクトリ作成 / 改名は共通の入力モーダル（Enter 実行 / Escape 取消、rename は現名称を初期値）で行い、成功後は該当ペインのみ再ロードする。空白右クリックとエントリ右クリックの両方に New Folder… を出す。
- キーボードショートカットはフォーカス中ペインの単一選択エントリにのみ作用し、入力中（input/textarea）は発火しない。OS に応じてメニューの修飾キー表記を ⌘ / Ctrl で出し分ける。
- 左右ペインは独立。RemoteFilePane の初期化は `target.id` のみに依存し、ローカル移動に伴う接続設定保存（参照更新）でリモートをルートへ戻さない。

## 今後ドキュメントを足すなら

- 接続情報保存仕様
- IPC 契約一覧の詳細
- ファイラー画面の状態遷移
- 将来のアップロード / ダウンロード設計
