---
type: storage
title: 保存ファイルとデータ移行
description: Electron userData に保存する HedgePort の永続ファイルと migration 方針。
tags: [storage, migration, settings, credentials]
status: active
---

# 保存ファイルとデータ移行

HedgePort の永続データは Electron の `userData` ディレクトリに保存します。
アプリ bundle の中には保存しません。

## 保存ファイル

### `connections.json`

接続先の機密でない metadata を保存します。

含むもの:

- `id`
- `name`
- `lastLocalPath`
- SFTP: `host`, `port`, `username`, `rootPath`
- S3: `region`

含めないもの:

- SFTP `password`
- S3 `accessKeyId`
- S3 `secretAccessKey`
- S3 `sessionToken`
- S3 legacy `bucket` / `prefix`

### `connectionSecrets.json`

接続ごとの暗号化済み secret を保存します。

形式:

```json
{
  "version": 1,
  "secrets": {
    "<connection-id>": "<base64 safeStorage encrypted bytes>"
  }
}
```

復号後のデータ形式は main process で検証します。

- SFTP: `{ "password": "..." }`
- S3: `{ "accessKeyId": "...", "secretAccessKey": "...", "sessionToken": "..." }`

### `settings.json`

アプリの設定を保存します。

- テーマ
- 表示言語
- 文字サイズ
- 表示密度
- 隠しファイルの表示
- 削除前の確認

`shared/settings.ts` の正規化処理が未知または不正な項目を既定値へ補正します。

## 書き込み時のルール

- 保存ファイルの権限は所有者のみ (`0600`) を目指す。
- 書き込みには一時ファイルと rename を使う。
- secret store と metadata を複数ファイルに更新する場合、既存の認証情報を先に失わない順序にする。
- 不要な secret の削除は metadata の書き込み成功後に行う。
- 削除に失敗して古い暗号化済み secret が残っても、処理を致命的な失敗にはしない。

## 認証情報の移行

旧 `connections.json` に平文の secret がある場合、読み込み時に移行します。

順序:

1. 平文の secret を取り出す。
2. `safeStorage` が利用可能か確認する。
3. 暗号化済み secret store を先に書き込む。
4. 成功後に `connections.json` を metadata のみの内容へ書き換える。

途中失敗時に平文の `connections.json` を中途半端に消さないことを優先します。

## safeStorage が利用できない場合

`safeStorage` が使えない環境では、secret 保存、復号、migration を失敗させます。
平文 fallback はありません。

この方針は、配布前の段階で保存形式を安全な形に定めるための判断です。

## 今後の保存機能

- 接続設定のインポート / エクスポート
- 認証情報を除いた設定のエクスポート
- 明示的な警告を伴う認証情報込みのエクスポート
- 配布アプリの起動確認
- 転送キュー / 履歴
