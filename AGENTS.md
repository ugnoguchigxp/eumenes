# Eumenes 作業規則

- 作業開始時に `initial_instructions` MCP ツールを一度だけ実行する。個別タスクごとに再実行しない。
- ユーザーの明示依頼なしに、別の Codex チャットへメッセージを送らない。SAAA と `hono-standard` は参照専用とし、製品 DB・設定・秘密をコピーしない。
- domain の業務判断・SQL・試験を各 domain に置く。下位 domain は上位 domain を参照しない。複数 domain の保存は単一 writer の transaction と公開操作で行う。
- Web と CLI は API を使い、DB を直接開かない。LARM credential は backend 内に留め、古い結果を取消後に採用しない。
- LARM の接続先は SQLite に保存済みの設定を正本とする。接続先の環境変数を要求したり、利用者に同じ接続先を再確認したりしない。live 検証は backend の settings domain の読み取り専用操作を使い、テスト接続先は設定 API で保存する。
- 日常は `bun run verify -- --domain <name>`、横断変更は利用側 domain と `bun run verify:all` を実行する。fixture、live、実機器受入の結果を分けて記録する。
- 実装済み、検証済み、計画を区別する。実機器の3往復受入を通すまで音声 MVP の完成を宣言しない。
- 障害調査では `bun run logs -- --level warn` から始め、runId・jobId・HTTPの `X-Request-Id` で JSONL を絞る。手順は `docs/logging.md`。ログに会話本文・音声・認証情報・設定・Providerの生応答を渡さない。
