# LARM の prompt キャッシュ（KV prefix 再利用）修正依頼 Prompt

以下を LARM 担当者または LARM 側の調査・実装エージェントへ渡してください。Eumenes 側の計測（2026-10-22）で、LARM の LLM Provider が同じ入力の先頭部分を一度も再利用していないことを確認しました。Eumenes からの設定変更や再配備は行っていません。

---

Eumenes は LARM の保存済み接続から主会話 profile を発見し、Connection 作成・ready 確認・claim を経て、claim の Provider（`/v1/chat/completions`、llama.cpp server 形式の応答）で推論しています。音声会話では 1 回の発話に LLM を 2〜4 回呼び、そのたびに 3,000〜5,500 token を送ります。今は入力の読込み（prefill、約 1ms/token）が応答時間の大半を占めていて、挨拶 1 回に 15〜20 秒かかります。

KV の prefix 再利用が効けば、同じ先頭を持つ 2 回目以降の要求は差分だけを読めば済むはずですが、現状は毎回全文を読み直しています。原因を特定し、再利用が効くように修正してください。

## 1 観測した事実（Eumenes 側の計測）

同じ Connection（同じ client 識別子・同じ connectionId）に、**完全に同じ要求**を 0.3 秒間隔で 2 回送りました。system 約 3,000 token＋user 1 文、`stream: false`、`max_tokens` 指定、ほかの項目は `model` と `messages` だけです。

| 要求 | `timings.prompt_n` | `timings.cache_n` | `timings.prompt_ms` | `usage.prompt_tokens_details.cached_tokens` |
| --- | --- | --- | --- | --- |
| 1 回目 | 3040 | 0 | 2962 | 0 |
| 2 回目（同一内容） | 3040 | 0 | 3171 | 0 |
| 2 回目（body に `cache_prompt: true` を追加） | 3040 | 0 | 3195 | 0 |

- 補助 session（要求ごとに別の client 識別子・別 Connection）でも同じく `cache_n: 0` でした。これは別 Connection なので想定どおりですが、主会話の同一 Connection でも 0 なのは想定外です。
- 2026-10-21〜22 の本番ログでも、すべての LLM 呼出しで `cached_tokens` が 0 です。
- 出力速度は約 71 token/s、prefill は約 960〜1,030 token/s です。

## 2 調べてほしいこと

推測ではなく、配備中の LARM・Provider の設定、起動引数、実装、Provider のログを根拠にしてください。

1. **Provider の起動設定**: llama.cpp server の prompt キャッシュに関わる設定（`--cache-reuse`、`--cache-ram`、`--parallel`/slot 数、`--swa-full`、`--kv-unified`、`--slot-save-path` など）と実際の値。キャッシュを意図的に無効にしているなら、その理由。
2. **slot の割当て**: 同じ Connection の連続した要求が同じ slot に入るか。LARM が要求ごと・claim ごとに slot を消去したり（erase）、別の slot へ振ったりしていないか。`id_slot` を固定する経路があるか。
3. **モデルの種類による制約**: 配備中のモデルが SWA（sliding window attention）や hybrid/recurrent 系で、llama.cpp が全文の再処理を強制していないか。Provider のログに「forcing full prompt re-processing」に当たる記録が出ていないか。
4. **LARM の中継**: LARM が要求を Provider に渡すときに、`cache_prompt` を false にしたり、先頭に毎回変わる内容（時刻・ID など）を差し込んだりしていないか。chat template の適用で、同じ messages から毎回違う token 列ができていないか。
5. **共有 KV との関係**: docs にある「LARM は共有 KV と Session を管理」の具体的な意味。Connection ごとの KV 保持期間、ほかの Connection（補助・ASR・TTS など）の要求でキャッシュが追い出される条件。

## 3 期待する結果

- 同じ Connection に同じ先頭を持つ要求を続けて送ると、2 回目の `cache_n`（`cached_tokens`）が共通部分の token 数に近い値になる。
- 1 回目と 2 回目の間に、ほかの Connection の要求が 1〜2 件入っても、主会話の Connection のキャッシュが残る（主会話 1＋補助 3 の同時接続は 2026-10-12 に確認済みの構成）。
- 先頭の一部だけが同じ要求（同じ system、user だけが違う）でも、共通部分が再利用される。
- 主会話の応答・ASR・TTS の同時実行の性能と、KV 容量の上限を悪化させない。悪化するなら、その量と取捨の判断材料を示す。
- モデルの制約で再利用できない場合は、その根拠と、構成を変えずに取れる代替策（slot の固定、`--swa-full` のメモリ費用など）を示す。

## 4 受入れの確認方法

修正後、次の 3 件を実接続で確認し、`timings`（`prompt_n`、`cache_n`、`prompt_ms`）を記録してください。

1. 同じ Connection・同じ内容の要求を 2 回 → 2 回目の `cache_n` が `prompt_n` のほぼ全部。
2. 同じ system・違う user の要求を 2 回 → 2 回目の `cache_n` が system 部分の token 数に近い。
3. 2 回の間に別 Connection の要求を 1 件挟む → 主会話の 2 回目でも `cache_n` が残る。

Eumenes 側でも同じ確認ができるように、`usage.prompt_tokens_details.cached_tokens` と `timings.cache_n` の今の応答の形は変えずに保ってください。

## 5 制約

- 調査は読み取り専用から始め、設定変更・再配備・Provider の再起動は担当者の承認を得てから行ってください。
- ほかの consumer の接続を解放したり、既存データを削除したりしないでください。
- 検証用の要求には、機密を含まない合成テキストだけを使ってください。会話本文・認証情報・Provider の生応答をログや報告に残さないでください。
- 回答では、仕様の確認、設定の変更、実接続での検証を分けて記録してください。
