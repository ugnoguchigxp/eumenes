# LARM に担当の振り分け（Router）の判断を置く依頼 Prompt（2026-11-01）

以下を LARM 担当者または LARM 側の実装エージェントへ渡してください。Eumenes 側の設計は [担当の振り分けの作り直し](toolchain-router-redesign-2026-11-01.md)、添付は [criteria の一覧](assets/router-criteria-2026-11-01.json)（Eumenes の今の担当の説明文。LARM 側へは中身を渡してください）。Eumenes からの設定変更・再配備は行っていません。

---

Eumenes は常駐の会話エージェントです。利用者の発言ごとに、その発言を「会話として返事をする」か、「担当（サブエージェント）に仕事を渡す」か、「進行中の仕事の確認・訂正・取消、確認待ちへの答え」かに振り分けています。この振り分けの判断を、LARM の `system-one`（今 Eumenes が Ruri の意図判定で使っている判断の口）に置きたいので、Router の profile を作ってください。モデルの選定・実行・学習は LARM 側で行い、Eumenes はモデルを持たずに `system-one` の口で呼ぶだけにします。

## 1 今の振り分けと、その問題（Eumenes 側の記録）

| 段 | 今の中身 | 所要時間（実測） |
| --- | --- | --- |
| 意図判定 | LARM の Ruri（`system-one`、5分類）。`request` の確率が 0.6 以上なら依頼として扱う | p50 30 ms、p95 125 ms（95回、10-29〜11-01） |
| 担当の検索 | LARM の embedding で発言を埋め込み、担当の説明文との内積で上位を集める | p50 89 ms、p90 1.29 s |
| 選ぶ | 会話の LLM（LARM）に、候補の一覧と JSON schema を渡して1つ選ばせる | 中央値 45.3 s、p90 68.0 s。26回中9回が考える分で出力の上限（4096 token）に届いて切れた |

時間のほとんどは「選ぶ」の LLM の呼出しで、トークンも多く使っています。これをなくし、検索で集めた候補から LARM の判断の1回で選ぶ形に替えます。

## 2 作ってほしいもの

### 2.1 Router の profile

| 項目 | 値 |
| --- | --- |
| provider | `system-one` |
| capability | `decision.system-one` |
| protocol | `larm.system-one.v1`。下の追加（呼出しごとの criteria、`previous_user`、`scores`、`extract`）が v1 に入れられなければ、新しい protocol 名を決めて catalog に出してください |
| 見つけ方 | 今の意図判定と同じ（`GET /v3/agent-profiles?profile=<profile>` → `POST /v1/agent-connections`（`providers: ["system-one"]`）→ claim の `endpoint`・credential・model）。Eumenes は profile 名を設定に保存し、model の名前はコードにも設定にも持ちません |
| 既存への影響 | 今の意図判定の profile と、表情・声色の判定の profile の要求・応答・モデルは変えないでください |

### 2.2 1回目の呼出し: 振り分け（choice）

要求（値は例。criteria の説明は Eumenes の担当の登録データから作り、呼出しごとに変わります）:

```json
{
  "model": "<claim の model>",
  "state": {
    "previous_agent": "曲を流しますね。",
    "previous_user": "コーヒータイムにぴったりな音楽をつくって",
    "text": "違う、作曲してほしい"
  },
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "利用者の今の発言を、どこへ渡すかを選んでください",
      "criteria": {
        "conversation.respond": "仕事を始めず、話し相手として返事をする（雑談、感想、気持ち、相づち、エージェントへの質問）",
        "music.create": "音楽・効果音制作: …",
        "music.library": "音楽の再生・プレイリスト: …",
        "weather.forecast": "天気予報: …",
        "t3.redirect:music.create": "直前の依頼「コーヒータイムにぴったりな音楽をつくって」を、音楽の再生・プレイリストではなく音楽・効果音制作でやり直す",
        "t3.cancel": "コーヒータイムの曲を取りやめる"
      }
    }
  }
}
```

応答:

```json
{
  "model": "<実行したモデル>",
  "answers": {
    "route": {
      "choice": "t3.redirect:music.create",
      "probabilities": { "conversation.respond": 0.02, "music.create": 0.31, "music.library": 0.04, "weather.forecast": 0.0, "t3.redirect:music.create": 0.6, "t3.cancel": 0.03 },
      "scores": { "conversation.respond": 0.05, "music.create": 0.88, "music.library": 0.12, "weather.forecast": 0.01, "t3.redirect:music.create": 0.93, "t3.cancel": 0.2 }
    }
  },
  "routing": { "head_revision": "<版>", "calibration_revision": "<版>" },
  "truncated": false
}
```

