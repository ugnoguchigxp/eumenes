# Eumenes Pipeline p0-3 取込み・旧実装撤去

2026-11-05。利用者は検証済みライブラリの本体取込み、既存パイプラインツールの置換、レガシー実装削除を依頼した。本書は編集前の実装境界と受入を記録する。元の合意はeumenes_pipelineのplan §3/§7と本体接続案。旧2026-10-22方式は以下へ置き換える。

## 目的・範囲・完了条件

会話の一回の依頼を、公開された部品の1〜8手順と明示参照・最終配送へLLMが計画し、既存agent-runtimeで順に実行する。定義の正本はrequest/steps/outputだけ。元依頼はホストが保持し、モデルによる改変を拒否する。再利用テンプレートの登録・公開・入力展開は廃止する。

mainで作業する。本体とpipeline配布物の接続、関係するcapabilities/dialogue/agent-runtime/pipelinesと旧UI・client・試験の撤去を対象とする。実装コードの削除は今回の依頼範囲。利用者データや過去revisionの削除は行わない。サーバー操作、CI、他チャット送信、モデル名の固定、新たな有料API試行は含めない。

完了は、取込みchecksum一致、実際の会話入口と既存launch/adopt/noticeへの接続、旧実行経路とUIの参照残り解消、固定試験・関係domain検査の成功で判断する。live/UIの実機確認は固定試験と分けて報告する。

## 接続と再利用

| 接続 | 正本と変更 |
| --- | --- |
| 会話→パイプライン | 新しいデータドリブンbundleの単発実行入口。複数作業をpipelineへ渡すRouter判断も元依頼全体を渡し、一手目だけ実行する暫定処理を削除 |
| 部品情報 | ホストの実行可能カタログをComponentRecordへ写す。正確な公開ID、revision、型付き引数、権限・実行種別。内部Skillや秘密は渡さない。pipeline/task/sessionの再帰・対話入口は部品にしない |
| 計画 | bundleのprofile/skillを安定した指示、原文・資料・カードを実行時データとして既存inferenceへ渡す。設定済みLARM/クラウド経路を使い、provider/model固定なし |
| 検査 | vendorのauthoringOutcome/checkDefinition/createCatalogView。readyだけ実行。needs_inputは既存質問状態、unsupportedは未達として返す。構造不備の修復は一回、意味の別判定ループは追加しない |
| 実行 | 既存agent_executionsの親状態とqueueを使う。ExecutionPlanを保存し、ops.launch/adopt/cancelと既存child portへ接続。Bun用bench driverは製品へ持ち込まない |
| 参照と配送 | fromの先行手順の確定結果とホスト発行参照だけを子へ渡す。output.fromで指定した結果だけを最終提示へ渡す。receiptを成果物完了と取り違えない |
| 版と失効 | 計画時の部品revisionを保持。dispatch時に権限・有効性を再照合し、失効・版変更なら停止。取消・期限・忘却後の結果を採用しない |
| 観測 | 既存TODO/実行照会/通知を使い、計画と手順の状態を保存する。新たなUI・実行台帳・サーバーを作らない |

## 旧実装の削除

旧formatVersion1、inputs/default/quote、文字列展開、extract値抽出、fixture入り定義、公開用bundle生成とprobe/select、旧制作・素材接続画面、旧client APIとその専用試験を撤去する。既存のschema・定義revisionを同じID/版で書き換えず、新しい登録版を使う。古い保存revisionは実行対象から外し、新契約へ暗黙変換しない。既存の実行中旧pipelineは停止扱いとし、新形式として再開しない。適用済みmigration SQLは不変で保持する。

## 実装・検証の依存順

1. 旧経路の固定試験を採取、checksumを照合してvendorを導入。
2. 部品カタログの写像・公開契約と新bundle、LLM指示を準備。
3. 既存親実行に計画と固定順序を接続。参照・配送・質問・取消・期限・重複・再起動を検査。
4. 会話から新経路へ接続し、旧経路・UI・APIを撤去。既存DB seedからの更新も検査。
5. 部分→API結合→関係domain（pipelines/capabilities/tool-runtime/agent-runtime/dialogue、UI削除の利用側）を検証。途中の検証中は実装を編集しない。

## 実装・検証結果

2026-11-05。上記1〜5の実装と固定試験を完了した。依頼時の本体はmain/e917e920。配布物は0.0.0-32f778cb14b4、SHA-256 `9ba750c488610ad39d280931e861e6d8fb6a6e44f118ce5900cb80ce8fcc62c9`。archive・manifest・lock・導入済みruntimeを照合した。版の差替えや製品DBの直接編集は行っていない。

