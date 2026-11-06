# 保守性改善のリファクタリング

2026-11-06。調査回答で提示した削除・分割候補について、利用者の「はい。一旦全部実施してください」を実施合意として記録する。編集前の設計・作業計画。本体main、開始時HEAD `3eb6a54032cd54548df299f1a93ec5df2e2bdd64`。

## 目的と非目標

既存の動作を維持し、不要な公開口を削除し、肥大化したモジュールを既存の責務に沿って整理する。LLMのSystemContext・利用情報・道具・共通実行機構は調査済み。今回の問題は意味判断ではなく配置・結合であり、既存の指示と実行機構をそのまま再利用する。新しい分類・優先順位・fallback・retry・権限判断・抽象基盤・依存は追加しない。

HTTP/API・packageの使用中の公開契約、DB schemaと適用済みmigration、単一writerとtransactionの範囲、処理順序、世代/失効/承認検査、取消後の不採用を維持する。設定・製品DB・稼働サーバー・他チャット・コミット/ブランチは操作しない。着手時からあるpipeline設計書とlive記録の差分は対象外。

## 単位・配置・依存順

1. 不要なbrowser/inferenceの再export4件、未使用型2件を削除。試験が使う公開口は保持。
2. Memoryのjournal復旧を同domainの専用moduleへ移し、利用記録SQLをrepositoryへ移す。現行のforget/ledger/backfill/windowsを注入し、復旧内の単一transactionと再適用順を維持。
3. Interactの観測状態または操作送出を同domainで分離。既存approval/captureを使い、送出前commit・最後の権限検査から送出までの非await・結果不明時の停止を維持。
4. cloud-agentsをSDK別の実装と共有入出力へ分離。現在の入口からの使用中exportを維持し、認証・セッション・stream・usageの変換内容を移動だけで保つ。
5. Agency hostから会話の寿命管理とfeed処理を分離。既存runtime/checkpoint/deliveryを使い、状態正本・世代・cursorを二重化しない。
6. 音声controllerの録音入力と再生、voice hookの送信待ちと再生追跡を分離。既存machine/chunk-playerと参照を共有し、取消・開始停止・割込みと再生確認を維持。
7. light-avatarの形状/material生成と描画制御を分離。遅延読込みと資源所有/解放、公開APIと描画結果を維持。
8. attitude-datasetのSQLを同domainのrepositoryへ移し、収集実行とレビュー/exportを分離。既存のprivacy/schema/splitとepoch/採用契約を維持。
9. Artifact UIの共通useActionと画面部品を分離し、collection/service-test/ui-studioもフォーム・表示・組立てで整理。共通runtime/receiptと公開view登録を維持。
10. MCP driverを接続/通信と操作変換・読取り・replayへ分離。driver契約と切断・取消処理を維持。
11. settings-adapter試験、settings Web fixture、voice settings結合試験を主題別に分割。試験の本文・期待値・cleanupの独立性を維持する。

各単位は既存domain内/既存application内の配置変更。UI文言・LLM指示・bundleの変更はしない。未使用引数は位置契約を維持できる箇所だけ整理する。

## 検証と完了条件

着手前の既存試験とサイズを採取。単位ごとに編集を止めて部分試験・型検査を実施し、結合試験、対象domain verify（memory/browser/inference/dialogue/audio/voice-dialogue/attitude-dataset/artifact/settingsと実際の利用側）へ進む。サイズ予算を増やさず、MemoryとInteractの既存違反を解消する。試験期待値と失敗条件を緩めない。

WebGLはサーバー起動を伴わない消音ブラウザー/ルートfixtureで確認する。サーバーを起動するE2Eは無許可で実行しない。外部Providerと本人の機器による受入は今回のfixture検証と区別し、未実施を明記する。

完了は全11単位の整理、必要な検証、差分レビュー、LLM判断の代替や個別例依存の追加がないことの点検と記録が済んだ時点。3ラウンドごと、または根拠のない反復時に進め方を評価し、観測結果と次の一手を会話内で通知する。

