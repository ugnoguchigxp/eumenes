# LARM monitoring v1とSpatialの接続設計

2026-10-18。状態: **利用者承認済み。Eumenesソース・固定応答検証は完了、本番API公開とSpatial実画面確認は残作業**。

利用者が共有したLARM担当の引き渡し本文、gnosis上の確定仕様HTML・設計HTML・JSON Schema・固定応答例を読み、既存のEumenes実装と照合した。LARMはソース実装・固定試験・collector単発実機確認まで完了。本番配備・既存Control認証設定・本番HTTP・Eumenes接続は未実施として扱う。本書の承認は配備や再起動の許可を含まない。

関連: [既存監視](spatial-monitoring-eumenes-design-2026-10-18.md)、[14体の目録](spatial-model-catalog-2026-10-18.md)、[採用描画](spatial-monitor-galaxy-adoption-2026-10-18.md)、[確定スキーマと固定応答の参照コピー](reference/larm-monitoring-v1/README.md)。LARM正本は `/srv/ai/apps/local-LLM-harness/specs/eumenes-spatial-monitoring-api-handoff-2026-10-18.html` と `specs/assets/spatial-monitoring-v1/responses.schema.json`。

## 1. 目的・範囲・完了条件

既存9体の監視にLARM Core/CPU/Memory/GPUの4体を接続する。外部連携は引き続きEumenesの履歴を観測元とする別作業。本書では外部連携の判定・集約を実装しない。

必要作業は、確定契約の検証、既存Control認証の利用、読み取り専用の共通通信、取得共有、cursorと出来事の保存、計測品質と時刻の保持、4体への表示変換、固定試験と許可後のlive確認。LARM側コード・本番設定・既存9体の判定・描画資産・モデルの形と動きは変更しない。新しいLLM担当・ツールチェーンは追加しない。

完了は「Eumenesソース実装・固定試験」「LARM本番配備・既存Control認証設定」「本番HTTP接続」「Spatial実画面確認」を分ける。本番依存が未完でも固定応答による実装検証は可能だが、接続完了とは報告しない。

## 2. 再利用する仕組みと必要な拡張

| 既存機構 | 利用・拡張 |
| --- | --- |
| settingsの保存済みLARM接続先 | 接続先の正本として継続利用。別URL設定・接続先環境変数を追加しない |
| backendの既存LARM_API_TOKEN | 既存Control認証をそのまま利用。新しい秘密設定・保存・CLI入力は追加しない |
| larmのControl origin固定・Bearer・取消・共通fetch | 読み取り専用クライアントへ再利用。監視の失敗・HTTP status・Retry-Afterを失わない公開結果を追加 |
| monitoring snapshot・Webの表示中1分取得・単一Scene | 既存経路に4形状を追加。別Canvas・別クライアントpollは作らない |
| monitoring domain | 取得共有・履歴保存・表示変換を所有。larm domainは外部契約と通信を所有 |

既存snapshotには項目別の観測時刻・stale・観測品質・履歴欠落の契約がない。また現在のWebは受信時刻を新しさの基準にする。このままLARM値を載せると古い保存値が再取得のたびに新しい値として扱われるため、項目別メタデータとLARMの詳細観測を保持する拡張が必要。既存9体の受信時刻基準は維持する。

## 3. 認証・接続設定

- 利用者の追加指示により、認証は既存の `LARM_API_TOKEN` をそのままbackend内で利用する。LARM側も同じ方針へ更新済みとの引き渡し。新しいtokenの発行・暗号化保存・設定API・CLI入力は追加しない。
- 保存済みLARM Control originに `GET /v1/monitoring/snapshot` と `GET /v1/monitoring/events` を送る。契約は `larm-monitoring.v1`。接続・claim・probe・推論APIを呼ばない。
- tokenをブラウザ・公開snapshot・設計書・ログへ出さない。backendの既存configから受け取り、既存の認証付き共通通信を使う。
- 接続先変更・backend終了時は旧世代の取得を取消し、遅い応答を採用しない。取得状態はControl originと認証世代に結び付け、別接続のcursorを流用しない。
- 既存TLS/CAとorigin固定・redirect拒否を維持。Web/CLIからDBを開かない。複数対象時の選択IDだけを既存settings契約に追加する。

## 4. 取得共有と保存

### 4.1 表示中だけの取得

Webの既存 `GET /api/monitoring/snapshot` を取得要求の入口とする。backendに常時タイマーを追加せず、表示クライアントの1分取得に応じ、LARMへの取得をbackend全体で共有する。初回は取得、以後60秒未満はキャッシュを返す。複数画面の同時要求は同じ進行中処理を待ち、前回未完了のpollを重ねない。失敗も次回可能時刻を記録し、再表示・SSEによる即時再試行を起こさない。