| 項目 | 決まり |
| --- | --- |
| criteria の数 | 今は 20〜33件。担当が増えても Eumenes は検索で絞るので、64件までを通常、128件までを上限として扱えるようにしてください |
| criteria の名前 | ASCII の英数字と `.`・`:`・`_`・`-`（例 `t3.redirect:music.create`）。最大 96 文字 |
| criteria の説明 | 日本語、最大 300 字（今の平均 118 字、最大 263 字） |
| criteria の順 | Eumenes は、変わらない候補（担当・会話・記憶）を先に id の順で、呼出しごとに変わる候補（仕事・訂正・確認）を後に送ります。前置きの再利用（KV の再利用など）に使えるなら使ってください |
| `state` | `text` は先頭 2000 字、`previous_agent` と `previous_user`（新しい欄）は末尾 1000 字まで。`previous_user` を受けられない場合は、その旨を報告してください |
| `probabilities` | 送ったすべての criteria に値を返し、合計は 1。版ごとに校正した値にしてください（校正の版を `calibration_revision` で返す） |
| `scores` | 任意。criteria ごとに独立の 0〜1（「この発言がこの候補に当てはまる度合い」）。混合の依頼（「茹で時間を調べてタイマーをかけて」のように担当が2つ要る）の検出に使います。モデルが出せなければ欄ごと省いてください |
| 切り捨て | criteria を黙って落とさないでください。入りきらない場合は 400 で断るか、`truncated: true` と落とした criteria の名前を返してください |
| 失敗 | 形の不正は 400。空きがないときは今の共通の拒否（503 `resource_exhausted`）のまま |

### 2.3 2回目の呼出し: 欄（choice と extract）

選ばれた担当に欄があるときだけ、Eumenes はもう1回呼びます。今は会話の LLM に書かせている欄を、ここで埋めたいです。

```json
{
  "model": "<claim の model>",
  "state": { "previous_agent": "", "previous_user": "", "text": "明日の鎌倉の天気を教えて" },
  "questions": {
    "day": { "type": "choice", "instructions": "いつの天気か", "criteria": { "today": "今日", "tomorrow": "明日", "day_after": "明後日" } },
    "fields": {
      "type": "extract",
      "instructions": "天気を調べる場所",
      "schema": {
        "type": "object",
        "required": ["place", "prefecture"],
        "properties": {
          "place": { "type": "string", "description": "言われた地名" },
          "prefecture": { "type": "string", "description": "その地名の都道府県" }
        }
      }
    }
  }
}
```

| 項目 | 決まり |
| --- | --- |
| `extract` の schema | object の1段（property は string・number・boolean・enum の string、`description`、`required`）。Eumenes はこれより深い形を送りません |
| 応答 | `answers.fields.value` に schema に合う object、`answers.fields.confidence` に欄ごとの 0〜1。発言にない値は作らず `null` にしてください（`required` でも） |
| できない場合 | `extract` を扱えないモデル・実行なら、HTTP 400 で本文 `{"error": {"code": "unsupported_question_type", "message": "…"}}`（LARM の既存のエラーの形）を返してください。Eumenes はその間だけ会話の LLM で欄を埋めます |

参考: 調べた範囲では、LiquidAI/d1-2B は抽出を持つ判断モデルですが、llama.cpp の `/v1/systemone` は 2026-11-01 時点で choice・score・yes/no だけで、multiple と抽出は未対応と GGUF のカードにあります。

## 3 モデルの候補と測ってほしいこと

モデルの選定は LARM 側の判断です。Eumenes 側の調査では次の順で試すのがよいと考えています（ベンチマークは一般のもので、この振り分けの精度ではありません）。

| 順 | モデル | 形 | 実行の候補 | 理由 |
| --- | --- | --- | --- | --- |
| 1 | LiquidAI/d1-2B（2026-10-27 公開、LFM Open License v1.0） | 生成しない判断モデル。候補の説明を並べた入力を1回の forward で選ぶ | llama.cpp（GGUF Q8_0 1.85 GB、`/v1/systemone`、build b11960 以上） | 学習なしで、会話を含めた候補全体から1回で選べる見込みがある唯一の候補 |
| 2 | hotchpotch/japanese-reranker-xsmall-v2（MIT、36.8M） | CrossEncoder | ONNX Runtime の CPU（int8 を公式に同梱） | 軽い。学習しやすい |
| 3 | cl-nagoya/ruri-v3-reranker-310m（Apache-2.0、315M） | CrossEncoder | ONNX（int8 は変換が要る。今の Ruri と同じ形） | 公開の日本語の比較表で最上位 |
| 4 | Qwen/Qwen3-Reranker-0.6B（Apache-2.0） | decoder 型 reranker | llama.cpp `--rerank` | 比べるためだけ。日本語の公開値なし |

CrossEncoder で `choice` を作る場合は、`state` を1つの query にし、criteria の説明を passage にして組ごとに採点し、sigmoid を `scores`、温度付きの softmax を `probabilities` にしてください。

