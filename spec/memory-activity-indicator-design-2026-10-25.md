# メモリー整理の稼働表示 設計（2026-10-25）

状態: 合意済み（2026-10-25）・実装済み（fixture 検証済み、live 未確認）

## 1. 目的

バックグラウンドのメモリー担当（steward）が推論中であることと、失敗していることを、会話画面の経路表示（マイク → 音声認識 → 回答 → 音声再生）の右端に、独立したチップ「メモリー整理」で示す。失敗時は、会話エージェントのエラーと同じ「LLMに貼り付けられるエラーレポート」のModalを、チップ内の小さなアイコンボタンから開ける。

背景: 10/21〜10/25 に World 抽出が `cloud_agent_billing_error` で全件失敗していたが、画面からは分からなかった。動いているか・止まっているかを利用者が目で確かめられるようにする。

## 2. 画面の構成

| 位置 | 要素 | 変更 |
|---|---|---|
| `route-track` の 1〜4 番目 | マイク / 音声認識 / 回答 / 音声再生（矢印でつなぐ） | 変更なし |
| 右端（新規） | チップ「メモリー整理」 | 矢印を付けず、区切りの余白を置いて独立させる。点灯の見た目は既存チップの `active` と同じ |

表示例（稼働中）:

```
● マイク → ● 音声認識 → ● 回答 → ● 音声再生      ◉ メモリー整理
```

チップの `title`（ホバー時）には、動いている処理を表示する。例: `記憶の反映・世界の記録`。

| steward の slot | 表示名 |
|---|---|
| `reflect` | 記憶の反映 |
| `world` | 世界の記録 |
| `maintenance` | 記憶の整理 |
| `episode` | 会話の要約 |

## 3. 点灯の規則

| 条件 | 表示 |
|---|---|
| 表示中の会話に `steward_unit.state = 'open'` の unit があり、その `job_id` の `queue_jobs.state = 'running'` | 点灯 |
| open の unit はあるが、ジョブが `queued` / `retry_wait`（LARM に譲って待機中など） | 消灯 |
| open の unit がない | 消灯 |

- 対象は表示中の会話だけ（composer が持つ会話ID）。
- 待機中は点灯させない（待ちが長いと常に点いているように見えるため）。

## 3a. エラーの表示

### 判定

slot ごとに、表示中の会話で最後に閉じた unit（`state` が `applied`・`stale`・`failed` のもの、`closed_at` が最新）を見る。ただし `larm_preempted`（LARM を会話に譲った中断。steward が自動で再試行する）で閉じた unit は飛ばす。譲りが後に続いても、その前の失敗は隠れない。

| 最後に閉じた unit（譲りを除く） | その slot の扱い |
|---|---|
| `failed` | エラー（`code` は `steward_decision.error_code`。decision が間引かれて無ければ `unknown`） |
| `applied` または `stale` | エラーにしない（後の成功で自動的に消える） |
| 譲りだけ、または無し | エラーにしない |

10/25 の実データに当てはめた例: `curate-world` が `cloud_agent_billing_error`（attempt 0〜2）なので `world` slot はエラー。`curate-memory` の `larm_preempted` 18件はエラーにしない。

### 見た目

| 状態 | チップ |
|---|---|
| 稼働なし・エラーなし | 消灯 |
| 稼働中 | 点灯（§3） |
| エラーあり | チップの点を赤にし、ラベルの右に小さなアイコンボタン ⚠（16px 程度、枠なし、`aria-label="メモリー整理のエラーの詳細"`、`title="エラーの詳細"`）を出す |
| 稼働中かつエラーあり | 点灯のまま赤い点と ⚠ を出す（再試行中を示す） |

```
● マイク → ● 音声認識 → ● 回答 → ● 音声再生      ● メモリー整理 ⚠
```

- 会話の吹き出し（`RunFailureNotice`）は使わない。ボタンはチップ内のアイコンだけで、文字のボタンは置かない。
- Modal を開いている間に失敗が解消しても、Modal は閉じない（⚠ だけ消える）。
- ⚠ を押すと、既存の「エラーレポート」Modal（`ErrorReportDialog.tsx` の Modal、本文の `pre` と「レポートをコピー」）を開く。概要欄の見出しは「メモリー整理に失敗しています」、本文は §4 の report。

### 既存コンポーネントの共用

`ErrorReportButton` は今 `runId` から `client.runErrorReport` を呼ぶ run 専用。これを次の形に作り替え、run とメモリー整理の両方で使う（旧引数は残さない）。

| prop | 内容 |
|---|---|
| `load(signal)` | Modal を開いたときにレポート本文 `{ text }` を取る関数。run は `client.runErrorReport(runId, signal)`、メモリー整理は `client.stewardErrorReport(conversationId, signal)` |
| `heading` | 概要欄の見出し（run は「回答を取得できませんでした」） |
| `summary` | 概要の一行（任意） |
| `trigger` | `"text"`（従来の「エラーの詳細」ボタン、run 用）または `"icon"`（⚠ アイコンだけ、メモリー整理用） |
| `hidden` | 開いている Modal を残したまま、ボタンだけ隠す |

