# 未使用コード削除と解析処理の共通化

2026-11-03。利用者の「未使用コードを削除、重複実装を共通化し、verifyとコードレビューまで行う」という指示を、追加調査で示した範囲の実施合意として扱う。実装前の設計記録。

## 目的・範囲・完了条件

前回の追加調査A1〜A5を整理し、B1のLARM接続解放、B2のOCR/物体認識の解析実行・HTTP・gateway通信を共有する。既存のLLM指示・道具・queue・LARM公開操作・単一writerを再利用し、LLMの判断・モデル選択・外部API・エラーコード・期限・再試行・優先順位は変えない。

routing・interact・pipeline、Memory実行参照、journal/backfill、DB migration、設定、サーバー操作、他チャット、他の作業差分は対象外。新しいdomainやtier変更、新ライブラリ・汎用プラグイン基盤は導入しない。

完了は、必要な削除/共通化、部分→結合→対象domain verify、コードレビュー、最終差分点検が済んだ時点とする。途中の試験実行中は編集しない。

## 解析処理の配置と依存

| 場所 | 責務 |
| --- | --- |
| 各domainの`repository/analyses.ts`と`service/analyses.ts` | SQL、資料の認可・会話対応、revision/digest/frameの検査、分析行の読書き。既存のdomain固有処理を保持 |
| `infrastructure/media-analysis.ts` | DB接続を借りて行う保存操作・分析サービスの型付きI/O契約。domain/applicationをimportしない |
| `application/media/analysis*.ts` | 両domainが既に使うqueue/PerceptionPortの実行組立てを一つにする。保存操作を注入し、SQLを持たない。分析開始、phase記録、取消、空き待ち、結果採用、復旧を既存順序で実行 |
| domainのconstructor | 分析サービスを組み立てるfactoryを受け、自domainの保存操作を渡す。applicationをimportしない。分析なしの構成は従来どおりnull |
| `infrastructure/media-analysis-http.ts` | 既存のHTTP登録、本文/クエリ検査、mask本文の省略、画像配信。入力schemaとサービスを注入。認可はサービスが行う |
| `infrastructure/media-gateway.ts` | 既存gatewayの有界HTTP/JSON通信のみ。capacity拒否検査は注入、業務schemaはdomainに残す |

source digestはOCRと物体認識で違う（後者はcaptureSaveを除外）。この差はdomainに残す。表名を共通側へ渡してSQLを生成する方式は採らない。root/APIパス、scope/job kind、各保存操作は登録データとして渡し、利用者の発話や個別対象で分岐しない。

既存の`imageForInput`、`settleCapacityWait`、`createQueue`、`PerceptionPort`、HTTP検査を再利用する。domainの所有権・source/settings版検査、queuedの空き待ち復旧、取消後の解放/停止観測、結果不採用を維持する。新しいfallbackや判断順序は追加しない。

## 他の整理

- 調査済み公開口6件と旧Dots receipt2操作を削除。旧行の消去・migration・保持量triggerは維持。
- Goals/Continuityの本番未使用ラッパーは試験fixtureへ移し、既存のscope/revision/再送/transaction試験を維持。
- World旧Slice usage検証は試験helperへ移し、配布パッケージの失効/版指定Slice受入を維持。現役のclaim採用検査と旧行の消去は維持。
- rootのCodex SDKとdots-mcpのcoreの直接依存宣言を削除。他workspace/通常dependencyから必要な同版は残す。lock以外の依存更新やpostinstallは行わない。
- LARMの`stopUsing`/`releaseConnection`を同domainの小さいmoduleへ移す。lease管理方式は変えない。

## 作業順と検証

1. 未使用操作・試験fixture移動・LARM解放共有・依存宣言を整理。型検査と関連部分試験を実行。
2. 解析の保存adapter、共通実行、HTTP、gatewayを接続。両domainの既存analyses/capacity-waitとAPI結合試験を実行。source削除・設定変更・取消・復旧・直列実行・認可・mask配信を維持。
3. `bun run verify -- --domain world --domain steward --domain tasks --domain dots --domain goals --domain continuity --domain larm --domain ocr --domain object-recognition --domain inference --domain codex-tasks`。利用側とrunner/MCPの明示試験も確認する。
4. 差分をレビューし、特にdomain境界、SQL所有、transactionの範囲、取消後の結果不採用、fixtureへの移動による試験の弱体化、対象外変更を点検する。指摘は修正と再検証を終えて記録する。

ブラウザE2Eは各specがサーバーを起動するため実行しない（サーバー操作の個別許可はない）。HTTP結合/Web部品/既存domain試験と区別して記録する。外部仕様や表示は変更しないためlive・実機器受入は省略する。全件verifyを使わず対象domainを選び、担当外の失敗を変更して通さない。

## 実装と部分検証（verify前）

