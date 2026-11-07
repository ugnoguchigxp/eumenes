# 実行漏れ・回答誤配・取消の続行検証

2026-11-06。利用者は検証に必要な再起動と一時的なRouter設定切替を許可し、その後に取消先の有限参照を追加する設計へ合意した。CIは実施していない。会話エージェントの完了報告・通知改善は対象外で、既存通知を変更していない。

## 再現条件

保存済み接続・catalog・学習済み記憶を使った。接続先・profile・モデル名・credentialをコードやファイル名へ固定していない。判定比較は既存domainのreadonly操作を使い、推論要求の状態だけRAMへ保持した。通常会話の検証はAPIと `chat --json --conversation <検証ID>` を使用した。合成会話の台帳読取りも既存domain操作を再利用し、SQLを外へ複製していない。

通し検証中は入口を `routeStructured`、構造解析上限を30秒へ一時変更し、各操作のfinallyで元の `route` / 8000msへ戻した。保存済み構造資源はnullのまま、会話経路を使用した。30秒の測定成功は保存済み8秒の品質・遅延予算を満たす証拠ではない。

## 判定比較

既存20件は `../routing-cases.json`、SHA-256 `64909a5f9bde7c5752bb0788401c94c696b0a0367d06ae6ebfbedef13b1a5077`。追加9件は [cancellation-cases.json](cancellation-cases.json)、SHA-256 `98ed3faa07f23f065737146f1fa1315ce264fa43fa1f634da07412f36df87747`。期待条件は変更していない。初回は調整用と未使用題材を分けたが、繰返し測定後の比較用6件を新たな未使用題材と呼ばない。判定取得数を正答数・実行完了数へ読み替えない。

指示v3〜v6のJSON失敗と意味判断の退行、low/medium比較は各JSONにそのまま残す。これらはcaptureの厳密出力flagが未接続で、呼出し側のschemaがproviderへ渡っていなかった。回答に限定したschemaの送信確認、root unionの拒否、object内unionの成功を別のprobeへ記録した。回答だけに限定したprobeは意味品質の採点へ含めない。生のprovider応答をログへ保存せず、形式・全文一致・参照の検査結果だけを記録した。

| 条件 | 判定取得 | 観測と未達 |
| --- | --- | --- |
| v7、厳密出力、low、30秒、固定20件 | 19/20、timeout 0 | 既知6件は期待経路。話題変更と複数質問をanswerへ誤配。新話題も旧質問へ誤配。同担当比較例は原文検査で停止。中央値5621.5ms、最大10560ms |
| v7、追加9件 | 9/9 | 曖昧な取消を一覧先頭へ割当て、取消の相談をanswerへ誤配した |
| v8、追加9件 | 9/9、timeout 0 | 曖昧な取消は確認、取消の相談は会話、明示取消2件と別分野は提示先へ配送した。話題延期＋独立した新依頼では余分な確認が残った |
| v8、厳密出力、low、30秒、固定20件 | 19/20、timeout 0 | 既知6件、話題変更、複数質問、混在、下書きは期待経路。同担当比較例は原文検査で停止。新依頼だけ明確な比較例は余分な確認となった。中央値5777ms、最大7927ms |

[v8の原文検査probe](span-contract-probe-v8.json)は同じ入力が有効な二操作になる別観測であり、先の失敗の取消・成功への上書きには使わない。応答のばらつきが残っている。

## 通常会話から実行した結果

以下は既知の例文へ担当を固定指定せず、実モデルの選択・計画・実操作を通した観測である。各 `*-ledger.json` に元TODO、親子ID、引数・結果と確定状態を残す。

