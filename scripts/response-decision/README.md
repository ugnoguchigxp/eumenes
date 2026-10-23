# 応答遅延の判断比較

製品の初期判断と同じ `analysisTools`、入力組立て、生成・修正、validatorを使う比較です。保存済みのLARM接続を読み取り専用で取得し、このプロセスから呼びます。サーバーの起動・再起動、製品DBへの保存、選ばれた操作の実行は行いません。

```sh
# runnerだけのfixture確認。LLMの品質・速度評価には使わない
bun scripts/response-decision/bench.ts --run --fake --split all --repeat 1

# 保存済み接続への短い疎通確認
bun scripts/response-decision/bench.ts --run --smoke

# 探索用12ケース×3回、独立した採否用24ケース×5回
bun scripts/response-decision/bench.ts --run --split dev --repeat 3
bun scripts/response-decision/bench.ts --run --split holdout --repeat 5

# 合成した長い背景を加えた同じ比較
bun scripts/response-decision/bench.ts --run --split dev --repeat 3 --long

# 主回答の約1.4万推定token、連続再送・背景更新・補助4件後のcache観測
bun scripts/response-decision/cache.ts --run

# Providerが先頭・後方のsystemとuserの資料を読めるか確認
bun scripts/response-decision/visibility.ts --run
```

比較対象は `native-legacy`（native出力・従来配置）、`schema-legacy`（schema出力・従来配置）、`schema-stable`（schema出力・固定指示を先頭systemへ統合）の3つです。修正規則の固定化は全arm共通です。旧製品全体との比較ではなく、出力方式と入力配置の差を分離する比較です。候補・説明・依頼・参考情報の内容は同じです。armの実行順を回転し、失敗を含めて時間・修正数・品質を記録します。`--out`は新規ディレクトリを指定してください。

`manifest.json`でケースIDと条件を固定し、`samples.json`に呼出し数、所要時間、結果の分類、品質一致を保存します。本文・引数・Provider生応答・入力のdigestは保存しません。実送信のchat/completions JSONをメモリ内で比較し、共通byte数と最初に変わったフィールドだけを保存します。このbyte数はProviderのprompt templateや実際のcache再利用token数ではありません。

`backend.jsonl`は通常の安全な運用ログ、`summary.json`は失敗を含む中央値・p95・最大値と正式計数・timingsです。`revisionComparable=false`はboot/config情報が不足、または途中で変わったことを示します。異なるrevisionの数値をまとめて採否判断しません。独立したauxiliary接続を使うため、初回をcold、同一再送をwarmと断定できません。cache値を確認してください。

このrunnerはR1の判断だけを比較します。取消・忘却・承認後の実行・pipeline/task_control・完了判定・回答・音声の通し受入はdomain/公開APIのfixtureと実機器試験が別途必要です。短いsmokeやfixture成功を、計画書のlive採用条件の合格と扱いません。LARMの保持修正後のcold/warm・背景更新後・補助4件後の比較も残ります。

LARMの判断用grammarでは、大きな文字列長範囲がコンパイル失敗を起こすことを実測したため、`minLength/maxLength`は説明として提示し、元のschemaとhost validatorで強制します。型・候補・必須項目・object境界はgrammarで制約します。候補の説明と引数schemaはモデルの入力にも明示します。grammarの指定だけでは、その説明をモデルが読めるとは限りません。別方式への自動再送は行いません。

2026-10-24のliveでは、会話履歴の後ろにあるsystem資料8,421文字が正式計数から落ち、値の読取りにも失敗しました。同じ資料は先頭system、連続する先頭system、後方userなら読めました。`visibility.ts`はこの互換性を検査し、欠落時は終了コード1にします。この問題がある環境では、推定量だけを基に長文cacheの受入を宣言しません。判断用schema候補の説明は先頭systemへ統合していますが、主回答のMemory/状態全体のProvider互換性を修正したことにはなりません。