## 進捗

- 全11単位を実装済み。未使用公開口4件・型2件を削除。位置契約を持つ未使用引数を明示し、未使用変数の束縛を削除した。
- 変更前: API 1,102件、Web 208件成功。部分検証: Memory/Browser/Inference 596件、Agency/Browser 344件、Dataset 18件、Artifact UI 335件、設定/音声 API 124件、設定Web 54件、音声Web 143件、Avatar Web 11件成功（重複あり）。
- 分割した設定33件・音声30件の試験本文と、DatasetのSQL21種類は変更前とtoken/文字列で一致。
- Avatarは9 WebGL画像・描画統計・当たり判定が変更前後で一致。3回の作成/破棄でcanvas/geometry残留0、pageerror 0。消音した画面なしブラウザー、サーバー起動なし。実描画で発見したprofile受渡し漏れは修正後に再確認した。
- 共有作業木で検証選択script/domain登録の別改修が進行し、検証scriptの型エラーが一時発生。稼働中のAPI/Webを停止せず、開始時HEAD+今回の85コードファイルから固定コピー `/tmp/eumenes-maintenance-verify-20261106` を作成。依存workspaceもコピー内へ接続し、ビルド出力を共有しない。製品DB/保存設定/秘密はコピーしていない。
- 固定コピーのlint・整形・サイズ検査、23domain verify、内部公開口整理後の3domain再検証、差分レビューまで完了。今回の93コードファイルは最終検証コピーのSHA-256と一致する。

## 完了記録

全11単位を実施し、実施者による差分レビューと必要な再検証を完了。独立した他担当によるレビューは実施していない。変更は未コミット。

分割後の未使用解析で、内部adapter・UI入口の再exportが試験だけの利用として検出された。同domainの試験を担当moduleのimportへ移し、不要な再exportも削除した。HTTP/domainの使用中の公開契約は維持している。残るknipの3件（toolchainPassages・INPUT_HEADINGS・SourcePort）は当初の調査どおり試験/fixtureで必要な公開口であり、削除していない。未使用file検出は0、追加の未使用ローカル/引数検査は0。

| 検証 | 最終結果 |
| --- | --- |
| 23domain verify | 成功。API 2,808件、Web 525件、DesignSystem 90件、計3,423件 |
| 内部公開口整理後のbrowser/inference/artifact verify | 成功。API 864件、Web 126件、DesignSystem 58件、計1,048件。前の検証との重複を含む |
| 型・lint・整形・domain境界・SQL境界・SystemContext・domain索引 | 両verifyで成功 |
| 入力・共有出力の整合性 | 両verifyのintegrityErrorsは0。原本DesignSystemの出力hashも前後で一致 |
| サイズ | 成功。既存予算の引上げなし。検査対象の800行超fileは1→0、1,000行超test/fixtureは3→0。300行超関数は23→21（既存の組立て関数を含む）。現行検査がJS/CSSを除外する点は変更なし |
| 適用済みmigrationのGOLDEN | 17件成功。SQL/checksum/順序の期待値は変更なし |
| 分割した試験 | 設定33件・音声30件の本文tokenが変更前と一致。fixtureのcleanupはファイルごとに登録 |
| Dataset SQL | 21種類のSQL文字列が変更前と一致。32箇所の呼出しをrepositoryへ移動 |
| Avatar JS本体 | 宣言ファイルに隠れない直接checkJs検査が成功 |
| Avatar WebGL | 最終コードでも9画像・統計・当たり判定が変更前後で一致。3回の作成/破棄、残存canvas/geometry 0、pageerror 0 |
| Web production build | 成功。新しいmodule/worker/assetの解決を確認 |
| bundle:check | **変更前からの既存超過を同条件で再現**。entry gzip 189,738→190,320 B、initial gzip 336,595→337,177 B。今回の増分582 B（initial約0.17%）は変更前比の既存2%許容内。保存済み予算112,035/259,653 Bは変更せず、既存超過は未解決として残す |

