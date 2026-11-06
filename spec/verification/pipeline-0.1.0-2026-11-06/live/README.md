# Pipeline 0.1.0 live検証の要点（課題一覧への証拠）

2026-11-06。[全体課題一覧](../../../project-issues-2026-11-06.md)を進める作業へ渡す証拠である。修正は行っていない（利用者の指示により、証拠の提供のみ）。

- **実施条件**: 検証専用の会話 `verify-pipeline-010-20261106-{a..f}` で実施し、`main` は使っていない。
- **Router設定**: `entry: route`、構造解析の接続なし、`accept 0.6`、`multi 0.5`、reranker profile `lfm2.5`。
- **LLM**: 設定済みのクラウド経路。
- **詳細**: [実接続の詳細](../../../pipeline-0.1.0-hardening-2026-11-06.md)の「live検証」節。

## EUM004 に関わる証拠：振り分けがPipelineに届けば、実モデルで最後まで通る

17:30 JST、会話f、run `1093fc72-…`、execution `9d11f6ad-1a31-4229-9422-c1980d253c58`。

| 段 | 結果 |
| --- | --- |
| 依頼 | 「計算結果を使って別の作業を実行して。1から50までの素数の個数を計算し、その個数と同じ秒数のタイマーを作ってください。」 |
| 振り分け | `pipeline.execute` p=0.879、row 2（[routing-f.json](routing-f.json)） |
| 計画 | 1回、修復なしで `ready`。`count-primes`（`compute.python`、from `request`）→ `start-timer`（`timers.manage`、from `count-primes`）、`output.from: ["start-timer"]` |
| 原文の結び付け | `requestEcho: {matched: true}`。定義と実行計画のrequestは原文 |
| 子の実行 | 2件とも `completed`。タイマーは計算結果どおり15秒で開始 |
| 実行 | `completed`（[end-to-end-f.json](end-to-end-f.json)） |

**限界**: この依頼はPipelineのカードの例文で始まっている。Pipelineに届いたのはそのためで、EUM001（普通の言い方の複数作業がPipelineへ届かない）の解消を示すものではない。題材は1件だけである。

**質問の期限切れ**: 会話e（execution `e61eb9b4-da17-4d79-ab79-2fbd2cf2d2be`）は、答えが届かないまま16:16:31に `partial`（`execution_question_expired`、`fulfilled: []`）で終わった。成功としては扱われていない。

## 課題一覧に無い問題：最終配送で、計画が「伝える」とした内容が会話に届かない

会話fの結果では、素数の個数（15）がどの会話文にも出ていない。利用者に見えたものは次の3つだけだった。

- 受付文「「パイプライン」に頼みます。」
- `task_result` のカード（`presentation: artifact`、run `a0de65d4-23c2-4f98-9080-660328ac816c`）
- 後のタイマー通知「15秒のタイマーが終了しました。」（runなし）

確認した経路は次のとおり（コードと記録で確認、推測は含まない）。

1. **計画の選択**: 計画は `deliver` を「計算した素数の個数と、その個数と同じ秒数で開始したタイマーの結果を伝える。」とした。一方で `output.from` には `start-timer` だけを入れた。個数を持つ `count-primes` の結果は、配送の対象外になった。bundle `pipeline.execute` の指示文は、`output.from` を「最終配送する手順ID」と説明している。
2. **最終結果の組立て**: `api/domains/agent-runtime/service/execution-pipeline.ts`（`next` の完了分岐、53〜63行付近）が組み立てる。中身は、`output.from` の子の要約をそのまま並べ、最後に `配送: <deliver>` の1行を付けたものである。`deliver` の指示をモデルが実行して伝える段は無い。この回の要約は、タイマーの受領票JSONと「配送: …」の行だった。
3. **会話への報告**: `task_result` を受けたrun `a0de65d4` は `completed` だったが、このrunのassistantの発言は無い。会話の文で結果を説明しなかった。

**課題として扱う場合の観点（案。判断方式の変更を含むので未実装）**:

- 配送で伝える内容と `output.from` の整合をどこで担保するか。計画の指示文で担保する場合は、bundleの改訂が必要になる。
- `deliver` を実行して利用者の言葉で伝える段を、既存の会話の報告に持たせるか。
- 受領票JSONを会話・カードにどう見せるか。

EUM003（完了・未実施の説明）の「結果を届ける」受入と重なる。固定の文言を付ける対応や、`deliver` を表示するだけの対応では、伝えるべき値（ここでは15）は届かない。
