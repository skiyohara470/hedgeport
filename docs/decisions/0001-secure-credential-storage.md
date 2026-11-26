---
type: decision
title: 認証情報の安全な保存
description: 接続情報と認証情報を分離し、Electron safeStorage で暗号化して保存する。
tags: [security, storage, credentials, electron]
status: accepted
---

# 認証情報の安全な保存

## 背景

HedgePort は SFTP、S3、ローカル作業のデータを Electron の `userData` に保存します。
以前の接続レコードは metadata と認証情報を同じデータ形式に含めていました。

この形式には、長期的に次の問題があります。

- renderer の接続状態に secret が残るおそれがある。
- 将来のインポート / エクスポートで認証情報を確実に除外しにくい。
- ログ、エラー、テストを通じて secret を含むデータが漏れやすくなる。
- 平文での代替保存を許すと、アプリ配布前に安全でない保存方法が定着する。

## 決定

機密情報を含まない接続 metadata は `connections.json` に保存します。

SFTP と S3 の認証情報は別の `connectionSecrets.json` に分け、Electron `safeStorage` で暗号化して保存します。

secret に含める項目:

- SFTP `password`
- S3 `accessKeyId`
- S3 `secretAccessKey`
- S3 `sessionToken`

`safeStorage` を必須とします。暗号化を利用できない場合、secret の保存・復号・移行は明示的に失敗させます。平文での代替保存やマスターパスワードは今回の対象外です。

復号は main process 内だけで行います。

- provider の生成時に `ConnectionTarget` と保存済み secret を main 専用の `ResolvedConnection` にまとめます。
- 接続テストでは draft または保存済みの secret を main 内で使います。
- preload と renderer には metadata だけを渡します。

既存の平文レコードは読み込み時に移行します。

1. 平文の secret 項目を検出する。
2. `connectionSecrets.json` に暗号化して保存する。
3. secret store の書き込み成功後に、secret 項目を除いた `connections.json` を書き込む。

## 影響

- 保存・読み込み後の renderer 接続状態に認証情報が含まれなくなります。
- 編集フォームの secret 欄は空で開始し、空欄のまま保存すると既存の暗号化済み secret を維持します。
- S3 接続では provider の生成前に S3 認証情報の保存が必要です。
- SFTP は公開鍵認証を使う場合、password が空でも接続できます。
- 復号後の secret JSON をデータ形式検証する必要があります。
- provider や接続テストで使う前に、接続種別と secret の形式が一致するか確認します。
- 将来のインポート / エクスポートでは、個別に項目を除くのではなく metadata のみを標準にできます。

## 検討した代替案

### `connections.json` に認証情報を平文で残す

採用しません。secret が広範囲で使われるデータに残り、将来のエクスポートも既定で安全でなくなります。

### 暗号化せず別ファイルに分ける

採用しません。データの分離にはなりますが、保存時の安全性は改善しません。

### `safeStorage` が使えない場合に平文で保存する

採用しません。アプリ配布前のため、安全でない互換経路を残すより `safeStorage` の利用を必須にします。

### マスターパスワード

見送ります。UX、復旧、鍵導出、ロック / アンロック、パスワード変更が複雑になります。Linux のキーチェーン対応が配布上の問題になった場合に再検討します。

### OS の認証情報保存機構へ直接連携する

見送ります。現在の開発段階では Electron `safeStorage` で十分で、実装も小さく保てます。
