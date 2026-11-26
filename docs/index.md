# HedgePort ドキュメント

このディレクトリは、HedgePort の開発者と AI が共有する知識ベースです。
まず必要な文書だけを開けるよう、用途別に入口を分けています。

## はじめに読む文書

- [ドキュメント運用ガイド](README.md) - docs の書き方と運用ルール。
- [アーキテクチャ](architecture.md) - main / preload / renderer / shared の責務、IPC、provider の境界。
- [開発手順](development.md) - ローカル開発、よく使うコマンド、変更時の進め方。
- [テスト方針](testing.md) - 変更に応じて追加するテスト。

## システムの情報

- [セキュリティ](security.md) - secret、ローカルファイル、IPC、ログで守るべき境界。
- [保存データ](storage.md) - `connections.json`、`connectionSecrets.json`、`settings.json` と移行方針。
- [ロードマップ](../PLAN.md) - 今後の実装予定と優先順位。

## 設計判断

- [設計判断一覧](decisions/index.md) - 長く残す設計判断の一覧。
- [0001 認証情報の安全な保存](decisions/0001-secure-credential-storage.md) - 認証情報を metadata から分離し、`safeStorage` を必須にした判断。

## アプリの概要

- [プロジェクト README](../README.md) - アプリ概要、起動方法、利用上の制約。