通常1cycleにつきsnapshotとeventsの2GET。1要求最大5秒、自動再試行なし。429/503のRetry-Afterを保持し、次回可能時刻は通常60秒とRetry-Afterの遅い方。ページ継続だけは同cycleで取得可能。ページ数・応答bytes・cycle全体の期限を境界として制限し、未完了なら追いつき途中と記録して次の定期取得へ持ち越す。実装上限は1応答2,000,000 bytes（既存JSON読取り境界）、1cycle 200page・64MiB・15秒（LARM最大100,000件、1page 500件、最大保持64MiBを根拠）。共通ControlのGETは3秒期限も適用し、外側5秒を超えない。

snapshotとeventsは独立に成功・失敗を記録する。一方の失敗で他方の値を破棄しない。相互のbootEpochが違う場合は混ぜず、次回取得まで世代不一致を示す。

### 4.2 monitoring所有の永続状態

接続先と既存Control tokenの内部ハッシュで区別した収集状態（token自体や専用tokenは保存しない）、最新snapshot、cursor、取得状態、履歴欠落、出来事をmonitoring repositoryに保存する。外部HTTPはtransaction外で行い、検証済みpageの出来事とnextCursorは同じtransactionで確定する。途中page成功後の失敗でも、保存済みpageを再計上しない。

event IDを一意キーとして重複排除。初回cursorなしで、固定windowとhighWaterSequenceを保ちhasMore=falseまで進める。途中では追いついたと扱わない。保存cursorからの再開でもevent IDの重複排除を維持する。

409 monitoring_epoch_changed / 410 monitoring_cursor_expiredでは、旧履歴の欠落理由を保存してcursorを無効化し、次回の定期cycleでcursorなしの窓を取得する。即時の再取得ループは作らない。snapshotのbootEpoch変更も履歴の境界として記録し、異なるcounterEpochの差分を作らない。

LARMのcoverage、continuity、availableSince、previousBootHistory、droppedEventsTotal、windowを保持する。イベント0件・保存領域の連続性だけで正常観測を断定しない。counter・sequence等の非負10進文字列は文字列で保存し、必要な差分は同epochのBigIntだけで扱う。ローカル履歴にも件数・bytes・期間の境界を持ち、削除した範囲と収集が欠けた範囲を区別する。再起動前のLARM履歴を復元したと表示しない。

要求結果はrequest.terminal / request.rejectedだけで集計。取消は成功・失敗に加算せず、同じworkの遅延結果で終端を置き換えない。Control操作・load・枠解放は別の出来事として保持する。OOM counterとkernel記録を足して件数を増やさない。

## 5. 外部契約・公開契約

外部応答は確定JSON Schemaと同じ契約で検証し、本文から仮想JSONを手書きしない。対応しない契約、未知field、status/value不整合、不正cursor/日時等を採用しない。契約検証方式は既存Zodと正本sourceの再利用を調査し、根拠を残す。新しい独自スキーマ仕様は作らない。

公開monitoring snapshotを後方互換で拡張する。

- 既存shapeは維持し、larm-core / larm-cpu / larm-memory / larm-gpuを追加する。
- 項目ごとに観測時刻・取得品質・古さ・表示根拠を持てるようにする。
- LARMの正式状態、配列のID、Observationのstatus/source/unit/kind/observedAt/interval/counterEpoch/maxAgeMs/lastAttempt/valueを詳細観測として保持する。derivedな表示状態と分ける。
- LARM通信・認証・契約・配備・取得制限の状態、events取得状態と履歴欠落も別に保持する。HTTPの生本文やmessageをそのまま表示・ログへ流さない。
- 正式な計測値の0と未取得を区別。staleだけは最後の値を参考値として返せるが、新しい実測値に変更しない。

401/403は認証・権限、404はAPI未提供、406は契約不対応、429は取得制限、503は監視view/認証設定の利用不可、timeout/接続不能は通信到達不能として区別する。認証エラーやpermission_deniedを4体のdisconnectedへ変換しない。既存9体に使うLARM推論接続状態も監視GETの認証失敗で変更しない。

## 6. 初版の表示規則（本書で合意を求める範囲）

### 6.1 共通

2026-10-31追記: 利用者の約1分の確認でよいという指示に基づき、以下の10秒経過ごとのWeb警告・停止は[表示修正](spatial-status-display-fix-2026-10-31.md)で更新する。LARMの品質・時刻・期限とbackendのraw判定は維持する。

既存のhealth色・描画・公転は維持する。LARM不達時に星系を消す案は採用せず、4体を残してdisconnected・staleとして示す。観測品質の不足と履歴欠落を問題なしと表示しない。

