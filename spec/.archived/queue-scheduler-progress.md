# Queue・Scheduler 実装記録

作成日: 2026-10-07 / 計画: `spec/queue-scheduler-implementation-plan.md`

## 状態

| 段階 | 状態 | 要点 |
| --- | --- | --- |
| P0 ベースライン | 完了 | 着手前 `verify --domain dialogue` / `voice-dialogue` 成功（4件 / 1件）。`initial_instructions`（Serena）実行済み、contextStill は利用不可（このセッションに該当ツールなし） |
| P1 Queue 保存契約 | 完了 | `queue_jobs` / `queue_attempts`、enqueue・dedupe・容量・claim・settle・cancel |
| P2 Queue runner | 完了 | handler registry、wake、1秒補助走査、lease/heartbeat、資源枠、retry、deadline、close(drain) |
| P3 Dialogue・Voice | 完了 | `process()` 直接起動を廃止し `dialogue.generate` Job に置換。履歴境界、同一会話順序、voice 復旧・待機 |
| P4 Scheduler | 完了 | once / interval、coalesce / skip、overlap=skip、pause/resume/cancel、`dialogue.prompt` target |
| P5 API・client | 完了 | 第10節のAPI、`client/queue.ts` `client/scheduler.ts`（`createClient` に統合） |
| P6 障害・移行・受入 | 完了（実機除く） | 子プロセス kill 復旧、旧DB移行、API結合、ブラウザ fixture を実施。実LARM・マイク確認は未実施 |

## 追加した公開契約

- migration の追加順（既存を書換えていない）: 4 `queue`、5 `scheduler`、6 `dialogue.queueLinkMigration`。7 は別作業の `voice.sequenceMigration`（`server.ts` 末尾）。
- Queue: `createQueue(store, options)`。`registerHandler` / `enqueueInTransaction` / `enqueue` / `get` / `list` / `listAttempts` / `cancelInTransaction` / `cancel` / `stats` / `wake` / `tick` / `recover` / `start` / `close(drainMs)`。handler は `prepareInTransaction` → `execute` → `settleInTransaction` ＋ `cancelInTransaction`。transaction callback は同期のみ（Promise を返すと `invalid_async_transaction_callback`）。
- Scheduler: `createScheduler(store, queue, options)`。`registerTarget` / `create` / `get` / `list` / `listOccurrences` / `pause` / `resume` / `cancel` / `tick` / `recover` / `start` / `close`。target は `materializeInTransaction(tx, occurrence)` で業務状態と Job を同一 transaction で作る。
- Dialogue: `createDialogueService(store, conversation, larm, queue)`。`promptTarget`（`dialogue.prompt`）、`waitForTerminal(runId, {signal, timeoutMs})`。Run DTO に `jobId` `deadlineAt` `sourceKind` `scheduleId` `occurrenceId` を追加。
- 依存: `scheduler → queue`、`dialogue → conversation / larm / queue / scheduler`。`scripts/domains.ts` に登録、`closure()` は循環で `domain_dependency_cycle` を投げる（グラフ引数追加で循環 fixture を試験可能）。
- エラー対応: `request_conflict` / `revision_conflict` / `schedule_state_conflict` → 409、`queue_full` / `schedule_limit_reached` / `database_writer_queue_full` → 503、`invalid_*` → 400、その他は `internal_error`（詳細はログのみ）。

## 使用例

```sh
# 起動（従来どおり）
EUMENES_API_TOKEN=... bun api/application/server.ts
```

```ts
const client = createClient("http://127.0.0.1:8787", token);
// 一回予約（offset 付き ISO 必須）
await client.createSchedule({
  requestId: crypto.randomUUID(),
  target: { kind: "dialogue.prompt", payload: { conversationId: "main", text: "今日の予定を整理して" } },
  schedule: { type: "once", at: "2026-10-08T09:00:00+09:00" },
});
// 周期予約（固定 interval、1分〜365日。毎朝ではない）
const s = await client.createSchedule({
  requestId: crypto.randomUUID(),
  target: { kind: "dialogue.prompt", payload: { conversationId: "main", text: "状況を教えて" } },
  schedule: { type: "interval", anchor: "2026-10-08T00:00:00Z", intervalMs: 3_600_000 },
});
await client.scheduleOccurrences(s.id);            // dispatched ≠ 完了。jobState を見る
const paused = await client.pauseSchedule(s.id, s.revision);
const resumed = await client.resumeSchedule(s.id, paused.revision);
await client.cancelSchedule(s.id, resumed.revision); // 将来の発火のみ停止。登録済み run は run/job の cancel で別途停止
```

