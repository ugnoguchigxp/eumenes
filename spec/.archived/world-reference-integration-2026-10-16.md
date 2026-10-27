# Worldの判断材料と収集資料の接続

目的: v5を維持し、Eumenesの既存World調査担当が根拠・条件・有効期間を失わず報告する。収集Seedの投入は利用者承認済み。

確認した不足: world.queryのbasisは有効期間と条件評価を捨てている。原典の永続化は会話SourceAdapterしかなく、984件の資料を会話として投入すると本人申告と混同する。新たな意味分類器や監査ループは作らない。

変更範囲・順序:
1. パッケージ既存の条件評価をbasisへ付加し、asOf・観測未提供・validTimeを調査担当へ渡す。
2. world所有の収集資料台帳を追加。ホストScope、既存Writer、版とdigestの固定、再投入の冪等性、取り下げ、検索と部分読取りを提供する。これは外部資料の保存接続であり意味判断はしない。
3. 既存World調査へ資料読取りを接続。資料は独立した出典種別とし、報告採用時に版と取り下げを再確認する。旧bundle版を残して新版を登録する。
4. 単体（保存・Scope・版・有効期間）→結合（担当・引用・失効）→影響domain静的検査/試験→実環境の取り込み・読み取りの順で検証する。

完了条件: 984件の元データと由来を保持し、再投入で重複せず、他Scope・撤回資料は読めず採用できない。会話由来の記憶と収集資料が報告でも区別される。既存v5は変更しない。実モデルで未確認の性能は明記する。

実装・隔離検証・結果記録と本体Seed984件の投入は完了（追記参照）。通常サーバー起動はWebツールの版競合で未完了。原典からの全件LLM抽出や自動採用、実行許可、Web正本再検証は今回の接続とは別であり実装しない。


## 実装した利用方法

- 会話のメインモデルへ全Worldや984資料を常時注入せず、必要時に既存 `world_query` 調査担当へ委譲する。構造化された関係は `world.find` → `world.query`、収集原文は `world.documents` の検索→読取りを使う。
- 適用資料の選択はLLM、条件・期間の計算は既存Worldパッケージ。basisに条件評価・有効期間・UTC判定時刻を保持する。現在の照会は観測値を供給していないので、それを明記する。原文読取りだけで構造化計算まで実行済みとは扱わない。
- `world_host_document` は外部収集資料を会話と分離して保持するホストの台帳。本文・collection・manifestDigest・digest・固定revisionを保存する。同一内容の再投入はunchanged、内容変更は409、取り下げ後の再投入も409。訂正版は別IDで追加し、旧版を取り下げる。全件自動抽出・グラフ採用は行わない。
- Scopeはホストから取得し、書込みは既存Writerを使う。モデルには検索と読取りだけを公開する。引用は `world_document` として既存の根拠カタログ・報告機構へ渡し、採用直前にScope・版・取り下げを検査する。
- bundleは旧定義を保持しprofile 3 / skill 5 / package 5 / toolchain 7を追加。意味判断を置き換える単語辞書・個別設問分岐・規程選択コードは追加していない。

## 検証結果

| 確認 | 結果 | 限界 |
| --- | --- | --- |
| SeedのAPI追加・再投入・全件読取り | 隔離DBで984 inserted、984 unchanged、984の本文/digest/manifestDigest一致 | 本体DBへの投入ではない。正本の再確認や意味抽出ではない |
| 明示した所有domain＋application回帰 | 610 pass / 0 fail、5,563 assertions、80 files | Web・実機器は別。後述の全体verifyとは別の明示ファイル指定 |
| 追加契約/結合 | Scope分離、UTF-8境界、検索結果容量、取り下げ後の引用不採用、旧bundle不変/再seed、有効期間外の計算を確認 | 意味判断の正しさを保証しない |
| 実モデル調査担当 | 984件入り隔離DBで、検索→原文読取り→引用報告の1設問成功、3回のモデル呼出し、約24.28秒 | 親の会話モデルは固定fixture。1設問のみ、coverageはpartial、summaryにd1が残る |
| Worldパッケージ側 | verify 935 pass / 0 fail、17,994 assertions、70 files | v5・公開API・配布物は変更なし |

実モデルの初回は試験診断SQLの列名誤りで結果保存に失敗したため、成功に含めない。次の実行では部分一致検索へ複数キーワードを連結し、資料があるのにnot_foundになった。資料や設問を変えず、連続文字列1つを渡す検索仕様を指示・ツール説明に明記した後、同じ設問で成功した。固有の資料名を製品コードへ追加していない。SHOULDの強さ、収集時資料である留保を維持し、実装が対策済みとは推測しなかった。一般的な精度改善は未測定。

実測は `spec/verification/reports/world-reference-live/before-query-guidance.json` と `result.json`。元Seed本文や認証情報はこの文書へコピーしない。

## 未完了と既存の阻害要因