| 事象 | 修正前 | 修正後の観測 |
| --- | --- | --- |
| 同じ担当にタイマー2操作 | 10秒と25秒の依頼が一件となる。構造v3で二件を認識後も計画Skill1が子一件へ再統合し、10秒だけ開始した | 計画Skill/package/toolchain2で別々の子2件を作り、10秒と25秒をそれぞれ一回開始。親 `f4024de3-ade0-401f-a3b4-f04c2060c773` completed。`same-tool-plan2-ledger.json` |
| 質問への命令形回答 | 構造v2で別Pipelineを作り、元は待機した | Pipelineも既存ownerの制御へ渡す修正と構造v3で元IDへ回答。言い換えは親 `a281313d-7b09-4b58-9d2e-d6468f224b98`、計算15→タイマー15、子2件completed。`paraphrase-answer-v3-ledger.json` |
| 回答の配送は正しいが子計算が失敗 | 一回は同じ親へ戻った後 `compute_not_found`、親partial。成功へ数えない | モデル用snapshotが実操作と同じ会話スコープになるよう既存APIへ会話IDを渡した。同じ計算依頼が親 `88040027-c5ad-41a5-bfcc-c00524e1d548`、計算15→タイマー15、子2件completed。`known-c-scoped-ledger.json`。全ての同エラーの原因と断定しない |
| 質問待ちの取消 | commandのTODOだけを閉じ、質問の権限が残ることを回帰試験で再現した | 既存interactionのsettleを使って質問も閉じる。Pipelineは元ownerへ取消。live親 `11e96adf-3194-4ab4-ae38-8c087e294909` cancelled、子0、TODO一件。後の「15秒です」で再開も新規作業も無し。`cancel-v4-ledger.json` / `cancel-v4-stale-answer.json` |
| 依存した別題材 | 入口の単一選択では後段が落ちた | 80×3=240→240秒タイマー、二子completed。`holdout-dependent-v3-ledger.json` |
| 独立した別題材 | 同上 | 大阪の予報＋45秒タイマー、二子completed。`holdout-independent-v3-ledger.json` |
| 天気から気温差 | 同上 | 親 `3bea52d8-7cb8-4fa2-ad8f-63eb965312a0`、予報21/13→差8、二子completed。値は当該試験の観測で、現時点の天気案内ではない。`known-a-v3-ledger.json` |

東京の予報＋20秒タイマーは親completedとタイマーの実開始を確認したが、天気子の本文に未取得の説明が残った。親の状態だけで意味品質の受入済みとせず、EUM004/024に残す。旧会話を再起動後に使った `answer-v3.json` は新規質問の受入と混ぜない。画面から担当を固定した `pipeline-question-seed.json` の `toolchain_unavailable` は未対応入口によるもので、自然会話の合否から除いた。

## 固定試験と検証入力

回帰試験は有限参照・全文一致・混在拒否・失効参照・command取消後の古い回答拒否・Pipelineの同じ仕事への回答/取消・同担当の二操作・計画revision保持・計算snapshotの会話境界を確認する。意味分類は実モデル、固定試験は選ばれた出力と状態管理の契約を検査する役割である。

v7採用時の部分・結合・配布照合は41件/405検査が成功。固定コピーsixth-batchの一括検証は別作業中のbrowser bundleの整形不足で停止した（5035ms）。入力前後hashは一致し、機能試験を通した成功とは扱わない。過去のthird/fifth-batchのdomain成功はそれぞれ当時の入力にだけ適用する。現在版の最終結果は後段に追記する。

製品コードへ発話例の辞書・正規表現・固定応答を追加していない。参照・型・文字列一致・権限と状態の検査はhost/packageが担当し、意味と対象の選択はLLMに残している。別作業のBrowser改修、vendor旧版削除、Agency/World/Pipelineの改修を巻き戻していない。別チャットへメッセージを送信していない。

### 現在版の固定検証結果

Router採用候補は `eumenes_router-0.0.2-ee0f02404f6b.tgz`、SHA-256 `ee0f02404f6b7928f44721bad253bb6c3a23cf596370285485f84b96ae268c82`。route7 / structure5 / 指示v8。出荷検査114件、失敗・skip・todo0。型・lint・整形・必須Python回帰・tarball単独consumer・不正hash拒否も成功。採用元commit `f89b1326d85b9fb370896f3ddd8992e340751128` はdirtyであり、追跡外の試験fixtureも含む採用差分を `vendor/router/adoption-source.patch` とhashで固定した。vendorは別作業で決めた現採用版のみの方針に従い、置換した中間版を残さない。