## 検証結果（2026-10-07 実施）

| コマンド | 結果 |
| --- | --- |
| `bun test api` | 83 pass / 0 fail |
| `bun run verify -- --domain queue` / `scheduler` / `conversation` / `dialogue` / `voice-dialogue` | すべて成功 |
| `bun run verify:all` | 成功（browser fixture 含む。途中で一度失敗したが、同時進行していた別作業の voice/web 変更が落ち着いた後に再実行して成功。原因の直接確認はしていない） |
| `bun run verify:live -- --domain larm` | 未実施（環境変数・録音ファイルなし） |

独立レビュー（1回）で7件の指摘を受け、全件対応済み: 待機中ジョブでの10ms空転、sweep/recover の例外隔離、claim失敗時の業務側settle、予約runの scope 分離（`dialogue.schedule`）、close中claimの即abort、active のキーを attempt/generation 込みに、Scheduler の defer 中の空転、shutdown の catch。回帰試験を追加。

実際に実行した必須ケース（計画13節との対応）:

- 受付・容量・原子性: `queue.test.ts`（同一key/別内容/満杯・業務rollback）、`dialogue/queue.test.ts`（満杯で message/run を残さない）、`app.test.ts`（503）
- claim・資源枠・会話順序: 同時 tick、`resource_busy` / `conversation_order`、interactive 優先
- retry / 取消 / lease / deadline: signal 無視 handler で枠が再利用されないこと、旧 owner の遅着が不採用、deadline で expired
- 復旧: 同一プロセス内の再作成、旧DB（3 migration）→ 新DB、子プロセス SIGKILL（claim 前 / 実行中）、voice 失効 turn の run/job 取消
- 会話履歴: A 実行中の B/C で A に混入しない、B は A の採用済み回答のみ
- Scheduler: once/interval、位相維持、clock 後退・重複 tick、coalesce/skip、overlap、pause/resume/cancel とrevision競合、materialize 失敗・満杯、作成冪等、tick 上限
- API: 認証/Origin(401/403)、不正payload、未知target、重複作成(409)、ページング上限、外部 enqueue 口なし
- shutdown: `close(drain)` で強制 interrupted、遅着書込みなし（`queue.test.ts`）。SIGINT/SIGTERM の実プロセス二重受信試験は未実施（`shutdown()` は同一 Promise に合流する実装）

## 計測（fake LARM、実モデルの性能ではない）

- 受付（submit の commit まで）: 中央値 約1.1ms、最大 約1.6ms（10件）
- 100ms の推論を実行中に別会話の interactive を受付 → 完了まで約175ms（実行枠が1のため先行ジョブの終了を待つ。強制 preempt はしない）
- 背景の最古待機は `GET /api/queue/status` の `oldestWaitMs`。前景が連続する間の背景進捗は保証しない（計画どおり）

## 既知の制約・未実施

- 実LARM・マイク・スピーカー確認、SIGINT 二重受信の実プロセス試験、`verify --domain` の依存closure全体の保証なし。
- 終端 Job・occurrence・dedupe は自動削除しない（保持期間は未導入）。DB容量は `/api/queue/status` の `openJobs` では見えない（未実装）。
- 暦時刻指定（Cron/RRULE/DST）、Task Runtime、Memory/World、通知配送、協調 yield、保持期間は後続。
- 端末 sleep / backend 停止中の時刻どおりの実行は保証しない。復帰後は misfire 規則で 1 件へ集約（coalesce）または skip。
- dialogue handler は `maxAttempts=1`、`classify` は常に fail（LARM の一時障害を再試行しない）。再試行を有効にするには LARM エラーの分類が必要。