1. 本体Seed追加は下記の追記で完了。既存DBの移行不整合は修復済み。通常サーバーは `tool:web.lookup@1` の `capability_revision_conflict` で停止する。Web側の定義を今回の作業で変更せず、通常起動・本体会話からの利用受入は未完了。
2. 全体typecheckには変更外の `api/application/workers-ai-settings.test.ts:143` のArtifactListEntry.artifactIdエラーがある。最終確認時には並行変更中の `api/domains/memory/service/curation-evidence.ts:131` のrepresentation型不一致も検出した。今回のファイルの型エラーは残っていない。
3. 全体verifyは成功扱いにしない。Web試験のjsdom生成ファイル不足で起動できず、並行作業による入力変更も検出してinvalidatedになった。試験パスの曖昧指定では別作業の保存fixtureまで拾ったため、最終回帰は実際のファイルの絶対パスを列挙して610件を実行した。
4. AGENTS.md、Memory配布物、vite.config.ts、Memory採用文書などの並行変更は本作業の差分に含めない。前段階ではAGENTSのサーバー操作許可規則により起動を保留。追記段階では利用者の「初期化してもいいからSeed実施」の指示に基づき、投入に必要な起動を実施した。

## 本体起動の問題が解消した後の追加手順

既存の会話・記憶を残し、認証済みAPIへ追加する。Eumenes側でWorldが有効であることを確認する。サーバー操作は別途明示許可が必要。

```sh
# World側。固定manifestを検査してGit対象外へ出力する。
bun eval/seed/export-eumenes.ts data/worldmodel-corpus/seed/v1.json artifacts/eumenes-seed-grok-984-v1.jsonl

# Eumenes側。最初は形式確認、--runで初めてAPIへ書き込む。
bun scripts/world-documents-import.ts /Users/y.noguchi/Code/eumenes_world_model/artifacts/eumenes-seed-grok-984-v1.jsonl
bun scripts/world-documents-import.ts /Users/y.noguchi/Code/eumenes_world_model/artifacts/eumenes-seed-grok-984-v1.jsonl --run
```

APIは既存の認証に従う。POST /api/world/documents は1資料ずつ追加、GETはqueryまたはdocumentId/offsetで検索・読取り、DELETE /api/world/documents/:id は明示的な取り下げ。Scopeは入力不可。通常のSeed手順でDELETEは使わない。新しいWriterや製品DBへの直接書込みはない。


最終差分点検: 試験fixtureを既存規約の `world-research.fixture.ts` へ分離し、移動後の結合26件・118 assertionsを再確認した（意味的な実装変更なし）。SQL境界の全体検査は、変更外のagent-runtime→tool-runtime.tool_invocations参照を検出した。並行変更にはMemoryのSeed APIとagent-runtimeの読取り処理も含まれるため、これらが確定した後に最終統合検証が必要であり、本作業では改変していない。610件の成功はその実行時の状態に対する証拠で、進行中の他変更を含むcheckout全体の受入を意味しない。commit・pushは今回未実施。


## 2026-10-16 20:02 JST 本体Seed投入完了

利用者の「別に初期化してもいいからSeed実施しましょう」を受け、本体DBへ投入した。初期化・記憶削除・設定コピーは行っていない。

- 移行不整合の原因は、適用済み `inference/0009-agent-sessions` へ後からrefs列と索引を追記したこと。追記2文を新しい `inference/0010-attempt-refs` へ分離すると0009は既存DBの記録済みSHA-256 `10de4df6b2de8cda77efb16297b3b6b915c2a372ea975abcd99f8a4c1539e20b` と一致する。DBの移行履歴を書き換えず、既存列・行を保って新移行を適用した。別の0009内容で初期化されたDB全般への互換性を保証するものではない。
- 移行回帰は過去の0009で作ったDBの要求・試行行を保持し、0010追加と再オープンの冪等性を確認。移行・セッション・資料単体・資料結合の5ファイルで **15 pass / 0 fail / 91 assertions**。部分→結合後に実DBへ適用した。
- 通常起動は移行を通過したが、変更外のWebツール `tool:web.lookup@1` の版競合で停止。この障害を消すためのDB初期化はせず、既存の `openStore`（排他writer・全移行）、`createApp`（通常認証）、`registerWorldDocuments`（同じ資料API）、`WORLD_DEFAULT_SCOPE` を組み合わせた一時的なbackendから投入した。localhostの空きポートを使い、終了時に停止・storeを閉じた。CLIは既存インポーターからHTTPを使用し、DB直接書込み・新たな保存処理・制約の無効化はない。
- 対象は本体 `data/eumenes.sqlite3`。Seed `grok-984-v1`、11コレクション、**984 inserted**。同一ファイルの再投入は **984 unchanged / 0 inserted**。
- APIで2,101ページを取得し、**984件すべての本文・SHA-256・manifestDigest・revision・title・collectionが一致**。未認証401、検索による資料発見も確認。投入・再投入・照合は約2.68秒。
- 投入前後で資料台帳以外の220テーブルの全行ハッシュと件数が一致。起動試行前に採取した記憶・会話関連・設定35テーブルの件数も全て一致。本文や秘密を検証記録へ出力していない。
- 実測JSON: `spec/verification/reports/world-reference-live/product-seed.json`。今回の完了は原文資料の保存・参照であり、全件の構造化抽出・自動採用・会話回答の精度改善を示さない。通常起動の競合修復は別作業として残す。
- 差分確認: v5・World本体srcは不変。新しい意味分類・固有例分岐なし。他作業の差分は保持し、全体verifyは前述の阻害要因があるため今回再実行せず、必要な移行回帰と本体API通し検証を行った。commit/pushは未実施。
