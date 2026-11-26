---
type: development
title: 開発手順
description: HedgePort をローカルで開発するときの手順と変更時の基本ルール。
tags: [development, workflow, electron]
status: active
---

# 開発手順

## 開発環境

HedgePort は Electron + React + TypeScript のデスクトップアプリです。

- Node.js 22.12.0 以上と npm が必要です（npm は Node.js に同梱されています）。
- 依存関係は `npm ci` で入れます。
- 開発起動は `npm run dev` です。

## コマンド

```bash
npm run dev
npm run typecheck
npm test
npm run build
npm run preview
```

`npm run build` は型チェックのあとに Electron 向けのバンドルを `out/` へ生成します。配布用インストーラーはまだ作りません。

## 実装時のルール

- Electron API、ファイルシステム、認証情報、provider の実装は main process に置きます。
- renderer は React UI と表示状態を担当し、main へは preload が公開する限定 API だけを通じて依頼します。
- main / renderer をまたぐ型は `src/shared` に置きます。
- renderer へ復号済み secret、任意のローカル絶対パス、一時ファイルのパスを渡さないでください。
- renderer に表示する文字列には `features/i18n` の翻訳キーを使います。
- UI の色、密度、文字サイズには `styles.css` のテーマ token と root data attributes を使います。
- StorageProvider はファイルシステム型の接続先向けです。DB/DynamoDB のようなテーブル・レコード型は別の abstraction にします。

## 変更の進め方

1. 既存の責務境界とテストを読む。
2. 変更対象を main / preload / renderer / shared のどこに置くか決める。
3. 入力検証を main 側に置く。
4. pure logic は pure module に切り出して unit test を足す。
5. IPC を増やす場合は preload/global 型と preload test を更新する。
6. user-visible flow を変える場合は renderer tests と docs を更新する。
7. 最後に `npm run typecheck`、`npm test`、`npm run build` を通す。

## 主なファイル

- `src/main/index.ts`: BrowserWindow 作成と IPC handler 登録。
- `src/preload/index.ts`: `window.hedgeport` API。
- `src/renderer/src/App.tsx`: renderer の最上位の画面構成。
- `src/shared/connections.ts`: 接続 metadata / draft / secret の型。
- `src/shared/settings.ts`: 設定 schema と正規化処理。
- `src/main/providers/`: SFTP / S3 provider。
- `src/renderer/src/features/filer/`: ファイル管理画面。
- `src/renderer/src/features/preview/`: プレビュー画面。
- `src/renderer/src/features/i18n/`: 翻訳辞書と翻訳関数。

## 手動確認が必要な領域

次の領域は jsdom/unit test だけでは確認しきれません。

- macOS のウィンドウ操作ボタンと統合タイトルバー。
- Windows / Linux のネイティブウィンドウ枠。
- Electron `safeStorage` が使う OS のキーチェーンや認証情報保存機構。
- OS 既定アプリ、アプリ選択、Finder/Explorer での表示。
- 実際の SFTP / S3 接続。
