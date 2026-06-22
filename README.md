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
- 独立ウィンドウのファイルプレビューと組み込みテキストエディター
  - ファイルの既定 Open（ダブルクリック / Enter / ツールバー / 右クリック Open）はすべてプレビューを開く（ディレクトリはペイン内移動）
  - 編集（組み込みエディター）・OS 既定アプリ・アプリ選択は「Open…」から選ぶ
  - UTF-8、Shift_JIS、EUC-JP
  - 文字コードの自動判定と手動選択
  - プレビューウィンドウ内検索（Ctrl/Cmd+F、前後移動・一致件数・大文字小文字の区別）
  - プレビューウィンドウ上部の「編集」ボタンでその場編集（Ctrl/Cmd+S で保存、local/SFTP/S3 対応）
    - 保存直前にファイルの変更を検知し、上書き前に確認（競合判定は main 側で実施）
    - 未保存のままウィンドウを閉じる際は確認
  - プレビューは最大 20 MiB、編集（プレビュー内編集・組み込みエディター）は最大 1 MiB
- OS既定アプリ、または選択した外部アプリでファイルを開く
- マウス／トラックパッドによるディレクトリ履歴の戻る・進む
- 接続情報のドラッグ＆ドロップ並び替え
- 日本語／英語表示
- システム／ライト／ダークテーマ
- 文字サイズ、表示密度、隠しファイル、削除確認の設定
- テーマに馴染むウィンドウ外観
  - macOS は統合タイトルバー（native の信号機ボタンは維持し、上端バーをテーマ背景へ統合）
  - Windows／Linux は OS 標準フレームを維持
  - ファイル一覧のチェックボックスはセル全体をクリック領域にし、テーマトークンで描画

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

- `connections.json`: 接続情報（機密でないメタデータのみ。secret は含まない）
- `connectionSecrets.json`: SFTPパスワード・AWS認証情報（`safeStorage` で暗号化した値のみ）
- `settings.json`: テーマ、表示言語などのアプリ設定

認証情報（SFTPパスワード、S3の`accessKeyId`/`secretAccessKey`/`sessionToken`）はElectronの`safeStorage`（OSの暗号化）で暗号化して`connections.json`とは別ファイルへ保存し、`connections.json`には機密でないメタデータだけを残します。復号はメインプロセス内・接続時のみで、preload/rendererへ復号値は渡しません。`safeStorage`が利用できない環境では認証情報の保存・復号・移行は明確に失敗し、平文での保存は行いません（平文フォールバックなし）。旧形式の平文`connections.json`は初回読み込み時に暗号化ストアへ自動移行します。ファイル権限は対応環境で所有者のみに制限します。

## 現在の制約

- 配布用インストーラー、コード署名、自動更新は未実装です。
- 大容量転送はストリーミング未対応で、ファイル全体をメモリへ読み込む場合があります。
- 転送進捗、キャンセル、再試行、再開は未実装です。
- 独立プレビューウィンドウは実ファイル表示・ウィンドウ内検索・その場編集（最大 1 MiB）に対応しています。差分（diff）表示は未実装です。
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
