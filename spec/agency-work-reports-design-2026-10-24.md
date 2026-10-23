# agency の仕事の報告（TODO）設計 2026-10-24

eumenes_agency の設計（`eumenes_agency/spec/todo-design.md`）を Eumenes 側に適用する。

## 1. 決定（利用者、2026-10-24）

- 背景の仕事は、依頼を受けると TODO（`todo`）になり、完了すると `done`、報告が終わると `archived` になる。agency は `archived` を見ない。
- **完了の報告は二重にしない。** agency が有効でその会話を見ている間は、従来の即時の完了報告を出さない。
- **いつ言うかは agency が決める。** agency は `done` をなるべくこまめに確かめる。
- **何を言うかは従来の経路のまま。** 完了の通知（`agent_execution_events` → `dialogue.notifyInTransaction` → 前景の応答）を、agency が選んだ時期に流す。結果の参照が会話の文脈に残り、「再生して」などの続きの依頼や、パイプラインの引き継ぎ・完了の確認がこれまでどおり働く。
- TODO は Eumenes の artifact でも見られるようにする（仮の表示）。

## 2. 対象（第1段階）

- タスクの実行とパイプライン（`agent_executions`）の完了結果（`task_result`）。
- 途中の確認の質問（`task_question`）は、利用者の答えが要るので保留しない（従来どおり即時）。
- 会話から直接始める画像・楽曲（依頼したターンの run が完了まで続く流れ）は対象外。dialogue の作業（2026-10-23〜、別作業で進行中）が落ち着いてから、同じ形に寄せる。
- 作業タスク（`work_tasks`）とタイマーは対象外（進捗報告・時刻の通知という別の性質）。

## 3. 状態と保存

`agent-runtime` に `agent_execution_reports` を足す（migration `agent-runtime/0009-execution-reports`）。

| 列 | 内容 |
| --- | --- |
| `event_id` | `agent_execution_events` の ID（通知の requestId と同じ） |
| `execution_id`・`conversation_id` | 対象 |
| `state` | `held`（agency の判断待ち）→ `released`（通知を流した。archived） |
| `held_at`・`released_at` | 時刻 |

TODO の見え方（agency に渡す `HostTodo`）:

- 進行中の実行（queued・deciding・waiting_child・waiting_user）→ `todo`
- 終わって報告が `held` の実行 → `done`（outcome は completed→成功、partial→一部、ほか→失敗。result は結果の要約の一行）
- `released` → 渡さない（archived）

## 4. 流れ

1. 実行が終わる → 既存の配信ループが `deliverInTransaction` を呼ぶ。
2. 結果の通知で、`holdResultInTransaction(db, conversationId)` が真なら、`held` を記録して通知を出さない。イベントは `accepted` のままで、配信状態は「未配信」（通知の run がない）なので、配信ループは触らずに待つ。
   - 真になる条件: agency が ON（書き込みトランザクションの中の確定した設定）、その会話が agency の見ている会話（利用者が最後に話した会話）、その会話の agency が止まっていない。
3. agency のホストは、コミットのたびに保留を読み、見ている会話に新しい保留があれば、すぐ `result_received` の機会を開く。判断の最中なら、終わった直後に開く。
4. agency が報告を選ぶ（発話の根拠に `todo:<id>`）→ ホストは agency の発話を会話に書かず、保留を `released` にして、通知を同じ requestId で流す。前景の応答が完了報告を書く。
5. agency が待ちを選ぶ → 保留が残る間、無音の間隔（`idleSec`）ごとに確かめ直す。
6. 誰も見ていない保留は、すぐ流す（従来どおりの即時の報告になる）。agency が OFF、別の会話、その会話の agency が停止、30 分を超えて保留、のいずれか。黙って消える報告はない。流したことはログ（`agency.report_released`）に残す。
7. 流そうとした時点で会話の元（dialogue の source）がもうないとき、通知は出さず、イベントを配信済みにして配信ループの確認を止める。

## 5. 表示（仮）

会話ごとの TODO（進行中・未報告の完了・報告済み）を読み取り専用で返し、artifact として見られるようにする。実装は別節（§7）に記録する。

## 6. 残す課題

- 完了報告で次の行動（「すぐ再生しますか？」）を提案する文言は、前景の応答のシステムプロンプト（`dialogue/contexts/system-prompt/conversation.context.toml`）に足す必要がある。生成物のカタログと golden が別作業で未確定のため、その作業の後に行う。
- 会話から直接始める画像・楽曲を同じ形に寄せる（§2）。
- 再起動の直後は agency の見ている会話がないので、保留は流される（従来どおり即時に報告される）。

## 7. 実装の記録

- `api/domains/agent-runtime/service/execution-reports.ts`（保留・一覧・解除・配信済みへの確定）と migration 0009。
- `api/application/toolchain/task-execution-port.ts`: `holdResultInTransaction`、通知の送出を `sendExecutionNotice` に切り出した。
- `api/application/agency/work.ts`: agency から見た TODO と、保留の解除。
- `api/application/agency/host.ts`: `hostTodos`、機会ごとの `todos`、保留の監視と再確認、報告の判断での解除、見ていない保留の解除。
- `api/application/server-services.ts`: 配線。
- 同梱の eumenes-agency を 92c4a2b の版に更新（`HostTodo`・`reportedTodoIds`）。