1・2は実装済み。Goals/Continuityは本番ラッパーの移動に伴い、不要になったstore引数も削除した。clock/idの位置を維持するため呼出しを型付きで更新し、試験用factoryは自分のstoreを保持する。domainをまたぐ試験用factoryの組立ては`application/world/state-services.fixture.ts`に置き、既存の境界規則を変更していない。

LARM解放を共有し、解析の実行・HTTP・gatewayを共有した。source digestの計算は生成時の読取りまで遅延し、list/getで媒体全体のhashを余分に計算しない。移動前後の保存SQLは両domainそれぞれ9種類で同一。schema/migrationは変更なし。

既存の解析API結合試験を強化し、両domainが同じrequestIdを使っても保存先が混ざらないことと、共通resourceの直列実行を確認した。旧Dots receipt専用試験1件以外の試験・期待値は削除/緩和していない。

部分検証は型・境界・サイズ・SQL境界・lint成功。対象を明示した結合試験は335件成功（46ファイル、API/両domain/Goals/Continuity/World/runner/MCP）。最初の広いパスfilterによる実行は保存済み過去ログ内の4試験を誤って拾い、読込失敗した。`./`付きの対象パスへ限定した実行を採用し、過去ログは変更していない。

## 完了記録

1〜4完了。未コミット。今回の製品コードは562行削減（追加した共通moduleを含む差し引き）。使用中の旧行の消去・journal・backfillとmigrationは維持している。

| 検証 | 最終結果 |
| --- | --- |
| 14domain verify | 成功。world・steward・tasks・dots・goals・continuity・larm・ocr・object-recognition・inference・codex-tasks・memory・voice-dialogue・live-voice |
| 静的検査・型・DesignSystem build | 全工程成功。範囲外警告0件、入力/共有出力の整合性エラー0件 |
| API/domain試験 | 1,603件成功 |
| Web試験 | 101件成功（18ファイル） |
| DesignSystem試験 | 10件成功（2ファイル） |
| verify試験合計 | 1,714件成功、失敗0 |
| 個別の結合・runner・MCPを含む部分試験 | 335件成功。上のdomain試験との重複を含む |
| 未使用export/types | 対象範囲の検出0。対象外routing exportの`ExportCard`1件により、全体の`deadcode`は終了コード1 |
| 追加の未使用ローカル/引数検査 | 着手前と同じ9件。今回の変更による追加0件。主に除外領域や既存試験の引数で、解析設定は緩めていない |

成功run: `2026-11-03T14-31-42-902Z-f409a0fb-a4b6-4226-a04a-17f163d0be32`。ローカルreportは`verification-reports/runs/<runId>/report.json`、ログと成功reportの控えは`/tmp/eumenes-cleanup-implementation-20261103/`にある。

最初のverify（`2026-11-03T14-28-40-023Z-6cc75761-1421-44fb-b66c-6c789664ba90`）は、Memoryの復元試験のfixture移行漏れ1件で失敗した。復元後のサービスにも試験factoryを使い、不足を隠していた`as MemoryHarness`を削除した。専用8試験の通過後、同じ14domainを再検証した上記成功を最終結果とする。試験の期待値・忘却/復元の要件は維持した。

### コードレビュー

verify完了後、実施者が差分をレビューした。未解決の要修正指摘はない。特に次を確認した。

- 共通handler/serviceを変更前の実装と比較し、scope/kindと保存操作の注入以外に、期限・再試行・phase順序・取消後の不採用・復旧を変えていない。
- 各domainの認可・会話対応・revision/digest/frame検査を維持。物体認識のcaptureSaveをdigestから除く差も維持。list/getで不要な全媒体hashを増やしていない。
- 両domain各9種類のSQLは変更前と同一。共有application/infrastructureにSQLや資格の保存・新しい意味判断を置いていない。既存の単一writer内で保存する。
- HTTPのschema・所有者/会話検査・mask省略/配信・キャッシュ禁止ヘッダー、gatewayの有界読取り・status/id検査・capacity拒否の取扱いを維持。
- LARM解放のPromise共有・DELETE許容status・body破棄・失敗時の再試行可能化を維持。接続種別ごとのlease方式は変更していない。
- 本番から外したGoals/Continuity/Worldの試験はfixtureへ移動して維持。削除した試験は、旧Dots receipt APIだけを試す1件。両domain同一requestIdの分離を既存API結合試験へ追加した。
- routing/interact/pipelineの本体・LLM指示・bundle・migrationは変更なし。関連する試験/fixtureでは、不要store引数の削除と解析factory注入の組立てだけを更新した。
- 依存lockの差分は不要な直接依存宣言2行だけ。解決済みパッケージの版や他の依存、install scriptを変更していない。
- 着手時の他作業の差分を保持。別作業の`spec/README.md`は作業中にも更新されたため、今回編集せず最新の状態を残した。調査中に追加された別設計書も変更していない。個別語句・対象への専用分岐、LLMの判断を置き換える処理、新しいfallbackは追加していない。

ブラウザE2E・live・実機器受入は上記理由により未実施であり、成功に含めない。今回の残作業はなし。
