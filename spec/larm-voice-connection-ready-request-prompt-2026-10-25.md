# LARM の音声用接続が ready にならない・遅い件の調査依頼 Prompt

以下を LARM 担当者または LARM 側の調査・実装エージェントへ渡してください。2026-10-25 の Eumenes 側のログで、LLM・ASR・TTS を含む接続が ready になるまで 6〜22 秒かかり、一度は 2 分以上 ready にも失敗にもならなかったことを確認しました。Eumenes からの設定変更・再配備は行っていません。

---

Eumenes は音声会話を始めるとき、LARM の保存済み Control 接続先へ `POST /v1/agent-connections` を送り、LLM・ASR・TTS の 3 つの Provider を含む Profile 全体の接続を依頼します。続けて `GET /v1/agent-connections/{id}` を 1 秒ごとに問い合わせ、接続の `status` が `ready` になり、3 つの Provider の `readiness` がすべて `ready` になってから claim します。ready を待つ間、利用者の発話の文字起こし（ASR）は始められません。Eumenes は ASR を 15 秒で打ち切ってクラウドへ切り替えるため、その間、利用者からは「話しても拾われない」「返事が 20 秒以上来ない」と見えます。

ready になるまでの時間が長い原因、および ready にならないまま止まる原因を特定し、修正してください。

## 1 観測した事実（Eumenes 側のログ）

時刻はすべて 2026-10-25（JST）です。所要時間は、Eumenes が接続を始めてから ready を確認するまでの時間です。

| 時刻 | connectionId | Provider 数 | ready までの時間 |
| --- | --- | --- | --- |
| 19:08:49 | `aconn_epoch-805996cb-4035-49ea-bc5d-c44d9fb41351_fa68e7d7-de9a-45e1-9d1d-0a1616160a0c` | 5 | 5.0 秒 |
| 20:12:39 | `aconn_epoch-805996cb-4035-49ea-bc5d-c44d9fb41351_499359e0-d7db-48c8-b21b-1de336eff8e5` | 3 | **22.6 秒** |
| 20:41:28 | 同上（`…1de336eff8e5`） | 3 | **12.0 秒** |
| 20:53:45 | 同上 | 3 | **17.4 秒** |
| 20:55:19 | 同上 | 3 | 6.3 秒 |
| 21:22:24 開始 | 新規（直前に `aconn_epoch-dda002ea-1ede-4504-aa8f-c4a58f14e484_9c7d6f92-df49-4d83-88f4-07f4a0bd7336` を解放、204） | 3 | **2 分以上 ready にも失敗にもならず**、21:24:16 に Eumenes を再起動するまで待ち続けた |

- LLM だけの接続（Provider 1 つ）は、同じ時間帯に 7ms〜2.8 秒で ready になっています。
- 20:12〜20:55 の遅い例は、すべて同じ connectionId への再依頼（更新）です。接続が既にある状態で同じ構成を依頼し直しても、6〜22 秒かかっています。
- 21:22 の例では、`POST` の後、`GET` が `failed`・`expired`・`released` のいずれも返さず、`ready` にもなりませんでした（そうなっていれば Eumenes は失敗として記録します）。Eumenes 側ではこの待ちの間の `status` と各 Provider の `readiness` の値を記録していません。LARM 側の記録で確認してください。
- 待っている間、同じ Profile の LLM には、Eumenes の別の接続（背景処理の LLM 要求）から要求が入っていることがあります。
- ASR の文字起こし自体は、ready の後なら 1.2〜1.4 秒で応答しています。

## 2 調べてほしいこと

推測ではなく、配備中の LARM の実装、設定、LARM と Provider のログを根拠にしてください。

1. **21:22 に始まった接続の経過**: 21:22:24 以降に作られた接続の `status` と、LLM・ASR・TTS それぞれの `readiness` が、どの値のまま止まっていたか。何を待っていたか（容量、モデルの読込み、他の接続の解放、claim の競合など）。期限や打ち切りがなかったのはなぜか。
2. **ready までの時間の内訳**: 20:12・20:41・20:53 の例で、どの Provider の `readiness` が最後に ready になったか。その Provider が ready になるまでに何をしていたか（モデルの読込み・ウォームアップ・ヘルスチェック・待ち行列）。
3. **既存の接続への再依頼**: 同じ client・Profile・audience・Provider 構成・catalog revision で `POST` し直したとき（Idempotency-Key は依頼ごとに新しい）、既に ready の Provider まで ready でない状態に戻していないか。
4. **Provider の待機と解放**: ASR・TTS の Provider が、使われない間に停止・解放され、次の接続で読み込み直していないか。その条件（無通信の時間、メモリの逼迫、他の Profile への切替）。
5. **LLM との競合**: 同じ Profile の LLM が別の接続で生成中のとき、ASR・TTS の ready が遅れる、または止まる仕組みがないか。

## 3 期待する結果

- LLM・ASR・TTS の接続は、Provider が既に読み込まれていれば 2 秒以内に ready になる。既存の接続への再依頼でも同じ。
- 読込みが必要な場合も、ready までの時間の上限と、そのとき `GET` が返す状態（どの Provider を何のために待っているか）が決まっている。
- ready にできないときは、上限の時間内に `failed` などの終わりの状態を返し、待ち続けない。
- 主会話の LLM・背景の LLM・ASR・TTS が同時に使われても、上のとおりに動く。そうできない場合は、その理由と、取れる構成（ASR・TTS を常駐させる、など）の費用（メモリ・GPU）を示す。

## 4 受入れの確認方法

修正後、実接続で次を確認し、`POST` から ready までの時間と、各 Provider の `readiness` の推移を記録してください。

1. LLM・ASR・TTS の接続を新しく作る → ready までの時間。
2. 1 の接続が ready のまま、同じ構成で `POST` し直す → ready までの時間（2 秒以内）。
3. 別の接続で LLM の生成を流しながら、1 と同じ接続を作る → ready までの時間と、止まらないこと。
4. ASR・TTS を 10 分使わずに置いた後、1 と同じ接続を作る → ready までの時間。

Eumenes 側でも同じ確認ができるように、`POST /v1/agent-connections` と `GET /v1/agent-connections/{id}` の応答の形（`status`、Provider ごとの `readiness`）は変えずに保ってください。

## 5 制約

- 調査は読み取り専用から始め、設定変更・再配備・Provider の再起動は担当者の承認を得てから行ってください。
- ほかの consumer の接続を解放したり、既存データを削除したりしないでください。
- 検証用の要求には、機密を含まない合成の音声・テキストだけを使ってください。会話本文・音声・認証情報・Provider の生応答を、ログや報告に残さないでください。
- 回答では、仕様の確認、設定の変更、実接続での検証を分けて記録してください。
