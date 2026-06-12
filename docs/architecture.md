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
  SFTP / S3 の接続テスト、および S3 bucket 一覧取得。
- `localFileListing.ts`
  ローカルファイル一覧取得。
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
- `features/preview/`
  別ウィンドウのプレビュー画面。
- `global.d.ts`
  preload が公開した `window.hedgeport` の型定義。

### `src/shared`

- `connections.ts`
  接続設定、接続テスト結果、S3 bucket 取得入力の契約。
- `storage.ts`
  ファイル一覧の 1 エントリを表す契約。

## IPC 配線

renderer から main への通信は、必ず preload を経由します。

| renderer API | preload | main | 実処理 |
|---|---|---|---|
| `openPreview()` | `ipcRenderer.send('preview:open')` | `ipcMain.on('preview:open', ...)` | プレビュー用ウィンドウを開く |
| `loadConnections()` | `ipcRenderer.invoke('connections:load')` | `ipcMain.handle('connections:load', ...)` | 接続設定を読む |
| `saveConnections(targets)` | `ipcRenderer.invoke('connections:save', targets)` | `ipcMain.handle('connections:save', ...)` | 接続設定を保存する |
| `testConnection(target)` | `ipcRenderer.invoke('connections:test', target)` | `ipcMain.handle('connections:test', ...)` | 接続テスト |
| `listS3Buckets(request)` | `ipcRenderer.invoke('s3:buckets', request)` | `ipcMain.handle('s3:buckets', ...)` | S3 bucket 一覧取得 |
| `listStorage(target, path)` | `ipcRenderer.invoke('storage:list', target, path)` | `ipcMain.handle('storage:list', ...)` | SFTP / S3 一覧取得 |
| `listLocal(path?)` | `ipcRenderer.invoke('local:list', path)` | `ipcMain.handle('local:list', ...)` | ローカル一覧取得 |

## 共通のストレージ操作

SFTP と S3 は実装が異なりますが、呼び出し側は同じ操作で扱えるようにしています。
その共通窓口が `StorageProvider` です。

共通操作は次の 4 つです。

- `list(path)`
- `read(path)`
- `write(path, data)`
- `delete(path)`

現在の実装は次の 2 つです。

- `SftpProvider`
- `S3Provider`

接続設定の `kind` を見て `createStorageProvider()` が具体実装を選びます。

## 共有インターフェース

### `ConnectionTarget`

接続先の設定を表す合併型です。

- `SftpConnectionTarget`
  `host`, `port`, `username`, `password`, `rootPath`
- `S3ConnectionTarget`
  `region`, `bucket`, `prefix`, `accessKeyId`, `secretAccessKey`, `sessionToken`

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
- プレビュー画面は現時点ではプレースホルダで、実ファイル内容の表示にはまだつながっていない。

## 今後ドキュメントを足すなら

- 接続情報保存仕様
- IPC 契約一覧の詳細
- ファイラー画面の状態遷移
- 将来のアップロード / ダウンロード設計