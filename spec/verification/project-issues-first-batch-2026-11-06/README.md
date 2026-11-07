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

## 続行分の最終検証（2026-11-06）

**同日の利用者訂正。** 既存の通知ダイアログと完了音で気付けるため、会話エージェントの完了報告も、結果通知の追加・改善も今回の対象外とした。EUM003の追加案は撤回済み。以下の測定結果と固定事例は当時の記録として保存し、通知の改善を行わないことを理由に実行漏れを合格へ変更しない。次の受入は仕事の実行件数・引数・状態と質問回答の配送を対象にする。

上の「未完了」は初回実施時の履歴。現在の結果は[第2段階要約](second-batch-summary.json)と[設計・残作業](../../project-issues-first-batch-2026-11-06.md)を参照する。

| 対象 | 現在の結果 |
| --- | --- |
| 案A | 固定20件×変更前後、40回取得。配送先の改善0、既知6件未解消で不採用。[比較](description-comparison.json) |
| 案Bのpackage | 0.0.2、route4/structure2。102成功、skip/失敗0。shaと元のdirty差分をvendor/routerへ固定 |
| 案Bのhost | 同じ質問/仕事の再開、混在の確認、参照捏造、モデル失敗、Pipelineの全stepの実行可否を検査。最終domainにも含む |
| 実モデル | 保留質問を正しく渡した測定は20件、判定取得14、15秒の時間切れ6。これは正解率ではない。取消誤配・同一担当2操作の確認止まりなどが残る。[結果](structured-comparison.json) |
| 先行失敗 | 設定validの参照先不備と、保留質問を渡していなかった測定をpreflight/missing-pendingへ分離。品質の合格へ流用しない |
| 復元演習 | 20検査成功。ダミーDB/鍵、credential、未着手job、WAL/SHM、古いDB＋最新forget journal、欠落/別鍵・未知migrationを確認。[log](restore-tests.log) |
| 部分/選択/結合 | 固定コピーで6成功。root直下の試行では無関係なartifactsの走査で選択試験が時間切れになったため、入力の小さい固定コピーへ移した。timeoutを引き上げて通していない。[log](selection-and-restore-tests.log) |
| 最終7domain | API1,198、Web32成功、136,623ms。型・境界・整形等も成功。[report](domain-final-report.json) |
| 整合性 | 最終入力hashと終了hashが一致、integrityErrors0。原本コードとコピーの照合は差異0、原本DesignSystem出力hashも前後一致。[照合](final-input-integrity.json) |

コピーの準備ではGit参照、各workspaceの依存リンク、整形が不足した回があった。同じ整形前コピーを再実行した1回も失敗のまま扱う。修正後の最後の7domain結果だけを最終の受入に使う。各workspaceのローカル依存はコピー側を向け、生成物の出力先を分離した。新branch、製品DB/鍵のコピー、サーバー操作、他チャットへの送信、CIは行っていない。

### EUM007/EUM009の既存ログ照合

[performance-log-summary.json](performance-log-summary.json)は既存の合成検証runを読み取りで集計した。共有するsubject名での結合は無関係な回へ広がるため使わず、UUIDのrun/job/inference/attemptだけを関連付けた。短い確認は記録上82.814秒の区間で、provider span8件、重複する時間を除いた区間71.756秒。provider区間は推論・SDK・委任等を含み、純粋なモデル計算時間ではない。spanの単純合計を待ち時間と扱わない。非同期の長考ownerは同じIDの連結だけでは全体を取れておらず、その部分は不完全と明記した。費用やtokenを推測で0へ補っていない。改善の受入ではなく、次の原因調査の根拠である。

2026-11-06 続行分: [live-continuation](live-continuation/README.md)に、回答/取消・同担当二操作・計算snapshot・厳密出力の接続修正、現在のRouter契約7/5・指示v8、部分41件と7domain/API1243・Web37・DesignSystem4の成功、通常会話の親子実行、未達条件を分けて記録した。保存設定の恒久切替・意味品質全体の受入は未完了。
