---
type: security
title: セキュリティ境界
description: HedgePort で認証情報、ファイルシステム、IPC を扱うときの安全境界。
tags: [security, ipc, credentials]
status: active
---

# セキュリティ境界

## 基本原則

- main process を信頼境界にする。
- renderer からの入力はすべて未知値として main 側で検証する。
- secret は renderer / preload に渡さない。
- ローカル絶対パス、temp path、credential は URL、hash、query、logs に載せない。
- 失敗時に安全でない fallback を作らない。

## 認証情報

接続 metadata と secret は分離します。

- metadata: `connections.json`
- secret: `connectionSecrets.json`
- 暗号化: Electron `safeStorage`
- 復号する場所: main process のみ

SFTP password、S3 `accessKeyId` / `secretAccessKey` / `sessionToken` は secret です。
保存、復号、provider 注入、connection test は main process 内で行います。

`safeStorage.isEncryptionAvailable()` が false の場合、secret 保存・復号・migration は失敗させます。平文 fallback と master password は現スコープ外です。

## IPC 通信

preload は narrow API bridge です。renderer に `ipcRenderer` を渡しません。

IPC handler は次を守ります。

- BrowserWindow は `contextIsolation` を有効、`nodeIntegration` を無効にする。アプリ外への遷移は拒否し、外部ブラウザへ渡す場合も `http:` / `https:` / `mailto:` に限定する。
- renderer の TypeScript 型を信用しない。
- path、encoding、connection target、preview request は main で再検証する。
- preview save は `event.sender.id` に束縛された session だけを使う。
- renderer から save target/path を渡さない flow では、その設計を維持する。
- main/server 由来の raw error は secret を含まないようにする。

## ローカルファイル

ローカルファイル操作は main process で実施します。

- 読み書きではシンボリックリンクと TOCTOU を考慮する。
- 書き込み先には通常ファイルのみを許可する。
- パストラバーサル、NUL、制御文字を拒否する。
- 一時ファイルはアプリ専用ディレクトリ内で扱い、renderer にそのパスを渡さない。
- リモートディレクトリのダウンロードでは、OS の保存先選択で指定されたルートを信頼し、その配下の既存ディレクトリを `lstat` で確認してから利用する。パスを使うファイルシステム API のため、確認後に別プロセスがパスを差し替える TOCTOU race までは防げない。

## リモートストレージ

SFTP/S3 provider には接続時にだけ復号済み secret を渡します。

- provider の生成時に保存済み secret の形式と接続種別を確認する。
- S3 bucket root / virtual root に対する object の変更を拒否する。
- ディレクトリの rename/delete に完全な原子性がない場合は、UI のエラーとして利用者に伝える。

## ログとエラー

今後ログを追加する場合は、先に secret のマスキングを設計します。
ログに出してはいけないもの:

- password
- AWS の access key / secret key / session token
- 復号済み secret を含む JSON
- 一時ファイルのパス
- 利用者が明示的に選択・表示した場合を除くローカル絶対パス

## レビュー時の確認項目

- secret が renderer の状態、preload の戻り値、URL、ログに出ていないか。
- main 側に実行時の入力検証があるか。
- 移行処理の途中失敗で既存データを壊さないか。
- 代替処理が平文保存や任意パスへのアクセスになっていないか。
- テストに接続種別違い、不正なデータ形式、利用不能な保存機構のケースが含まれているか。