AI MAX+ 395 で、次を測って報告してください。数値は実測と推定を分けてください。

| # | 測ること | 条件 |
| --- | --- | --- |
| 1 | 1回目の呼出しの warm の P50・P95 | CPU だけ、batch 1、warmup 10回の後、各100回以上。criteria の数 20・40・64・128（添付の一覧の説明を使い、足りない分は同じ長さの説明を複製）。発言は 20〜60 字 |
| 2 | 同じ条件の d1-2B の前置きの再利用の有無 | 変わらない criteria を先に置いた場合と、置かない場合 |
| 3 | ロードの時間、常駐のメモリ（RSS）、使うスレッドの数、CPU の時間 | process ごと |
| 4 | 会話の LLM への影響 | 会話の LLM で生成を流しながら 1 を測り、そのときの会話の LLM の token/s の下がり方 |
| 5 | iGPU で動かした場合 | CPU で N=40 の P95 が 1.5 s を超えたモデルだけ。4 と同じく会話の LLM への影響も |
| 6 | 2回目の呼出し（extract） | 扱えるモデルだけ。P50・P95 |

精度は、Eumenes が評価データ（正解付き、400〜600件）を作ってから測ります。それまでは速さと資源だけを測り、精度の値を作らないでください。

## 4 評価と学習のデータ

Eumenes は、利用者が正解を付けた評価データを JSONL で渡します。1行の形:

```json
{"id":"music-03","group":"conv-7f2a","split":"test","state":{"previous_agent":"曲を流しますね。","previous_user":"コーヒータイムにぴったりな音楽をつくって","text":"違う、作曲してほしい"},"criteria":{"conversation.respond":"…","music.create":"…","music.library":"…","t3.redirect:music.create":"…"},"gold":{"primary":"t3.redirect:music.create","acceptable":["music.create"]},"tags":["correction","confusable:music"]}
```

| 項目 | 決まり |
| --- | --- |
| split | `train`・`calibration`・`test`。会話（`group`）の単位で分けてあります。`test` は学習にも校正にも使わないでください |
| 予測の返し方 | `test` の各行について、`id`・`probabilities`・`scores`（あれば）・所要時間・モデルの版を JSONL で返してください。Eumenes が正解と突き合わせて集計します |
| 学習（CrossEncoder） | 組（`state` → query、criteria の説明 → passage）で学習し、criteria の名前（id）を特徴に使わないでください（新しい担当を、説明文だけで採点できるようにするため）。`conversation.respond` もほかと同じ1つの criteria として学びます。負例は同じ行のほかの criteria です |
| 学習の確認 | `test` での結果に加え、criteria を1つずつ学習から外して学習し直し、外した criteria の当たり方（説明文だけで選ばれる割合）を出してください |
| 版 | 学習・校正の版を `head_revision`・`calibration_revision` で返し、前の版に戻せるようにしてください |
| d1-2B | 公開の学習手順がないので、校正（温度）だけにしてください |
| 会話の本文 | 評価・学習のデータには利用者の会話の本文が入ります。Git や LARM のログに出さず、LARM のホストの外へ出さず、Eumenes から削除を頼んだら消してください。ログには id・件数・時間だけを残してください |

## 5 受入れの条件

| # | 条件 |
| --- | --- |
| 1 | §2.2 の要求・応答の形が通る。criteria 128件まで、名前と順を保つ、`probabilities` の合計が 1、送った criteria がすべて応答にある、黙って落とさない |
| 2 | 1回目の呼出しの CPU の warm P95 が N=40 で 1.0 s 以下（1.5 s までは可）、N=64 で 2.0 s 以下。N=128 の値も報告 |
| 3 | 1回目の呼出しを流している間の会話の LLM の token/s の低下が 5% 以下 |
| 4 | 今の意図判定・表情判定の要求に対する応答が変わらない |
| 5 | `extract` は、扱えれば schema に合う値と発言にない値の `null`、扱えなければ 400 `unsupported_question_type` |

## 6 報告してほしいこと

- 選んだモデルと実行（llama.cpp・ONNX Runtime など）、CPU・iGPU のどちらで動かすか、その理由。
- §3 の表の測定値（モデル × criteria の数 × P50・P95、ロード時間、メモリ、CPU、会話の LLM への影響）。実測と推定を分けて。
- Eumenes の設定に保存する Router の profile 名。
- protocol の追加・変更点（`previous_user`・`scores`・`extract`・criteria の上限）と、できなかったこと。

## 7 制約

- 調査と測定は評価用の process で行い、設定変更・再配備・Provider の再起動は担当者の承認を得てから行ってください。
- 今の意図判定・表情判定の profile とモデルは変えないでください。
- Eumenes 側のコード・設定は変えないでください（Eumenes の実装は別に行います）。
- モデルの名前を Eumenes に設定させる形にしないでください（claim の model で返す）。
