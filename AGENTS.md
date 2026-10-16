# Eumenes 作業規則

- 作業開始時に `initial_instructions` MCP ツールを一度だけ実行する。個別タスクごとに再実行しない。
- ユーザーが明示的に依頼した場合を除き、新しい作業ブランチを作成せず、mainで作業する。
- ユーザーの明示的な許可なしに、サーバーを停止・起動・再起動しない。検証や障害調査のために必要な場合も、事前に許可を得る。
- ユーザーの明示依頼なしに、別の Codex チャットへメッセージを送らない。SAAA と `hono-standard` は参照専用とし、製品 DB・設定・秘密をコピーしない。
- domain の業務判断・SQL・試験を各 domain に置く。下位 domain は上位 domain を参照しない。複数 domain の保存は単一 writer の transaction と公開操作で行う。
- ツールチェーンの追加・改訂・移行はデータドリブン形式（bundle＋登録adapter）で行い、[登録と拡張の手順](docs/toolchain-extension.md)と[検証手順](docs/toolchain-extension-verification.md)に従う。作業順の要約は `.claude/skills/data-driven-toolchain/SKILL.md`。UIが必要な場合は、登録手順のDesignSystem・OpenUI・Artifactの追加手順も参照する。
- Web と CLI は API を使い、DB を直接開かない。LARM credential は backend 内に留め、古い結果を取消後に採用しない。
- LARM の接続先は SQLite に保存済みの設定を正本とする。接続先の環境変数を要求したり、利用者に同じ接続先を再確認したりしない。live 検証は backend の settings domain の読み取り専用操作を使い、テスト接続先は設定 API で保存する。
- 画像生成は、保存済みの LARM 接続先の catalog から capability `media.image.generate`（protocol `larm.image-generation.v1`）を持つサービスを発見して使う。profile 名・モデル名をコード・設定・手順に固定しない。サービス発見・確保応答の `services[].url` と `description` を確認し、手順は `docs/larm.md` に従う。参照画像編集は現行APIでは未対応。
- LLM・音声・画像・音楽の profile 名とモデル名は、コード（定数・分岐・既定値・エラーメッセージ）とファイル名に書かない。SQLite に保存した設定と、catalog から実行時に得た値だけを使う。
- 検証は `bun run verify -- --domain <name>` を使い、変更の影響がある利用側 domain も選んで確認する。E2E は対象 domain の試験ファイルを明示して個別に実行する。`verify:all` にブラウザE2Eは含めない。fixture、live、実機器受入の結果を分けて記録する。
- 実装済み、検証済み、計画を区別する。実機器の3往復受入を通すまで音声 MVP の完成を宣言しない。
- 障害調査では `bun run logs -- --level warn` から始め、runId・jobId・HTTPの `X-Request-Id` で JSONL を絞る。手順は `docs/logging.md`。ログに会話本文・音声・認証情報・設定・Providerの生応答を渡さない。

## Cursor Cloud specific instructions

- 環境の `start` が `bun run dev` を起動する。API は `127.0.0.1:8787`、画面は `http://127.0.0.1:5173`。両方とも loopback だけで、`127.0.0.1` 以外の host は拒否される。すでに応答しているプロセスは停止・再起動しない。
- Bun 1.4.3 は `/usr/local/bin/bun` を使う。ログインシェルは `~/.bashrc` を読まない。
- `EUMENES_API_TOKEN` が空なら `data/keys/api.token` に生成される。LARM 未登録の `base_url_unconfigured` は、設定アーティファクトで接続を保存するまでの通常状態。接続先の環境変数は要求しない。
