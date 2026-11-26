---
type: testing
title: テスト方針
description: HedgePort の変更をどのテストで守るかの方針。
tags: [testing, quality, vitest]
status: active
---

# テスト方針

## 基本の確認手順

通常の変更では最後に次を実行します。

```bash
npm run typecheck
npm test
npm run build
```

差分の whitespace 事故を見る場合はこれも実行します。

```bash
git diff --check
```

## テストの層

- main の単体テスト: path validation、storage mutation、text codec、settings normalization、secret envelope など。
- provider テスト: SFTP / S3 固有の動作。
- preload テスト: `window.hedgeport` API が所定の IPC channel を呼ぶこと。
- renderer テスト: React component の操作手順と状態遷移。
- 契約テスト: i18n の直書き表示文字列、style contract などの回帰検知。
- renderer の統合に近いテスト: FilerWorkspace の pane / tabs / navigation 操作。

## 変更ごとの確認項目

変更の種類に応じて、最低限この観点を押さえます。

- IPC を足した: preload API、global type、main handler、main 側入力検証。
- 永続形式を変えた: schema validation、migration、失敗時の部分書き込み防止。
- secret を扱った: renderer 非露出、safeStorage 不可、復号後 shape validation、wrong-kind rejection。
- ファイル操作を変えた: path traversal、NUL/control rejection、symlink/TOCTOU、root/bucket-root rejection。
- UI flow を変えた: success、cancel、empty、error、loading/disabled state。
- i18n text を足した: translation key と i18n contract。
- theme/style を変えた: light/dark、density、font size、forced-colors fallback。

## セキュリティに関わるテスト

次の変更では、happy path だけでなく failure path を必ず追加します。

- 認証情報の保存 / 読み込み / 移行
- 外部エディタ / 一時ファイル
- ローカルファイルの読み書き
- リモートファイルの書き込み / 削除 / 名前変更
- プレビュー保存時の競合処理
- インポート / エクスポート

特に migration は「成功したら新形式になる」だけでなく、「途中失敗で旧データを壊さない」ことをテストします。

## 手動確認

自動テストで薄い領域は、PR やレビュー時に残リスクとして明記します。

- Electron のネイティブウィンドウ動作
- OS の認証情報保存機構
- ネイティブダイアログ
- 実際のネットワーク接続先
- ハイコントラスト / 強制配色
- 大容量ファイルとメモリ負荷

## 現在のテスト状況

現時点では単体テストと component tests は比較的充実していますが、main と preload の実 Electron IPC 統合テスト、配布アプリの起動確認、実 provider の E2E テストはまだ十分ではありません。
