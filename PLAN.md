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
  雛形後の暫定実装では `userData/connections.json` を所有者権限 `0600` で保存し、safeStorage 導入時に暗号化へ移行する。
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
  共通操作は `list()` / `read()` / `write()` / `delete()` の4つに固定し、
  `SftpProvider` / `S3Provider` を実装。将来 `DynamoDbProvider` を「もう1実装」として足すだけで済む形にする。
- SFTP/S3/AWS SDK の呼び出しは**メインプロセス側**に置き、レンダラからは IPC（`ipcMain` / `ipcRenderer` + `contextBridge`）経由で呼ぶ。認証情報をレンダラに晒さない。

### UI 方針
- ファイラー型のフォルダ/ファイル一覧を基本画面とする。
- 複数タブを開ける構成にする。
- ファイラーは複数ペインへ分割できる構成にする。
- 初期表示は単一ペインとし、必要時にローカルファイルペインを追加表示する。
- ファイル内容のプレビューは別ウィンドウで開き、将来は同じ枠組みに diff 表示を追加する。
- 起動直後は接続先選択画面を表示し、選択後にファイラー画面へ遷移する。

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

## MVP スコープ

### 今回: 雛形フェーズ
1. Electron + TypeScript + React/Vite（electron-vite）の起動可能な雛形
2. `StorageProvider` 抽象の骨組み（`list` / `read` / `write` / `delete`）
3. 接続先選択、ファイラー、複数タブ、ペイン分割、別プレビュー窓の UI レイアウト骨組み

このフェーズでは保存先への実接続、認証情報の永続化、UI と実データの配線は行わない。

### 将来スコープ
- SFTP / S3 / DynamoDB の実接続実装
- UI の実データ配線
- grep（ファイルの中身検索）
- 接続情報の export / import
- 接続情報と認証情報の安全な永続化
- 一括ダウンロード / アップロード、進捗表示、並列制御

## 検証方法（end-to-end）
- `npm run dev`（electron-vite）でアプリを起動し、独立ウィンドウが開くことを確認。
- 起動直後に接続先選択画面が表示され、選択後にファイラー、複数タブ、ペイン分割の骨組みが表示されること。
- プレビュー操作で別ウィンドウの骨組みが開くこと。
- `npm run typecheck`、`npm test`、`npm run build` が通ること。

## 次のアクション
1. 雛形フェーズを完了する
2. IPC 契約を設計し、SFTP / S3 の実装へ進む
3. 認証情報の安全な永続化と実データ配線を追加する
