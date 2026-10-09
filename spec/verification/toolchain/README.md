# Toolchain / 調査担当 / SKILL 実装記録

2026-10-09。実装の詳細は[計画書の実装結果](../../toolchain-web-research-implementation-plan-2026-10-09.md#18-実装結果と確定した変更2026-10-09)。

## 実装

`capabilities`、`tool-runtime`、`agent-runtime` を追加し、会話・inference・Queue・既存Web取得へ接続した。子はプロフィール・必須SKILL・選んだtool契約を受け取り、本文を読む。メインへは要約・主張・ホスト由来の出典情報・不足情報だけを返し、本文・引用・titleを返さない。

候補は最大8件/8KiB、必須内容は16KiB。各参照はroot/task/取消epochに所属し、入力schema、依存hash・利用停止、URLの依頼範囲をホストで再検査する。原観測はメモリーだけに置き、確定report/input/argsは14日、本文なしmetadataは30日。最終回答採用にはreportのepoch/hashとroot revisionを再検査する。取消・再起動・削除・失効後の結果は採用しない。

## fixture

関連9 domain（capabilities、tool-runtime、agent-runtime、web-research、queue、inference、larm、dialogue、voice-dialogue）の個別gateを実行した。最終の全体gate件数は下記へ記録する。新しいAPI E2Eでは天気/株価、必須SKILL、要約の境界、1推論枠での新しい会話、取消・再起動・期限・容量・JSON修正・引用偽装と一度の修正・失敗時の架空数値の廃棄・削除/保持期限・CLIを確認する。browser fixtureは入力から調査card・出典・最終回答・再読込みまで確認する。外部命令sentinelが子にだけ届き、メインと画面へ流れないことを検査する。

5,000 toolと5,000 package、固定の2依存を登録した合成catalogで、明示alias 100/100、候補の件数/bytes、所有者違い、停止した依存の除外、選択済み3依存だけの展開を確認した。一般日本語の意味品質評価やp95性能測定を行った結果ではない。

最終snapshotで関連9 domainの個別gateは全件合格。`bun run verify:all` はformat・lint・型・境界・build、backend **354/354**、Web **92/92**、browser **16/16** が合格（104.6秒）。browserの内訳はToolchain 2件と既存音声・設定等14件。全体gateはfixtureを使い、下記liveとは分けて扱う。出力はGit対象外の `verification-reports/toolchain/{domain}.txt` と `all.txt`、入力revisionと工程別結果は `verification-reports/latest.json`。`git diff --check` も合格。

## live

`EUMENES_LIVE_TOOLCHAIN=1 bun run verify:live -- --domain agent-runtime`。実LARM・公開Web・一時DBの隔離backendから認証付きAPIで入力し、fixture置換を使わない。2026-10-09 20:19〜20:20 JSTの最終版の実行で2/2成功した。株価は引用した取引所日付と最終回答の日付の一致も合格条件に含む。

| 依頼 | 取得した数値 | 取得元・対象時点 | 最終回答 | 推論/tool | 所要時間 |
| --- | --- | --- | --- | --- | --- |
| 東京の翌日の天気・最高気温 | 晴れ、26℃ | 気象庁、2026-10-10短期予報 | 晴れ・26℃・対象日を回答 | 4/1 | 30.1秒 |
| AAPLの最新の株価 | 340.42 USD | Yahoo Finance、2026-10-08 16:00 America/New_York | 340.42 USD・価格時点を回答 | 4/1 | 27.6秒 |

実行ごとの公開結果はGit対象外の `verification-reports/toolchain/live.json`。価格・予報は上記の試験時点の値であり、現在値として固定しない。検索だけでは株価数値が得られない試行、guard拒否・上流失敗、制御JSON不正、tool引数不正、引用不一致も観測した。JSON object生成、依頼の一意な対象から作る呼出し例、一度の修正で対応し、修正できない場合は失敗通知を返す。誤ったUnix時刻換算はホストの変換で防いだ。取得失敗時に古い株価を生成するケースは固定通知へ置換し、架空の数値を返すfixtureで検査した。成功試験2件から全サイト・全銘柄・全質問に対する成功率は推定しない。

## コードレビュー後の再検証

レビューと修正内容は[2026-10-09のレビュー記録](review-2026-10-09.md)。上記354/92/16件と20:19〜20:20のliveは実装時の過去snapshotであり、レビュー後の検証結果は別に記録する。

取消rollbackの波及、vault容量漏れ、候補の再利用、必須指示の混入・欠落、tickerの境界、削除済みreportの表示、失敗表示、step台帳、liveの数値判定、長い依頼の契約を修正した。レビュー後の関連9 domainの個別gateは全件合格。全体gateはbackend **363/363**、Web **94/94**、browser **16/16** と全工程が合格（106.1秒）。revisionと工程別結果はレビュー記録と `verification-reports/latest.json` に記録した。

実LARM＋公開Webの再実行は20:50〜20:51 JSTに2/2成功。東京の10月10日予報は晴れ・最高26度（29.0秒、推論4/tool1）、AAPLは340.42 USD・10月8日16時 America/New_York（34.8秒、推論5/tool1）。数値が引用・子の主張・最終回答で一致し、株価の取引所日付も一致した。元データ・最終回答は `verification-reports/toolchain/live.json`、出力は `review-live-final.txt`。全て隔離backendでの試験であり、実機器の音声受入ではない。

## 未実施・意味品質の限界

実マイク・ヘッドホン3往復、一般日本語query100件のRecall@8、p50/p95の基準機測定、10ケース以上の実モデル品質評価は未実施。本文内の引用の実在は検査するが、意味の一致と完全なinjection耐性を保証しない。天気の要約には予報対象時刻を発表時刻として書く誤りや、週間予報の日付を読み違える不足情報も観測した。最終E2Eは天気・最高気温の取得と回答を確認するもので、説明の全事実を検証した結果ではない。sourceの取得日時はホストの値であり、本文中の対象日とは別に表示する。取得拒否やguard拒否は迂回しない。株価は遅延/終値を含む。
