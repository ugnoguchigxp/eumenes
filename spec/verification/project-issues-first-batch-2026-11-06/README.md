# 全体課題の第1段階の検証記録

2026年11月6日。[第1段階の設計と作業計画](../../project-issues-first-batch-2026-11-06.md)に対応する。

## EUM005の修正と固定検証

修正前の選択関数はPipelineを0件とし、新しい回帰試験4件は全て不合格だった。明示したapplication結合試験の所有情報と直接importの和を取るように修正し、次を確認した。

| 段階 | 条件と結果 |
| --- | --- |
| 部分・検証計画 | `bun test ./scripts/verification-selection.test.ts ./scripts/verification.test.ts`：18成功、失敗0。明示登録、直接import、重複排除、範囲、欠落拒否、実行計画を確認 |
| 実結合 | `bun test ./api/application/pipelines/pipeline-execution.test.ts ./api/application/pipelines/vendor.test.ts`：2成功、失敗0。既存の子タイマー2件と採用packageの来歴・実体を確認 |
| domain検証 | `bun run verify -- --domain pipelines`：15,187ms、pass。今回修正した2試験が実際に選択・実行された |
| 整合性 | domain検証の入力hashと終了hashは一致。原本の担当4ファイルと固定コピーの内容も一致 |

[結果の要約](summary.json)、[domainレポート](domain-verification-report.json)、[選択試験log](selection-tests.log)、[Pipeline結合log](pipeline-tests.log)。Bun 1.4.4、Darwin arm64。通常のログのように会話本文やcredentialを記録せず、製品DB・秘密は検証コピーに含めていない。

基準はHEAD `3eb6a54032cd54548df299f1a93ec5df2e2bdd64` の前回固定コピーへ、今回担当のscripts3ファイルと検証説明を適用したもの。進行中の保守性改修や、その後に原本へ増えた変更の統合受入ではない。Browser/Memoryの旧サイズ警告2件はコピーでは対象外警告として残り、その別改修を完了と判定しない。

初回の共有フォルダー上の試験では、ファイル指定がBunの検索条件として扱われ、`artifacts`内の旧検証コピーも実行された。新試験のコマンド比較にも `./` prefixの期待値の誤りがあった。対象を固定コピーへ移し、ファイル指定と期待値を正規の実行形式に直して再実行した。最初のdomain検証は今回の2ファイルの整形で停止したため、整形後に最終runを実施した。これらの先行結果を最終合格へ流用していない。

## 振り分けの契約確認

採用Routerへ、合成した「15秒です」という入力、有効な保留候補 `t1.answer`、構造解析の `requests:[]` を渡す純粋な診断を実行した。結果はrow1の会話、採点呼出し0回だった。外部モデル、API、操作先は使っていない。実モデルが常にこの出力を返すという主張ではなく、構造経路へ切り替えるだけでは保留回答の処理を保証できないことの確認である。

同じ担当IDが複数部分の先頭になった場合に単一結果へ進む制約は、採用packageの `route.ts` の `several` と公開型を照合した。意味判断の新方式や失敗時動作を製品へ実装していない。

## EUM006の固定事例

[routing-cases.json](routing-cases.json)に20事例を保存した。既知の検証会話6件と追加の境界8件が調整用、別題材6件が比較用。[内容hash](routing-cases.freeze.json)を先に保存し、結果を見て期待値を変更しない。

候補の選択だけでなく、元の仕事への回答、依頼した操作数、依存する確定結果、未実施の説明、取消/失効後の禁止副作用を観測する。データの構造とID・件数を確認した段階で、Routerのbench接続、実モデル比較、通常会話の通し受入は未実施。既存context-evalはRouterを含まないため、その実行をこれらの受入に数えない。

## 未完了

- EUM001〜003：候補説明の比較と、必要な契約拡張の設計合意・実装・受入。
- EUM004：前段修正後の実モデルによる計画・子実行・最終配送。
- EUM006：固定事例を意味判断の評価経路へ接続し、比較用題材を含む結果を取得。
- 別作業の改修が揃った現版での統合確認。サーバー操作、実接続、実機器、CIは今回実施していない。
