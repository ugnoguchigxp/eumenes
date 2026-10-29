# Ruri のユーザー意図判定を会話の前に組み込む 設計（2026-10-29）

状態: 利用者の指示（2026-10-29、LARM へ配備済みの意図判定の組込み）に沿って書き直した。実装中。

## 1 決めたこと

- 利用者の発言が確定した後、LLM へ渡す前に、LARM の Ruri 意図判定（5分類）を呼ぶ。
- 従来の表情・声色判定（エージェント自身の回答チャンクを判定）とは、呼出し口・結果の型・設定・接続（credential）を分ける。互いの結果を他方の判断に使わない。
- 利用モードは `legacy`（今のまま）、`shadow`（今のまま動かしつつ Ruri も呼んで記録する）、`ruri`（Ruri の結果をルーティングに使う）。初期値は `ruri`（2026-10-29 利用者指示「いきなり分類器に判断させる」で `shadow` から変更）。
- Ruri の生の分類と、Eumenes が選んだルーティングを別々に記録する。分類ラベルをそのまま実行命令にしない。
- Ruri の失敗（時間切れ・接続失効・API エラー・不正な応答）では、今のルーティングで続ける。会話を止めない。
- 対象は local ハーネス（LARM）の、利用者の発言で始まる手。cloud ハーネスと、ホストの知らせで始まる手は判定しない。

配備済みの判定器は旧5分類で、「Tool 探索が必要か」の二値モデルではない。Tool 探索の要否の精度（90%）は確認されていない。利用者は、分類を Tool あり・なしの二値に絞って精度を上げる計画（2026-10-29）。二値モデルへの再学習は、この接続の実装と分けて扱う。そのため `ruri` の方策は「Tool 探索を強制するか」の1つの判断だけにし、二値モデルに替わったときは、そのスコアを `request` のスコアの代わりに使えば済む形にする。

## 2 表情判定と意図判定の分離

| | 表情・声色判定（既存、変えない） | ユーザー意図判定（今回） |
| --- | --- | --- |
| 入力 | エージェントの今の回答チャンク（`state.current_chunk`） | 最新の利用者の発言と、その直前のエージェントの発言（`state.text`・`state.previous_agent`） |
| 時点 | 回答の生成中・生成後 | 発言の確定後、LLM の前 |
| LARM の profile | 会話の保存済み profile（`larm.profile`） | 意図判定の保存済み profile（`intent.profile`） |
| 接続 | 会話の接続（llm・asr・tts・system-one） | 意図判定だけの接続（`providers: ["system-one"]`） |
| model | 会話の接続の claim が返す model | 意図判定の接続の claim が返す model |
| 呼出し口 | `LarmPort.judge` | `LarmPort.judgeIntent` |
| 結果の使い道 | 声の表情（delivery） | ルーティング（Tool 探索を強制するか）と記録 |

意図判定の口（`decisionOnly` の LARM の口）は `judge` を断り、会話の口は `judgeIntent` を断る。そのため credential が混ざらない。profile 名と model 名はコードに書かない。profile 名は設定に保存し、model は catalog と claim から取る。

2026-10-29 に意図判定の profile の catalog を読んで確かめた形は、provider `system-one`、capability `decision.system-one`、protocol `larm.system-one.v1`、endpoint `/v1/systemone` で、model は短い名前。表情判定と同じ provider の形なので、既存の判定器の provider の扱い（claim・renew・release）をそのまま使う。

## 3 接続

既存の lease manager を、要求する provider の組（`primary`）を持てるように広げる。会話の口は今と同じ `["llm"]`、意図判定の口は `["system-one"]`。

| 段 | 意図判定の口 |
| --- | --- |
| Discovery | `GET /v3/agent-profiles?profile=<intent.profile>` |
| 接続の作成 | `POST /v1/agent-connections`、`profile`・`client`・`audience`（保存済みの LARM 設定の `audience`。通常 `saaa-desktop`、同じホストでの検証は `same-host`）・`providers: ["system-one"]` |
| ready の後 | `system-one` を claim し、その `endpoint` と `credential.token` を使う |
| 利用中 | 既存の renew（期限の 180 秒前）、失効・idle 解放の後の再接続 |
| 終了 | 推論 domain を閉じるとき、または設定が変わったときに release する |

接続は口を開いている間保つ（`keepAlive`）。1発言ごとに接続を作らないため。

## 4 判定の API

```json
{
  "model": "<claim の model>",
  "state": { "previous_agent": "何をお手伝いしましょうか？", "text": "明日の天気を調べてください" },
  "questions": {
    "intent": {
      "type": "choice",
      "instructions": "最新のユーザー発言の意図を分類してください",
      "criteria": { "request": "依頼", "chat": "会話", "followup": "作業への返答", "noise": "雑音", "incomplete": "発話途中" }
    }
  }
}
```

- `previous_agent` は、その発言より前の、最後のエージェントの発言。なければ送らない。今作ろうとしている返事や、会話履歴全体は送らない。
- 応答から、`answers.intent.choice`、`answers.intent.probabilities`（5ラベルの数値）、`truncated`、`history_tokens_dropped`、`state_tokens_dropped`、`routing.head_revision` を読む。ラベルが5つのどれでもない、または確率が 0〜1 の数値でない場合は不正な応答として扱う。
- 応答の `model` は記録に使い、claim の model と違っても不正としない。LARM は同じ用途の短い名前と長い互換名を受け付け、応答に長い名前を返しうるため。用途をまたいだ利用は LARM 自身が `400 model_mismatch` で断る。
- 送る `text` は先頭 2,000 字、`previous_agent` は末尾 1,000 字まで。

