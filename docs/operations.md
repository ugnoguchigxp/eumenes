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
- `bun run db:backup` は API 停止中に DB のバックアップを作る（起動中は拒否される）。作り方は [logging.md](logging.md) の「DBの手動バックアップ」。
- LARM の接続先は SQLite に保存済みの設定が正本。接続先の環境変数を要求したり、同じ接続先を利用者に再確認したりしない。

## バックアップからの復元

バックアップは SQLite ファイルだけである。`data/keys/settings.key`（`EUMENES_KEY_DIR` を使っている場合はそのディレクトリ、`EUMENES_SECRET_KEY` を使っている場合はその環境変数）は含まれない。鍵がないと、暗号化して保存した認証情報は読めない（[settings.md](settings.md)）。

既定の DB は `./data/eumenes.sqlite3` で、`EUMENES_DB` があればそのパスを使う。手動バックアップは DB と同じディレクトリに `<DBファイル名>.manual-<時刻>.bak` として置かれる。同じ時刻ですでにファイルがあるときは末尾に `-1`、`-2` と付く。起動時に未適用の migration がある場合は、その直前に `<DBファイル名>.pre-migration-<時刻>.bak` を作り、新しいものを残して古いものから消し、3件だけ残す。手動バックアップは自動では消さない。

DB は WAL モードで開く。実行中の変更は `<DBパス>-wal` と `<DBパス>-shm` にあり得る。API は `<DBパス>.owner.lock` を排他で取る。ロックを取れないときは起動も `bun run db:backup` も拒否する。

1. 利用者が API を止める。
2. 今の DB と、同じパスの `-wal`・`-shm` を別名に退避する。WAL を残したまま本体だけ差し替えると、退避前の変更が復元先に載る。
3. 戻したい `.bak` を DB のパスへ複製する。
4. その DB と同じ時点の鍵（`data/keys/`、または当時の `EUMENES_KEY_DIR` / `EUMENES_SECRET_KEY`）を使う。
5. 利用者が API を起動する。
6. `bun run logs -- --level warn` で起動時の警告を確認する。

このコードが知らない migration が DB に記録されていると、起動は `migration_unknown_applied` で拒否する。新しい版の DB を古いコードで開いた場合がそれにあたる。拒否は migration を適用する前に起きる。

手順は未実行（文書のみ）。

## 受入の状態管理

- 音声 MVP は実機器の3往復受入を通すまで完成を宣言しない（[acceptance.md](acceptance.md)）。
- README の実装表と受入表は、検証のたびに対象コミットと日付を合わせて更新する。
