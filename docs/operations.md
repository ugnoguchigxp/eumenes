# 運用と継続性

第三者が保守を引き継げるよう、日常の保守・障害対応・保全の手順をまとめる。製品の仕様や判断方式は変えない。

## 保守の基本

- 変更前に対象 domain を決め、変更後は影響する利用側 domain も含めて `bun run verify -- --domain <name>` をローカルで実行する。fixture、live、実機器の結果は分けて記録する（[verification.md](verification.md)）。
- domain の業務判断・SQL・試験は各 domain に置く。下位 domain は上位 domain を参照しない。複数 domain の保存は単一 writer の transaction と公開操作で行う（[domains.md](domains.md)）。
- ツールチェーンの追加・改訂は bundle＋登録 adapter のデータドリブン形式で行う（[toolchain-extension.md](toolchain-extension.md)、[toolchain-extension-verification.md](toolchain-extension-verification.md)）。
- LLM・音声・画像・音楽の profile 名とモデル名はコードに書かない。SQLite に保存した設定と catalog から実行時に得た値だけを使う。

## 障害調査

1. `bun run logs -- --level warn` から始める。
2. runId・jobId・HTTP の `X-Request-Id` で JSONL を絞る（[logging.md](logging.md)）。
3. ログに会話本文・音声・認証情報・設定・Provider の生応答を渡さない。
4. 性能の切り分けは [performance.md](performance.md) の測定手順を使う。

サーバーの停止・起動・再起動は、利用者の明示的な許可を得てから行う。

## 保全

- 既定 DB は `data/eumenes.sqlite3`（`EUMENES_DB` で変更）。DB と `data/keys/` 内の鍵は一緒に保全する。
- `bun run db:backup` は API 停止中に DB のバックアップを作る（起動中は拒否される）。
- LARM の接続先は SQLite に保存済みの設定が正本。接続先の環境変数を要求したり、同じ接続先を利用者に再確認したりしない。

## 受入の状態管理

- 音声 MVP は実機器の3往復受入を通すまで完成を宣言しない（[acceptance.md](acceptance.md)）。
- README の実装表と受入表は、検証のたびに対象コミットと日付を合わせて更新する。