- `pipeline.execute` / `binding:pipeline.execute@2` / `adapter:pipelines@2` を登録。公開カードの型付き引数は既存routingの提示契約を再利用し、部品の内部profile/skillを計画入力へ混ぜない。出力schemaがない完了結果はpartial supportとして正直に記録する。
- 元依頼、資料、回答を実行時データとして既存inferenceへ渡す。新たな接続先・モデル名・資格情報・有料API呼出しを追加していない。計画・一回の構造修復・不足質問・unsupportedから既存親子実行へ接続。
- `from:request` は最初に受け取った参照を正確に保持し、先行手順は確定結果の参照だけを渡す。リテラル引数と期待結果を子へ渡し、最終結果の参照・リンクは `output.from` に限定する。取消、忘却、失効、版変更、容量超過、旧契約の再開を拒否する。
- pinned Routerは複数作業を `route(): row=9/run/partial`、`routeStructured(): to=pipeline` の二方式で返すため、この外部契約だけをホストで同じ計画入口へ接続した。個別の発話や語句を使う判断分岐は追加していない。
- 旧定義・入力展開・値抽出・制作/公開/試運転API、旧client・Web adapter・Artifact・DesignSystem画面・専用試験・SystemContextを撤去。適用済みmigrationと利用者の履歴は保持する。

| 検証 | 結果・根拠 |
| --- | --- |
| 旧経路の着手前試験 | 修正した範囲指定で32件成功。`baseline-scoped.log` |
| bundle登録 | issueなし。`bundle-check.log` |
| 新旧契約の移行・二度目seed・配布照合 | 成功。`seed-vendor.log`。旧binding本文を保持し、新契約として実行しない |
| 親実行 | 14件成功。`runtime-final.log`。1/8手順、原文改変拒否、一回修復、質問と子の質問再開、失敗、取消、参照、忘却、容量、版変更、重複を確認 |
| 会話から実際の操作・TODO・通知 | 成功。`application-final.log`。モデル出力だけ固定し、登録済みtimer操作を二つ実行。旧APIは404 |
| 関係domainのverify | pipelines/capabilities/tool-runtime/agent-runtime/dialogue。API964件・Web32件、型・境界・SQL・size・lint・整形・SystemContext・DesignSystem型とbuildが成功。`selected-verification-final/report.json` |
| Artifact利用側 | 16ファイル335件成功。`artifact-ui-final.log` |
| 最新の共有作業フォルダ | パイプライン14件＋会話結合・配布照合の計16件成功。`combined-pipeline-final.log`。全体型検査は2,848ファイルの時点で成功（`combined-typecheck-final.log`）。一時的に別作業のbrowser連携の型エラー1件を検出（`combined-typecheck-signoff.log`）。その作業側で戻り値の型が更新された後に再検査し、全体型検査も成功（`combined-typecheck-signoff-after-browser-update.log`）。SystemContext鮮度は成功（`combined-context-signoff.log`） |

記録は [spec/verification/pipeline-p0-3-2026-11-05/](verification/pipeline-p0-3-2026-11-05/) に置く。最終verifyは、開始時HEADへ今回の差分を写した独立コピー `/tmp/eumenes-pipeline-host-verify-20261105` で実施した。共有フォルダではbrowser/memory/collaboration等が同時に編集されており、それらを上書きしたり、今回の検証結果へ混ぜたりしていない。共有ファイルの追加変更と検査対象のhashは `ownership-and-hashes.json` に記録した。検証コピーの範囲外にある既存kanbanの依存警告5件は、そのまま警告として記録される。

途中のブラウザー承認試験の失敗は、検索候補に新入口が増えて試験が選ぶtask.executeが候補から外れ、承認処理へ到達しなかったもの。変更前の成功・変更後の失敗・候補とtraceを記録したうえで、試験用検索の対象を明示した。承認・期限・一回の実行の期待値は維持し、製品にシナリオ用の分岐は追加していない。修正後は承認試験2件と最終verifyの両方が成功した。

## 共有作業中の型エラーの扱い

全体型検査で、一時的に別作業のbrowser/interact追加による `api/application/toolchain/toolchain.fixture.ts:766` の `browser.interact` の型エラー1件を検出した。当方はこの追加を修正・削除していない。その作業側でHarnessOptionsの戻り値の型が更新されたことを確認し、条件が変わった後に一度再検査して成功した。独立コピーでの関連領域検査と、共有フォルダ全体の最新型検査は別の結果として記録する。

## 残る実環境確認と配置状態

固定試験までの取込み・旧実装撤去は完了。サーバー起動/停止/再起動、稼働中サービスへの切替、実LLM/LARMと実機器による受入、CIは実施していない。実環境の切替成功までは主張しない。変更は本体mainの未コミット差分として保持し、同時作業分をまとめたcommit/pushは行っていない。旧branch 9101985は存在しない前提を利用者了承済み。