## 5 モードとルーティング

設定（SQLite の設定文書の `intent`、表情判定の設定とは別）:

| 項目 | 初期値 | 意味 |
| --- | --- | --- |
| `mode` | `ruri` | `legacy`・`shadow`・`ruri` |
| `profile` | なし | 意図判定の LARM Agent Profile。保存されるまでは判定も記録もしない。保存されている間は、最初の発言を待たずに接続を作っておく |
| `timeoutMs` | 1500 | `ruri` で判定を待つ上限。超えたら今のルーティングで続ける |
| `searchScore` | 0.6 | `ruri` で、`request` のスコアがこれ以上なら Tool 探索を強制する |

スコアは正解の確率としては扱わず、閾値との比較にだけ使う。

| | `legacy` | `shadow` | `ruri` |
| --- | --- | --- | --- |
| Ruri を呼ぶ | 呼ばない | 呼ぶ（待たない。LLM の呼出しと並べて走らせる） | 呼ぶ（`timeoutMs` まで待つ） |
| ルーティング | 今のまま（LLM が判断） | 今のまま | 下の方策 |

`ruri` の方策（2026-10-29 利用者指示で、`chat`・`noise`・`incomplete` はツールを使わせない形に変更）:

| Ruri の結果 | ルーティング |
| --- | --- |
| `request` で、スコアが `searchScore` 以上 | Tool 探索を強制する。その手の1回目の呼出しだけを `toolChoice: "required"` にし、`find_toolchain` より前の別のツールの呼出しは `search_first` で断る（2回目以降の呼出しは文で答えてもよい）。探した後に頼むか断るかは LLM が判断する |
| `request` で、スコアが閾値未満 | 今のまま |
| `followup` | 今のまま。ツールは使える（進行中の仕事・確認待ちへの返事や取消・訂正は、LLM が `work`・`delegate` の approve で扱う） |
| `chat`・`noise`・`incomplete` | ツールを使わせない（`answer`）。その手のすべての呼出しをツール定義つき（キャッシュの先頭を保つ）・`toolChoice: "none"` で行い、それでも届いたツールの呼出しは `tools_not_needed` で断る。返事を書くかどうかは LLM が判断する（発言は捨てず、待ちもしない） |
| 判定なし（失敗・時間切れ・profile なし） | 今のまま。理由を記録する |

古い結果: 判定はその手（run）と発言 ID に結び付き、その手の中でだけ使う。新しい発言や取消でその手が取り消されると、判定の待ちも中断される。後から届いた古い結果は、記録されるだけで、どの手のルーティングも変えない。

## 6 記録

dialogue の表 `dialogue_intent_judgments`（1発言の判定につき1行。本文と秘密は持たない）と、ログ `dialogue.intent_judged`。

| 列 | 中身 |
| --- | --- |
| `message_id`・`run_id`・`conversation_id` | どの発言のどの手か |
| `mode` | その手の利用モード |
| `model`・`head_revision` | 判定した model と routing の head revision |
| `choice`・`probabilities_json` | Ruri の生の分類と全ラベルのスコア |
| `truncated`・`history_tokens_dropped`・`state_tokens_dropped` | 入力の切り詰め |
| `legacy_route` | 今のルーティングならどうしたか（常に `free`） |
| `final_route` | Eumenes が選んだもの（`free`・`search`・`answer`）。`answer` を記録できるよう、マイグレーション `dialogue/0028-intent-answer-route` で表を作り直す（列と値はそのまま） |
| `duration_ms` | 判定にかかった時間 |
| `fallback_reason` | 判定を使えなかった理由（`timeout`・`cancelled`・`larm_*` など） |
| `observed_search`・`observed_delegate` | その手で LLM が実際に `find_toolchain`・`delegate` を呼んだか（`shadow` の比較用） |

## 7 設定の仕方

- API: `GET /api/settings/intent`、`PUT /api/settings/intent`（上の項目。部分で送ってよい）。
- CLI: `bun run cli -- intent status`、`bun run cli -- intent set --mode shadow --profile <profile>`。

## 8 確認

| 確認 | 方法 |
| --- | --- |
| 表情・声色判定が変わらない | larm・delivery・inference の既存の試験 |
| 意図判定が LLM の前に走る | dialogue の試験（`ruri` で、判定の後に1回目の呼出し） |
| モードの切替が表情判定と独立 | 設定の試験（`intent` を変えても `larm` は変わらない）、larm の試験（口ごとの判定の断り） |
| `shadow` はルーティングを変えない | dialogue の試験（`request` でも1回目の呼出しは今と同じ） |
| 入力・結果・credential が混ざらない | larm の試験（`judge` と `judgeIntent` が別の接続の token と body を使う） |
| API エラー時に今の経路へ戻る | dialogue の試験（422・時間切れ・不正な応答） |
| 発言の更新・取消の後に古い判定が効かない | dialogue の試験（取り消された手の判定が後の手に使われない） |
| renew・再 claim・release | larm の試験（意図判定の口の接続） |
| 追加の待ち時間 | `ruri` は判定の所要時間がそのまま加わる。`shadow` は加わらない。記録の `duration_ms` で測る |

live の確認（実際の LARM で判定を呼ぶ）は、利用者の合図の後に行う。`ruri` の強制には LARM が `tool_choice: "required"` を受け付けることが要る（未確認）。