通常2秒更新の値にはmaxAgeMs=10秒がある。**60秒取得を維持すると、取得直後以外の多くの時間は参考値（stale）となる**。受信から3分をLARM計測の期限に流用せず、LARMが返す項目別期限を守る。値・時刻は保持し、既存のstale時の光の停止を利用する。常時新しい状態で動かすには取得周期の変更が必要であり、今回無断で短縮しない。

経過時間はLARMの観測時刻を起点とする。受信時にgeneratedAtとobservedAtの差を保持し、その後の端末経過を加えることで端末間の時計差を新鮮な計測に見せない。generatedAt自体を観測時刻に置換しない。

### 6.2 4体

| 対象 | 初版の提案 |
| --- | --- |
| Core | readiness=failed・runtime status=FAILED・明示modelLoadState=failedはfault。starting/verifyingまたは明示loadingはstarting、activeWorkloads>0はworking、それ以外idle。COLD/STOPPING/drainingは元の状態を保持し、接続断・障害へ一律変換しない |
| CPU | utilizationを%から0–1へ変換。load1/5/15・logicalCores・PSIは元の値として保持。新しいpressure閾値は作らない。activityはidle |
| Memory | MemTotalとMemAvailableだけでホストRAM利用率を出す。VRAM/GTT/swapと合算しない。元の値とaggregationPolicyを保持。新しいpressure閾値は作らない。activityはidle |
| GPU | 識別したデバイスのutilizationだけを%から0–1へ変換。温度・クロック・VRAM/GTTは別値。要求をGPUへ対応付けずactivityはidle。熱制限も推測しない |

CPU/Memory/GPUは必要な主計測が新鮮なokならhealthy、未取得・非対応・権限不足・エラーならunknown。古い主計測は直前の値をstaleとして扱う。healthyは警報閾値未設定の通常表示であり、全面的な故障不存在の保証ではない。補助項目の不足は詳細品質に残す。

同じ形へ表示する対象を列挙順で選ばない。local_hostのnodeとGPUが一意ならそのIDを使う。複数ならsettingsの対象IDを指定し、未指定時はselection_requiredとしてunknownにする。全IDと各値は公開snapshotの詳細に維持し、未選択対象の異常を選択対象へ転嫁しない。

明示的なkernelのOOMは対象nodeのMemory、明示的なGPU障害イベントは対象IDに一致するGPUのfaultとして、既存サービスの結果参照窓と同じ直近10分だけ表示する案とする。イベントの時刻・対象・同じbootEpochを確認し、無関係なnode/GPUへ転嫁しない。単なる正常snapshot取得や無関係な要求成功では消さず、10分の参照窓を過ぎた後に現在の観測品質から表示を作り直す。これは物理的な修復完了を保証するものではない。bootEpoch変更時は過去の出来事を履歴に残し、新しい起動の現在値へ旧faultを持ち越さない。計測が古ければfaultの根拠時刻も保持してstaleを併記する。

OOM counter増分は補助的な証拠として保持するだけで、明示kernel記録に加算したり、それだけから厳密な発生時刻・被害・LARM起因を断定したりしない。一般的な要求失敗をGPU故障にしない。再起動・モデル入れ替え頻度・平常比遅延・ディスクの警報閾値はこの接続では新設しない。ここに記載した明示障害の10分表示も新規の表示規則であり、本書の承認対象とする。

### 6.3 画面

4体を既存のitemsへ接続し、描画側に取得・health判断を持ち込まない。既存のWebGL失敗時の状態一覧・詳細に計測時刻、取得品質、通信/認証/API未提供の区別、履歴欠落を表示する。通常の会話背景に新しい常駐ボタンやドロップダウンは追加しない。詳細観測は認証付きmonitoring APIでも確認できる。

## 7. 作業順・検証・停止

1. **契約**: 正本JSON Schemaと固定応答例の照合。各品質、0、counterの巨大値、時刻・intervalの検査。新規取得クライアントをfake fetchで検証。
2. **認証・収集**: 既存Control認証の再利用、公開応答の秘密非包含、origin/credential世代変更での取消、single-flight・60秒共有・無表示時の取得なし・最大5秒・Retry-After・部分成功。
3. **履歴**: 複数page・途中失敗・同じpageの再送・再起動/期限切れ・counter epoch・coverage欠落・保持上限・取消と遅延結果を固定応答で検証。cursorとeventのatomicな保存を確認。
4. **表示**: 項目別時刻・10秒後のstale・古い値の再取得・部分成功・未設定/認証/404/406/429/503/不達の区別・複数ID・既存9体とデモ優先の回帰を確認。
5. **結合**: `bun run verify -- --domain monitoring --domain larm --domain settings --domain background --domain inference`。application組立とclientの該当試験も個別実施。稼働devと共有distを再ビルドしないよう検証用コピー等を使う。担当外失敗は修正せず証拠を報告。
6. **通し**: 対象browser E2Eを明示して個別実行。試験サーバーの起動も事前許可が必要。LARM本番配備と既存Control認証の確認後、許可されたlive GETと実画面で4体を確認する。ダミー推論・故障誘発・Provider操作は行わない。

