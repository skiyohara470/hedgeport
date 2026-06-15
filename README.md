# HedgePort

HedgePortは、SFTP・Amazon S3・ローカルファイルを一つの画面で操作するElectron製のデスクトップファイルクライアントです。

現在は開発版です。インストーラーや署名済みアプリはまだ提供していないため、利用する場合はソースコードから起動してください。

## 主な機能

- SFTP接続
- Amazon S3接続
  - 接続後にバケット一覧を表示
  - バケットを選択してオブジェクトを操作
- リモート／ローカルの2ペイン表示
- アップロード、ダウンロード、削除、コピー
- ファイル／ディレクトリのリネームとディレクトリ作成
- 複数選択と一括操作
- タブによる複数接続の切り替え
- 組み込みテキストエディターとプレビュー
  - UTF-8、Shift_JIS、EUC-JP
  - 文字コードの自動判定と手動選択
- OS既定アプリ、または選択した外部アプリでファイルを開く
- マウス／トラックパッドによるディレクトリ履歴の戻る・進む
- 接続情報のドラッグ＆ドロップ並び替え
- 日本語／英語表示
- システム／ライト／ダークテーマ
- 文字サイズ、表示密度、隠しファイル、削除確認の設定

## 開発環境で起動

Node.jsとnpmが必要です。

```bash
git clone https://github.com/skiyohara470/hedgeport.git
cd hedgeport
npm ci
npm run dev
```

## 開発コマンド

```bash
# 開発モードで起動
npm run dev

# 型チェックとプロダクションビルド
npm run build

# 型チェックのみ
npm run typecheck

# テスト
npm test

# ビルド結果をプレビュー
npm run preview
```

ビルド結果は`out/`へ生成されます。現時点の`build`はElectron向けバンドルの生成であり、macOSの`.dmg`やWindowsのインストーラーは作成しません。

## 接続設定

### SFTP

- 表示名
- ホスト
- ポート
- ユーザー名
- 開始パス
- パスワード

### Amazon S3

- 表示名
- リージョン
- Access Key ID
- Secret Access Key
- Session Token（任意）

S3は接続設定でバケットを固定せず、接続後の最初の画面にアクセス可能なバケットを一覧表示します。

## データ保存とセキュリティ

接続情報とアプリ設定はElectronの`userData`ディレクトリへ保存されます。

- `connections.json`: 接続情報
- `settings.json`: テーマ、表示言語などのアプリ設定

ファイル権限は対応環境で所有者のみに制限しますが、現在、SFTPパスワードやAWS認証情報は暗号化されていません。共有PCや信頼できない環境での利用は避けてください。認証情報の暗号化は今後の対応予定です。

## 現在の制約

- 配布用インストーラー、コード署名、自動更新は未実装です。
- 大容量転送はストリーミング未対応で、ファイル全体をメモリへ読み込む場合があります。
- 転送進捗、キャンセル、再試行、再開は未実装です。
- 独立したプレビューウィンドウは現在プレースホルダーです。
- マウスの戻る／進むやトラックパッド操作はOS・デバイスごとの差があるため、実機確認が必要です。

## 技術構成

- Electron
- React
- TypeScript
- electron-vite / Vite
- AWS SDK for JavaScript
- ssh2-sftp-client
- Vitest / Testing Library

main、preload、renderer、sharedの責務とIPC構成は[docs/architecture.md](docs/architecture.md)を参照してください。

今後の実装予定は[PLAN.md](PLAN.md)にまとめています。
