# 調査失敗時の返答と readAhead の形

作成日: 2026-10-17

状態: 利用者合意済み。未実装。

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
