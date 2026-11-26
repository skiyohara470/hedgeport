# 設計判断

このディレクトリは、HedgePort の長く残す設計判断を記録します。
現在の構造だけでなく、なぜその構造にしたのかを残すための場所です。

## 採用済み

- [0001 認証情報の安全な保存](0001-secure-credential-storage.md) - 接続 metadata と secret を分離し、Electron `safeStorage` を必須にする。

## 設計判断を記録する場合

次のような変更は decision として残します。

- セキュリティ境界を決めた
- 永続形式や migration 方針を決めた
- IPC contract の方向性を決めた
- 代替案を捨てる判断をした
- 将来の実装で巻き戻すと危ない前提を置いた
