# HedgePort 立ち上げプラン

## Context（なぜ作るか）

SFTPサーバーやS3にアクセスして、ファイルを一括ダウンロード/アップロードできる Cyberduck 的なツールが欲しい。
独立したブラウザウィンドウ（＝デスクトップアプリ）として開きたい。将来的には DynamoDB など
他のデータストアにも接続できるよう拡張したい。

このプランは「作る作らない」の意思決定と命名までを確定したもの。実装は `~/work/hedgeport/` を
作成し、そこで claude を開き直して進める。

## 確定事項

- **アプリ名: HedgePort**（Hedgehog + Port。Port は「港＝転送先」と「接続ポート」の二重の意味）
- **dir 名 / package 名: `hedgeport`**
- **作業場所: `~/work/hedgeport/`**（新規作成し、そこで claude を開き直す）

## 実現可否（結論: できる）

| 要件 | 判定 | 手段 |
|------|------|------|
| 独立したブラウザウィンドウのデスクトップアプリ | ✅ | **Electron**（Chromiumベースの独立ウィンドウ） |
| SFTP 接続・一括 DL/UP | ✅ | `ssh2-sftp-client` |
| S3 接続・一括 DL/UP | ✅ | `@aws-sdk/client-s3` |
| 将来: DynamoDB 接続 | ✅ | `@aws-sdk/client-dynamodb`（AWS SDK系で揃う） |
| 一括転送・進捗・並列制御 | ✅ | `p-limit` で同時実行数を制御 |
| 全部 TypeScript | ✅ | Electron + TS（CLAUDE.md の「TS優先」に合致） |

### 重要な前提
- **純粋な Web アプリ（ブラウザ単体）では SFTP は不可能**。ブラウザは生TCPを張れないため。
  「独立したブラウザウィンドウ」は Electron で実現する（中身は Chromium だが Node 権限で SFTP/S3 を叩ける）。
  これは Cyberduck / ForkLift と同じ構成。
- 代替候補 Tauri（Rust + WebView、軽量）もあるが、SFTP/S3 を Rust で書く手間が増えるため、
  TS優先・素早く作るなら **Electron 推奨**。

### 設計で気をつける点（できない訳ではない＝作り込みポイント）
- **認証情報の保存**: SFTPパスワード / S3キーは Electron の `safeStorage` または `keytar`（OSキーチェーン）で安全に保持。平文保存しない。
- **大容量ファイルの転送・進捗・再開**: 最初はシンプルでよい。後から段階的に。
- **配布時のコード署名**: 自分用なら不要。社内配布する場合のみ検討。

## 推奨スタック / 初期構成

- **フレームワーク**: Electron（メインプロセス = Node、レンダラ = UI）
- **言語**: TypeScript
- **UI**: React + Vite（`electron-vite` でメイン/プリロード/レンダラを一括ビルド）
- **状態管理**: 軽量に Zustand 等（規模次第、最初は無しでも可）
- **接続系ライブラリ**:
  - SFTP: `ssh2-sftp-client`
  - S3: `@aws-sdk/client-s3`（将来 `@aws-sdk/client-dynamodb` を追加）
  - 並列制御: `p-limit`
  - 認証情報保存: Electron `safeStorage` or `keytar`
- **コードスタイル**: CLAUDE.md準拠（semi: false / singleQuote / 2スペース / trailingComma es5 / 120桁、prettier + eslint）

### アーキテクチャ方針（拡張しやすさの肝）
- **接続先を抽象化した `StorageProvider` インターフェースを切る**。
  `list()` / `download()` / `upload()` / `delete()` 等の共通メソッドを定義し、
  `SftpProvider` / `S3Provider` を実装。将来 `DynamoDbProvider` を「もう1実装」として足すだけで済む形にする。
- SFTP/S3/AWS SDK の呼び出しは**メインプロセス側**に置き、レンダラからは IPC（`ipcMain` / `ipcRenderer` + `contextBridge`）経由で呼ぶ。認証情報をレンダラに晒さない。

### 想定ディレクトリ構成（初期）
```
~/work/hedgeport/
  package.json
  electron.vite.config.ts
  src/
    main/        # Electronメインプロセス（接続・転送ロジック、IPCハンドラ）
      providers/ # StorageProvider 抽象 + SftpProvider / S3Provider
    preload/     # contextBridge で安全にAPI公開
    renderer/    # React UI（接続先一覧・ファイルブラウザ・転送キュー）
```

## MVP スコープ（最初に作るもの）
1. 接続先の登録/保存（SFTP 1件、S3 1件）＋ 認証情報の安全な保存
2. 接続してリモートのファイル/ディレクトリ一覧表示
3. ファイル選択 → ローカルへ一括ダウンロード（進捗表示・並列制御）
4. ローカル → リモートへ一括アップロード
5. （将来）DynamoDB タブを追加し、StorageProvider をもう1実装

## 検証方法（end-to-end）
- `npm run dev`（electron-vite）でアプリを起動し、独立ウィンドウが開くことを確認。
- テスト用 SFTP（社内の既存SFTP or ローカル docker の openssh-server）に接続し、一覧→DL→UP が通ること。
- S3 はテスト用バケットに対し、`@aws-sdk/client-s3` で一覧→DL→UP が通ること（認証情報は safeStorage 経由）。
- 認証情報が平文でディスクに残っていないこと（保存先を確認）。

## 次のアクション
1. `~/work/hedgeport/` を作成
2. そのディレクトリで claude を開き直す
3. このプランを元に `electron-vite` で雛形生成 → MVP スコープ順に実装
