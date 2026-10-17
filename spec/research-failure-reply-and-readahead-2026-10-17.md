# 調査失敗時の返答と readAhead の形

作成日: 2026-10-17

状態: 利用者合意済み。2026-10-17、fixture の範囲は実装済み（§5）。§4 の実機受入は未記録。`web-guided.bundle.json` と shared-execution の古い SKILL 本文は `readAhead:[{url},…]` のまま。

関連: [会話の初動2ラウンド化](conversation-two-round-initial-analysis-design-2026-10-17.md)、[委譲前の一時回答 §9](conversation-pre-delegation-response-design-2026-10-17.md)。

## 1. 実機で確認した事実

2026-10-17 12:18、会話 `main` の「明日の鎌倉の天気を教えて」（run `bc992888-fbeb-42e1-a6f7-1d41e99cb168`）。R1・候補検索・選定・一時回答「明日の鎌倉の天気予報を調べます」までは成功した。その後、次の2つで返答が届かなかった。

1. Web検索のサブエージェント（task `be29f86c-d931-4712-be8f-8b1fa5da5dd6`）が、検索結果を受けた2ステップ目の `invoke` で `control_schema_invalid`（配列の要素にobjectが必要な位置にstring）を2回続け、`invalid_control_json` で失敗した。`invoke` でobjectの配列を受けるのは `readAhead`（`agent-runtime/service/guided-contract.ts`）だけで、SKILLは `readAhead:[{url},…]` と指示している。モデルがURL文字列の配列を書いたと推定する（ログは本文を残さない）。同じ失敗は10/14以降に十数回ある。
2. 失敗を伝える会話エージェントの返答が `spoken_reply_too_long` を2回続け、`invalid_conversation_operation` で run が失敗した。失敗用の指示（`research-result-context/failure-rules`）と修復指示（`correction-4`）は短い一文・160字を求めていた。

## 2. 方針（利用者合意）

- **readAhead:** 形を `[{url}]` からURL文字列の配列 `["https://…", …]` に変える。objectの包みは情報を持たず、モデルが自然に書く形に契約を合わせる。上限（5件）・URL検証は維持する。
- **調査が失敗したとき:** 会話エージェントに失敗の説明文を生成させず、返答を「失敗しました。」とする。LLM呼び出しは行わない。失敗コードは既存どおりrunに記録し、画面で確認できる。
- **調査が成功したとき:** サブエージェントの報告は長くてよい。会話エージェントが既存の発話契約（160字・二文）で縮めて答える。readAhead修正後に実機で確認し、縮まらなければ出力を取り出して原因を調べる。
- run そのものが失敗したとき（R1・R2の連続違反など）の読み上げは今回の対象外。

## 3. 変更範囲

| 対象 | 変更 |
| --- | --- |
| `agent-runtime/service/guided-contract.ts`・`step-actions.ts` | `readAhead` を `z.array(z.string().url().max(2048)).max(5)` とし、利用側を合わせる |
| `capabilities/bundles/web-shared-execution.bundle.json`・`web-guided.bundle.json` のSKILL本文 | `readAhead:[{url},…]` の記述を文字列配列に。登録済みrevisionは変えず、手順書どおり新しいrevisionで改訂 |
| `dialogue/service/research-result-context.ts` ほか調査失敗の回答経路 | 失敗時はLLMを呼ばず「失敗しました。」を回答として採用。不要になった `failure-rules` 等は削除 |

## 4. 受入

- fixture: readAheadの文字列配列が受理され、旧objectは拒否される。調査失敗時にLLM呼び出しなしで「失敗しました。」が返り、失敗コードがrunに残る。
- 実機: 「明日の鎌倉の天気を教えて」で、予告→調査→160字以内の根拠付き回答。サブエージェント失敗時は「失敗しました。」が読み上げられる。

## 5. 実施記録（2026-10-17）

fixture は次のとおり。実機は未実施。

- `readAhead` の契約は `api/domains/agent-runtime/service/guided-contract.ts` で URL 文字列の配列（最大5件）。旧 object は拒否する。利用側は `step-actions.ts`。試験は `guided-contract.test.ts`。
- 失敗時の返答は `api/domains/dialogue/service/research-failure-reply.ts` の「失敗しました。」。`generation-handler.ts` は失敗コードがあるとき LLM を呼ばない。失敗コードは run に残る。試験は `research-hold.test.ts`、`generation-prepare.test.ts`、`guided-answer.test.ts`。`failure-rules` の context は削除済み。
- `web-shared-execution.bundle.json` の新しい SKILL 本文は文字列配列を指示する。同じ bundle の古い本文と `web-guided.bundle.json` は `readAhead:[{url},…]` のまま。ここは本書の変更範囲として残る。
- 音声経路: LLM を呼ばずに確定した回答でも音声配信できるよう、`InferencePort.acceptHostAnswerInTransaction`（`api/domains/inference/service/request-status.ts`）を追加。`generation-handler.ts` の settle で調査失敗時に1回呼ぶ。受理できなければ `permission_revoked` で run を失敗させる。試験は `api/domains/inference/test/inference.test.ts`、`api/application/toolchain/agent-voice-response.test.ts`。
- 固定返答の対象は調査そのものの失敗だけで、action の失敗（kanban の `revision_conflict` など）は従来どおり会話エージェントが結果を伝える。
- readAhead の新 revision は `skill:web.guided@4`、`package:web.recipe@5`・`web.search@5`・`web.quick@6`、`toolchain:web.search@6`・`web.research.codex@3`（`web-shared-execution.bundle.json`）。製品DB登録済み（2026-10-17 再起動）。登録後の live で天気の調査が成功（run `180ade55-9423-40fa-ba74-cb1c4e735136`）。
- 実機で未確認: 調査失敗時の「失敗しました。」の読み上げ。2026-10-18 以降に確認する（[会話の初動 §9](conversation-two-round-initial-analysis-design-2026-10-17.md)）。
