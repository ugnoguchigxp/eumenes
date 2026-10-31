# 応答遅延のcache観測

LARMのcache再利用を、製品の生成と同じメッセージの並び（system、最近の会話、`## State` と質問の最後のmessage）の合成入力で観測します。保存済みのLARM接続を読み取り専用で取得し、このプロセスから呼びます。サーバーの起動・再起動、製品DBへの保存、操作の実行は行いません。

初回の判断を比べるbench（出力方式・入力配置の比較）は、初回の分析を生成の1回へ置き換えたため削除しました。結果の記録は `spec/verification/` に残っています。生成の判断の評価は `bun run context:eval`（`scripts/context-eval/`）が担います。

```sh
# 主回答の約1.4万推定token、連続再送・背景更新・補助4件後のcache観測
bun scripts/response-decision/cache.ts --run
```

`cache.ts` の入力は `cache-input.ts` が作ります。system部は製品の `systemText`、最近の会話は製品の `recentMessages` で描き、合成した発言（最初の自分の発言が参照値 `VALUE=`）を足して約14,000推定tokenにします。最後のmessageは `## State` と固定の質問です。背景更新の段階では、参照値を変え、`## State` に決まったことを1件足します（先頭に近い部分の書換えで、cacheがどこから外れるかを見る）。個人の履歴は読みません。

`backend.jsonl`は通常の安全な運用ログ、`result.json`は段階ごとの正式計数・timings・参照値の一致です。本文・引数・Provider生応答は保存しません。`revisionComparable=false`はboot/config情報が不足、または途中で変わったことを示します。異なるrevisionの数値をまとめて採否判断しません。独立したauxiliary接続を使うため、初回をcold、同一再送をwarmと断定できません。cache値を確認してください。

集計は接続終了とloggerのflush後に行います。`coverageComplete`は各呼出しの正式計数とtimingの件数・欠測を検査し、`revisionComparable`はその完全性とboot/config一致を要求します。失敗した計数や欠測を0で補いません。

cache試験の`formalAcceptance`は、資料の値の読取り、正式入力14,000±256 token、全段階の実行、即時再送と補助4件後のcache数が正式入力との差8 token以内であることを検査します。合格しなければ終了コード1です。校正中の入力数は目標の合否から除外しますが、成否・計数・timingは残します。

2026-10-24のliveでは、会話履歴の後ろにあるsystem資料8,421文字が正式計数から落ち、値の読取りにも失敗しました。同じ資料は先頭system、連続する先頭system、後方userなら読めました（記録は `spec/verification/larm-revalidation-2026-10-24.md`）。この問題がある環境では、推定量だけを基に長文cacheの受入を宣言しません。

製品の生成は、最近の会話をネイティブの `user`・`assistant` で置き、`## State` と今の入力を最後の user message に置きます（system roleには入れない）。`cache.ts`の通常配置が、この環境で値を読めて、cache再利用が即時再送と補助4件後で保たれるかは、実機のliveで別に記録します（設計書 §21.3）。推定byte数だけの比較、情報が欠落する条件の短縮、短いsmoke成功だけでの採用は行いません。