## 4. API

いずれも steward controller、読み取り専用、既存の `/api/steward/*` と同じ認証。

### `GET /api/steward/activity?conversationId=<id>`

応答例:

```json
{
  "running": true,
  "slots": ["reflect"],
  "errors": [
    { "slot": "world", "step": "curate-world", "code": "cloud_agent_billing_error", "at": "2026-10-25T04:51:33.982Z" }
  ]
}
```

| 項目 | 内容 |
|---|---|
| `running` | §3 の点灯条件を満たす unit が 1 件以上ある |
| `slots` | 点灯条件を満たす unit の slot（重複なし、`reflect`・`world`・`maintenance`・`episode` の順） |
| `errors` | §3a でエラーの slot ごとに 1 件（slot・step・error_code・closed_at） |

チップの `title` は、稼働中は `記憶の反映・世界の記録`、エラーがあれば続けて `／失敗: 世界の記録（cloud_agent_billing_error）`。

### `GET /api/steward/error-report?conversationId=<id>`

`{ "text": "..." }` を返す。§3a でエラーの slot が無ければ 404 `steward_error_report_not_found`。

本文は会話エージェントのレポート（`api/domains/dialogue/service/error-report.ts`）と同じく、ID・固定コード・ログの event 名と発生箇所だけで作り、会話本文・設定・認証情報・Provider の生応答を含めない。全体 3,000 文字以内。

```
# Eumenes エラーレポート（メモリー整理）
これはバックグラウンドのメモリー担当（steward）の失敗の診断です。会話本文・設定・認証情報は含みません。
原因の推定と、確認すべきコード・ログを示してください。

## 概要
- 会話: 3f2a91c0
- 失敗中の処理: 世界の記録（curate-world）

## 世界の記録（curate-world）
- 最終失敗: 2026-10-25 13:51:33 JST  attempt: 2  job: 87d002ad
- error_code: cloud_agent_billing_error
- 直近の失敗: 33件（本日）
- ログ:
  - 13:51:31 WARN inference inference.cloud_selected  reason: cloud_only
  - 13:51:33 WARN inference inference.attempt_failed  reason: cloud_agent_billing_error  source: cloud
    場所: api/domains/inference/adapters/cloud-agents.ts:658:13
  - 13:51:33 WARN steward steward.unit_failed  stepId: curate-world  reason: cloud_agent_billing_error

## 調べ方
- bun run logs -- --level warn --id 87d002ad-eb6a-415c-97dc-0402f930f307
- docs/logging.md
```

| 部分 | 出所 |
|---|---|
| 概要・各 slot の見出し行 | `steward_unit`（step・attempt・job_id・closed_at）と `steward_decision.error_code` |
| 直近の失敗件数 | 同じ会話・同じ step の `failed` unit の当日（JST）件数。`larm_preempted` は数えない |
| ログ | 失敗 unit の `job_id` で `readLogEntries`（`api/infrastructure/log-reader.ts`）を引き、warn 以上の component・event・reason・最初の frame だけを最大 6 行。ログが無ければ「ログなし」 |

SQL は steward domain の repository に置く。`queue_jobs` は steward の repository から読み取りだけで参照する（既存の unit と job の対応を使う）。

## 5. 更新の流れ

- unit の開閉とジョブの状態変化はいずれも DB の commit で、既存の `store.onCommit → changes.publish()` によって `/api/events` に `change` が届く。
- Web は既存の change 購読で上の API を取り直す。新しい通知経路は作らない。

## 6. 変更範囲

| 層 | ファイル | 内容 |
|---|---|---|
| steward repository | `api/domains/steward/repository/` | 稼働中 unit の slot、slot ごとの最後に閉じた unit と error_code、当日の失敗件数を読む関数 |
| steward service / contracts / controller | `api/domains/steward/{service,contracts,controller}/` | `activity(conversationId)`・`errorReport(conversationId)` と schema、route 2 本 |
| client | `client/` | `stewardActivity`・`stewardErrorReport` |
| Web | `web/src/workspace/ConversationComposer.tsx`、`web/src/workspace/ErrorReportDialog.tsx`、`web/src/workspace/RunDetails.tsx`、`web/src/app.css` | チップ（点灯・赤い点・⚠）、`ErrorReportButton` の作り替えと run 側の呼び出しの更新 |
| 試験 | `api/domains/steward/test/`、Web の該当試験 | §3 の点灯規則、§3a の判定表（`larm_preempted` を除く・後の成功で消える）、report の構成と 3,000 文字上限、チップと ⚠ から Modal を開く表示、run 側の既存試験 |

## 7. 検証

- `bun run verify -- --domain steward`、Web の該当試験。
- live: 会話後に steward が動いている間にチップが点き、終わると消えることを画面で確認する。失敗中の slot があるときに ⚠ が出て、Modal のレポートをコピーできることを確認する。