[最終domainレポート](domain-native-v8-final-report.json)は固定コピーseventh-batchの7domain（dialogue / pipelines / capabilities / agent-runtime / toolchain-history / inference / compute）。部分41件/405検査、API1243件/8877検査、Web37件、DesignSystem4件、型・境界・SQL・SystemContext・サイズ・lint・整形・buildが成功。188467ms、基準HEAD `0559873582e75c822ccc3d442e153e0f0a25711b`、入力と終了hash `fc382869d93d9eb977c2e90b109c1d6184d85c3c3b43e41833d90dde53b68e1f` 一致、integrityErrors0。検証中の入力編集は無し。別作業中browser bundleの整形だけをコピー作成後・検証開始前に正規化した。製品側の別作業を変更して通したものではない。

その後、診断用medium切替の不成立を確認した。補助呼出しはreasoning指定を許さず、全20件が `invalid_session_role` でモデル実行前に拒否された。意味品質・モデル所要から除外する。製品契約は変えず、診断CLIの未対応optionとhelperのoverrideを削除した。この診断用2ファイルは削除後に本体の型・対象lint・整形を別確認した。domain実装・bundle・採用tarballは最終domain入力から変更していない。

### 現在版を再起動して通した実会話

2026-11-06 21:17 JSTごろ、許可済みの既存dev supervisorを停止し、通常の `bun run dev` でAPI/Webを再起動した。別途の音声再生プロセスや検証用画面を使っていない。再起動後の採用Routerは契約7/5・構造v8。

- `verify-eum002-native-v8-answer-20261106`: 新しいPipeline質問へ既知の言い換えで答え、元TODO `1dab18d3-95ab-425d-87ac-1a56c3a83c39` / 親 `b42c62f7-fcee-42dc-98af-af8b282095ce` を維持。計算15→15秒タイマーの二子が一回ずつcompleted、親completed。新規TODOは増えない。[台帳](native-v8-answer-ledger.json)。
- `verify-eum002-native-v8-cancel-20261106`: 新しい質問待ちの親 `1861b9f9-b11c-443a-a821-e70bef13a74f` を取消。親cancelled、子0、元TODO一件だけ。その後の「15秒です」でも状態と件数を維持。[取消後](native-v8-cancel-ledger.json)、[遅い回答](native-v8-stale-answer.json)。
- `verify-eum001-native-v8-two-20261106`: 10秒と25秒をそれぞれ一つずつ依頼。親 `4043fbee-d762-4f96-95af-85697d4a6594`、二子を一回ずつ呼び、10秒/25秒の異なるタイマーIDで開始。親completed・TODO一件。[台帳](native-v8-two-ledger.json)。

各一時切替はfinallyで復元した。[終了時照合](settings-restored-native-v8.json)も `route` / 8000ms / 構造資源null / 保存済みprofileありを確認した。新しい接続やモデルは自動採用していない。[要約](native-v8-summary.json)と[採用製品ファイル20件のhash照合](native-v8-input-integrity.json)を残す。

## 残作業と次の判断条件

EUM001/002の接続不具合と合意済み取消方式は実装・固定検証・上記liveまで進んだ。全体受入は閉じない。原文契約で止まる回と通る回がある一件、保留と独立した新依頼への余分な確認、天気子の内容品質、保存8秒での反復品質と遅延が残る。既存のlow固定契約を破った推論量比較や、同じ指示への根拠のない追加を続けない。次の変更には、失敗回の原文/DAG等の契約項目を本文なしで識別した新しい証拠、または接続・推論契約を変える場合の事前設計合意を必要とする。期待値・原文検査・権限検査は緩めない。未達を隠した保存設定の恒久切替は行わない。