差分点検では個別語句・発話・モデル名・固定のGPU数に依存した判断が増えていないか確認する。既存LLMの指示・情報・ツールの修正では満たせない、外部API契約・時刻・権限・cursor・transactionの強制に専用実装を限定する。同じ目的の3試行や根拠のない反復時は俯瞰評価を行う。

## 8. 承認・残作業

- 本書の取得・履歴保存・契約拡張と§6の表示規則は利用者承認済み。認証は§3の追加指示に従って既存LARM_API_TOKENへ統一する。
- 60秒取得と10秒maxAgeのためstaleが多くなる扱いは承認済み。取得周期を短縮する場合はLARM側の運用条件も含め別途決める。
- 既存認証を使い、新しい秘密の受け渡しは不要。専用tokenの発行・保存・設定API・CLI入力の作業は計画から削除済み。
- Eumenes側の契約・取得共有・履歴・4体への表示変換は実装済み。検証記録は§9。
- 残作業は、LARM本番API公開後のHTTP接続成功確認、利用者によるEumenes再起動後のSpatial実画面確認、許可後の対象browser E2E。サーバー操作は実施していない。


## 9. 実装・検証記録（2026-10-18）

認証は既存configの `LARM_API_TOKEN` を既存Controlクライアントへ渡す。監視用の秘密設定・暗号化保存・設定API・CLIは追加していない。対象選択の任意IDのみsettingsへ追加した。

canonical Zod sourceと確定JSON Schemaの一致、6個の固定応答、巨大counter、部分取得、同時取得共有、60秒間隔、Retry-After、取消後の遅延応答拒否、cursorとeventのatomic保存、複数pageの再開、409/410、boot変更、coverage、100,000件・64MiB・10分の保持境界、計測時刻と10秒の期限、対象ID、明示障害の10分表示を検証した。410の履歴再取得中も同一bootの既知障害を保持し、409のboot変更では旧snapshotをunknownとして扱う。

公開履歴は直近200event、対象ごとの最新明示障害、要求終端の集計、coverage・欠落を持つ。詳細な欠落記録は最新64件に制限し、累計gapCountは10進文字列で保持する。取消は成功・失敗に加算せず、遅延終端も取消を置換しない。

稼働中の共有成果物に影響しない一時コピーで検証し、変更したTS/TSX全34ファイルが元の作業ツリーと一致することを確認した。一時コピーは検証記録を保存後に削除する。

| 区分 | 結果 |
| --- | --- |
| `bun run verify -- --domain monitoring --domain larm --domain background --domain inference` | 成功。Bun 367件・Web 30件、計397件。format/lint・domain境界・SystemContext・size・DesignSystem・型検査を含む |
| settings個別domain試験 | Bun 39件・Web 12件、計51件成功 |
| application monitoring・migration試験 | 22件成功 |
| server shutdown order試験（起動なし） | 1件成功 |
| Web本番ビルド | 成功。chunk sizeと既存background import構成の警告あり |
| settingsを含む5domain標準検証 | 未完了。既存の `web/src/domains/settings/useSpeechModels.ts` に `settings -> inference` の境界違反。今回の差分がない担当外ファイルのため修正せず、期待値・規則も変更していない |
| 保存済み接続先へのlive GET | 既存認証でsnapshot/eventsともHTTP404 `not_found`。監視APIの公開を確認できず。推論・故障誘発・接続変更なし |
| browser E2E・Spatial実画面 | 未実施。対象fixture試験は追加済みだが、試験サーバー起動の事前許可がないため実行していない |

固定試験・結合試験は合計471件成功。実機接続成功や画面確認済みとは扱わない。結果ファイルとconsoleは `verification-reports/larm-monitoring-2026-10-18/`（ローカルの検証記録。リポジトリには含めない）に保存した。

差分点検では、専用処理を外部契約の検証・読み取り通信・取消・cursor/transaction・時刻と明示状態の変換に限定していることを確認した。新しい意味分類・語句分岐・モデル名固定・pressure閾値は追加していない。`spec/README.md` の3D計画追加と `spec/instant-3d-model-toolchain-design-2026-10-18.md` は別作業の変更として確認し、変更・削除していない。
