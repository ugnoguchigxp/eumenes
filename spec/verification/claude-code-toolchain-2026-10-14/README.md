# Claude Code ツールチェーンの検証記録（2026-10-14）

## fixture（固定試験・ブラウザ）

- `tests/browser/claude-code.spec.ts`（`scripts/claude-code-fixture-server.ts`）: 会話の経路は登録済みツールチェーン（会話担当の関数選択は fixture の固定応答、command 担当の出力も固定）。Claude Code の代わりに `tests/browser/fixtures/fake-claude.sh` を実 PTY で動かす。
  - 会話で依頼すると「Claude Code」画面が自動で開き、依頼文が初期プロンプトとして表示される（`conversation-started.png`）。
  - 続けての依頼は同じ枠のセッションへ入力として届く（`conversation-followup.png`。fake は行入力の echo で貼り付け記号 `^[[200~` も表示する。実際の Claude Code は raw mode のため表示しない）。
  - 画面上の「読み上げに失敗しました」「通知を取得できませんでした」は fixture に TTS・通知の実体が無いためで、本機能とは無関係。
- `api/application/claude-code-toolchain.test.ts`: ルーティング → command 担当（SystemContext に profile・SKILL・TOOLS、snapshot にセッション一覧）→ adapter → domain、回答への projection。
- `web/src/domains/terminals/useClaudeCodeArtifacts.test.tsx`: 依頼数が増えた時だけ画面を開く。

## 実機（Claude Code 本体、LARM なし）

- domain を直接呼び、実 `claude` に初期プロンプト「13×7 の答え」→ 91、実行中セッションへの貼り付け「12×12」→ 144 を確認。

## 未実施

- 実 LARM での会話受入（会話担当が `claude_code` を選ぶか、command 担当が依頼文をどう作るか）。自然言語受入の凍結ケースも未作成。
