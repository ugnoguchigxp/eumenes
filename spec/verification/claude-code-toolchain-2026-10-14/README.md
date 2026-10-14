# Claude Code ツールチェーンの検証記録（2026-10-14）

## fixture（固定試験・ブラウザ）

- `tests/browser/claude-code.spec.ts`（`scripts/claude-code-fixture-server.ts`）: 会話の経路は登録済みツールチェーン（会話担当の関数選択は fixture の固定応答、command 担当の出力も固定）。Claude Code の代わりに `tests/browser/fixtures/fake-claude.sh` を実 PTY で動かす。
  - 会話で依頼すると「Claude Code」画面が自動で開き、依頼文が初期プロンプトとして表示される（`conversation-started.png`）。
  - 続けての依頼は同じ枠のセッションへ入力として届く（`conversation-followup.png`。fake は行入力の echo で貼り付け記号 `^[[200~` も表示する。実際の Claude Code は raw mode のため表示しない）。
  - fake は Claude Code と同じフック（`UserPromptSubmit`→`Stop`）を送る。タスクが終わると会話に「README の手順修正が終わりました。変更をコミットしますか？」（fixture の固定応答）が出て、元になった通知文は画面に出ない（`conversation-reported.png`）。
  - 画面上の「読み上げに失敗しました」「通知を取得できませんでした」は fixture に TTS・通知の実体が無いためで、本機能とは無関係。
- `api/application/claude-code-toolchain.test.ts`: ルーティング → command 担当（SystemContext に profile・SKILL・TOOLS、snapshot にセッション一覧）→ adapter → domain、回答への projection。
- `api/application/claude-code-toolchain.test.ts` は Stop フック → `notice` の会話ターン（入力は非表示、ツールチェーン無し、通知にタスク名と最後の報告）も確認する。
- `web/src/domains/terminals/useClaudeCodeArtifacts.test.tsx`: 依頼数が増えた時だけ画面を開く。作業の完了・入力待ちで SE を鳴らし、読み込み時の状態では鳴らさない。
- 実 `claude` のフック内容は事前に確認した（`UserPromptSubmit` の `prompt`、`Stop` の `last_assistant_message` が届く。`Notification` は許可待ちが起きず未確認）。

## 実機（Claude Code 本体、LARM なし）

- domain を直接呼び、実 `claude` に初期プロンプト「13×7 の答え」→ 91、実行中セッションへの貼り付け「12×12」→ 144 を確認。

## 未実施

- 実 LARM での会話受入（会話担当が `claude_code` を選ぶか、command 担当が依頼文・タスク名をどう作るか、完了報告の文面）。自然言語受入の凍結ケースも未作成。
- 実 `claude` と実サーバーでの、フック → 報告 → SE の通し確認。
