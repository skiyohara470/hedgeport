---
type: documentation-guide
title: ドキュメント運用ガイド
description: HedgePort の docs ディレクトリに知識を残すための運用ルール。
tags: [documentation, okf, maintenance]
status: active
---

# ドキュメント運用ガイド

`docs/` は、HedgePort の実装背景、設計判断、開発手順、検証方針を残す場所です。
README は利用者向けの入口、PLAN はロードマップ、このディレクトリは開発者と AI が共有する知識ベースとして扱います。

このディレクトリは OKF (Open Knowledge Format) を参考にした OKF-inspired な形式で管理します。厳密準拠よりも、Git diff しやすく、人間が読みやすく、AI が必要な文脈を取り出しやすいことを優先します。

## ファイルの役割

- `index.md`: 読むための入口。どの文書を開けばよいかを短く案内する。
- `README.md`: このディレクトリの書き方と運用ルール。
- `architecture.md`: 現在のシステム境界と実装構成。
- `development.md`: ローカル開発の進め方。
- `testing.md`: 変更時の検証方針。
- `security.md`: セキュリティ境界と守るべき原則。
- `storage.md`: 永続データの保存形式と migration 方針。
- `decisions/`: 長く残したい設計判断。

## Frontmatter の書き方

`index.md` を除く concept document には YAML frontmatter を付けます。

```yaml
---
type: architecture | development | testing | security | storage | decision | feature | operation
title: 短い日本語のタイトル
description: 1文の概要。
tags: [area, topic]
status: active | planned | accepted | deprecated
---
```

`type` は小文字の kebab-case にします。迷ったら既存文書に近い type を使い、無理に新しい分類を増やさないでください。

## 記録する内容

コードを読めば分かる関数説明より、コードから読み取りづらい背景を優先します。

- main / preload / renderer の境界
- IPC や永続形式の契約
- セキュリティ上の禁止事項
- migration の順序と失敗時の扱い
- UI/UX の設計意図
- テストで守るべき不変条件
- 将来の変更で巻き戻してはいけない判断

## 記録しない内容

以下は `docs/` ではなく、Issue、PR、コードコメント、テスト、または PLAN に記録します。

- 一時的な TODO
- 実装途中の作業メモ
- コードを読めば明らかな関数単位の説明
- 最新状態に追従できない細かすぎる手順
- チケットで管理すべきタスク一覧
- 検証されていない推測

## 設計判断の記録

`docs/decisions/` は「なぜその設計にしたか」を残す場所です。

Decision document は次の見出しを基本にします。

- 背景
- 決定
- 影響
- 検討した代替案

Decision は TODO ではありません。現在の設計を変えるときの判断材料になる内容だけを書きます。

## ドキュメントを更新するタイミング

次の変更を入れたら、関連する docs の更新を検討してください。

- main / preload / renderer の責務境界が変わった
- IPC の契約が増えた、または引数/戻り値が変わった
- 永続ファイルの schema や移行手順が変わった
- secret、ローカルファイル、外部アプリ起動の扱いが変わった
- 新しい feature が既存の操作フローを変えた
- 同じ説明を複数回する必要が出てきた