検証の正本は [summary.json](verification/maintenance-refactoring-2026-11-06/summary.json)。23domainと最終3domainのreport、code SHA-256、SQL/試験の一致記録、描画比較、bundle比較も同じディレクトリに保存した。23domain run `2026-11-06T08-22-41-114Z-65e74de6-1239-4005-8af6-60db9aa810f7`、最終3domain run `2026-11-06T08-30-11-852Z-8e509732-6684-48b0-b73d-c901f1d958f0`。

### 差分レビュー

- Memoryのhealthy状態・journalBlocked・writerを共有し、復旧/忘却/失効の順序を維持。利用記録SQLは同domain内へ配置した。
- Interactの観測と世代は一つの所有者が持つ。操作の保存→最終権限確認→送出、結果不明の停止、承認の一度だけの消費を維持。
- AgencyのactiveId/cursorと会話Map/inflightを共有し、起床・撤回・復旧・破棄を既存runtime/checkpoint/deliveryで実行する。新しい正本やスケジューラーは追加していない。
- SDKの認証・session・stream・usage、MCPの固定tool/操作変換・直列化・切断を移動だけで保持。profile/model/接続先を追加・固定していない。
- 音声は既存machine、session token、upload tail、playback epochを共有。React側が副作用を所有し、追跡処理は通常の関数として呼ぶ。再試行・割込み・取消・再生確認の条件を維持。
- Artifactのview/event/receiptと画面文言、Avatarの数式・shader・乱数順序・GPU資源所有を維持。
- SystemContext、LLMの意味判断、個別発話への条件分岐、権限、優先順位、fallback、retry、DB schema/migration、bundle登録、依存packageの変更は追加していない。検査設定・サイズ/配信予算・試験期待値は緩めていない。
- 担当外の計画書、検証選択script/domain登録、検証記録の変更も差分一覧で確認し、今回の検証スナップショットから除外した。他チャットへの送信、原本サーバーの停止/起動/再起動、製品DB/保存設定の操作は行っていない。

fixtureと消音したWebGL確認までを検証済みとする。サーバー起動を伴うブラウザーE2E、実Provider、本人のマイク/スピーカーによる3往復受入は未実施。既存の音声MVPや全体システムの完成を今回の結果だけで宣言しない。今回のリファクタリングの残作業はなし。配信予算の既存超過は別の性能改善課題として残す。

Context MCP: 今回の実装分はcontext_compile 1回、compile_eval 1回。先行調査を含む会話累計は各2回。

## コミット前の統合確認

利用者の「すべてをcommit、pushしてよい」という承認に基づき、並行作業分を含む全変更をまとめる。統合した作業木の型検査で、試験選択用Setが登録済み2パスのliteral型に推論され、一般のstringを渡すhasで失敗した。`scripts/verification-selection.ts`に`Set<string>`を明示し、実行時の処理と試験期待値は変更していない。

補正後の全体型検査は2,955ファイルで成功。関連するverification-selection/verificationの18試験は、ローカルの過去検証コピーを含まない固定コピーで成功した。原本での同試験は過去コピーを試験候補として拾ったため14成功・4失敗だった。検出対象やtimeout、期待値は弱めていない。結果は`commit-selection-tests.log`と`summary.json`のcommitPreparationに保存した。

この型補正のContext MCPはcontext_compile/compile_eval各1回。先行調査・実装を含む会話累計は各3回。


コミット時点の全変更を`23fafa8a`としてmainへpushした後、並行作業のRouter更新が追加された。利用者の全変更commit/push承認の範囲として追加分も取り込み、型検査・生成catalogの鮮度・配布物照合を確認した。更新中の原本ではRouter試験2件が失敗したが、その後の最新ソース・配布物を固定したコピーでは27件成功・0件失敗だった。確認後の114コード/package入力のhash一致を確認し、実装や試験期待値はこのcommit作業側で変更していない。結果は`commit-router-fixed.log`に保存した。
