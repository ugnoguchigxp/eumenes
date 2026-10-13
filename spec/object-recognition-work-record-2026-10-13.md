# 物体認識の実装・検証記録

## 目的と範囲

ブラウザカメラの静止画・30秒以内の動画、選択した画像・動画を、backendのobject-recognition-hostへ送る。画像の物体名・元pixel座標・検出枠、動画の時刻別検出・seek、保存・取消・会話追加を提供する。OCR、人物同定、追跡、上流配備・consumer発行は対象外。

正本: [共通Page](https://chatgpt.com/space/page_e38fb71deba88191bcefebcaa046ea60)の準備状況・共通接続仕様・OpenCV物体認識API連携プロンプト。正式配備・credentialは未確認。固定ポートを接続設定として自動採用しない。

## 再利用と依存順

既存の認証・Origin検査、settingsの暗号化、SQLite単一writer、queue、会話の公開保存操作、command型ツールチェーン、DesignSystem/OpenUIを利用する。一般の画像・動画添付保存は現状存在しないため、今回の認可付き入力保存APIを選択と撮影で共有する。新規ライブラリは不要。

1. 生成した画面デザインを保存（完了）: [workspace.png](design/object-recognition-2026-10-13/workspace.png)。imagegen組込みツール、ui-mockup、白基調・teal・左右にpreview/座標一覧・時刻列・進捗/取消/会話追加というプロンプトで生成。
2. settings・API契約・保存・queueの解析/照会/取消。
3. profile・SKILL・flat tool・package・toolchainをcommand経路へ登録。
4. DesignSystemの入力/検出表示とOpenUIのJSON/source/actions、ブラウザhost。
5. 部分→API結合→ブラウザ→利用側domain→verify:all。取消後の遅い結果、利用者分離、復帰、secret非露出を確認。
6. backendの保存設定によるread-only接続確認。実接続・実カメラはfixtureと区別。

## 完了条件・残作業

上記経路を実装し、必要試験と差分点検を完了する。別作業の未コミット差分は維持する。正式入口・業務credentialがなければlive未実施の条件を明記し、架空の成功を報告しない。現在は2〜6が残作業。


## 実装済みの範囲

画像生成デザインの後に実装した。ユーザー指定に従い、画面はアーティファクト領域に限定し、全画面viewや専用Artifact種別を追加していない。カメラ・ファイルは共通入力API、動画は保存受付IDとqueueのGET監視へ接続。通信切断後の明示的再確認もGETで行う。非同期取消後の遅い完了を採用しない。専用実装は上流multipart/ジョブ契約・所有者認可・媒体表示/撮影に限り、発話の分類や固定語句のroutingを製品コードに追加していない。

profile/skill/tool/package/toolchainはobject-recognition.manage@1。SystemContextは既存command実行機構で合成。UIはDesignSystem・OpenUI view・JSON source・host actions。既存JSON eventにFileは直列化できないためruntimeの一時uploadFile bridgeを最小追加。

固定試験で画像・動画・取消・利用者分離・再送抑止・接続変更不採用、API認証・会話追加を確認。最初のブラウザ取消試験は短い固定動画が操作前に完了して失敗。上流が実行中を維持する取消fixtureを用意し、画像/仮想カメラ/動画seek/取消/再読込の経路を確認した。ただしこの確認中にformatが動いたため、最終入力を固定したブラウザ再確認を残す。domain初回gateはBlob URL effectのlintで停止し、非同期のURL登録・解放と依存を修正した。

実接続: backendのreadonly保存設定でrevision=0/baseUrl=null/configured=false。正式配備は未確認、業務credential未設定。入力の実接続試験とMacBook物理カメラ受入は未実施。固定ポートや架空credentialで代替していない。根拠: spec/verification/object-recognition-2026-10-13/live-readiness.json。

この時点の残作業: 最終部分・利用側domain・verify:all・ブラウザ再確認、差分点検と結果記録。

## 最終結果

| 段階 | 結果 |
| --- | --- |
| object-recognition domain gate | 成功、5,545 ms。書式・lint・対象型・backend9件・Web2件。入力hashは保存したverify-object-recognition.json参照 |
| API結合・settings・物体認識・タイマー回帰 | 26成功、0失敗（api-integration.log）。会話→command→回答、認証付き原本取得、会話追加を含む |
| 利用側backend（settings/capabilities/dialogue） | 257成功、0失敗（consumer-backend.log） |
| OpenUI・既存Artifact・画像host結合 | 56成功、0失敗（openui-integration.log）。最新の入力切替中の遅い受付応答はdomainの追加回帰で確認 |
| DesignSystem | 部品5試験成功。Storybook見本を追加し、見た目は実ブラウザのArtifactで確認。Storybook runnerによる見た目確認は未実施 |
| ブラウザfixture最終 | 1成功、約1.4分。入力・仮想カメラ静止画・検出枠・実WebM再生seek・取消・再読込・狭いArtifact領域。fixtureで作る図形は実検出の品質を証明しない |
| Web production build | 最終build成功。既存のbundle容量警告あり、容量変更は担当外として未修正 |
| 全体型検査 | 途中では成功。最終実行時は別作業のapi/domains/excalidraw/controller/index.tsにstring/undefinedの型エラー6件（34/40/43/46/52/63行）。今回の物体認識に型エラーなし |
| verify:all | 未合格。api/application/toolchain.fixture.ts:5のExcalidraw内部service参照、およびweb/src/domains/settings/MemoryItemsPanel.test.tsx:11のsettings→memory境界で停止 |
| 個別利用側gate | capabilitiesとartifactは別作業のExcalidrawファイルの書式、dialogueは別作業のgeneration-operation.tsの書式、settingsは上記境界で停止。独立したbackend試験は上記のとおり成功 |
| 実接続・正式配備 | backend保存設定の再確認（16:58 JST）でも未登録。上流の正式配備・業務credential発行は未確認。実解析liveは未実施 |
| MacBook物理カメラ | 未実施。ブラウザ仮想カメラ成功と区別 |

証拠は[verification](verification/object-recognition-2026-10-13/)に保存。生成デザインと正確な生成指示は[design](design/object-recognition-2026-10-13/)に保存し、製品UIにbitmapを組み込んでいない。画面はアーティファクト部分のみ。動画の全画面操作も提供しない。

差分点検: 固定発話・個別物体名による製品側のroutingや意味判定は追加していない。API・schema・状態・所有者・登録backendへの分岐に限る。資料切替中の遅い受付応答も選択を上書きしない。未コミットの画像・Excalidraw・設定等の別作業は維持した。共通ファイルの編集は登録・接続・契約と、操作引数検証の切り出しに限る。git diff --checkは成功。

残条件: 担当外の境界・型・書式の解消後に全体gateを再実行する。実際に到達できる専用gatewayと業務credentialをbackend設定APIへ登録し、正式配備確認・実画像/動画・idle停止/次の解析で再起動・MacBook実カメラの受入を行う。上流POSTを二重送信しない。製品DB・credentialをコピーせず、上流DB/filesystemも読まない。現段階は「実装済み・固定試験済み」で、live/実機器の受入完了ではない。

initial_instructions 1回、context_compile 1回、compile_eval 1回。compile runId: 00000000-0000-0000-18de-05d631e4b3ec、評価id: 00000000-0000-0000-18de-07e57fc4f732。


最終追加確認: 上流のqueued/runningを保持し、queuedでも上流IDがある取消をAPIへ接続した。取消要求後に上流が完了した場合は、localの取消済み・結果不採用と上流の実中止を区別する表示を追加し、backendと部品の回帰で確認した。最後のdomain試行は全試験通過後に共有ソースの実行中変更で無効化され、別作業のExcalidraw・settings関連ファイルの変更を観測した。入力が落ち着いた後の再確認は5,545 msで成功（保存report参照）。その後のブラウザ確認とWeb buildも成功。最新版API/設定結合2試験はapi-final.log、DS部品は5成功。最新のUIに「上流が完了済みなら結果不採用」を実装した。残るのは上記の担当外gateとlive/物理機器の受入条件。

## LARM共有credential対応（追加依頼）

目的: 現在のLARM接続用長期credentialを共有参照し、利用者が指定したLARM_API_TOKENをbackend内で再利用する。既存resolveLarmTokenとsettings・認証API・Artifact actionsを再利用する。専用credentialは保存したまま、明示的に認証方式を選択する。LLM claim tokenの利用やgateway側認証の改造、他サービスの認証変更は対象外。

依存順・残作業: 追加migration→settingsのcredentialSourceと共有参照→credential変更のbinding→API/client/既存Artifactの選択→部分/結合/ブラウザ/対象domainと全体gate→実接続可否を確認。完了条件は秘密非露出・専用設定の互換・欠落時の明示的失敗・変更後の古い結果不採用を検証すること。LARMの長期credentialをgatewayが受け付けるかは実接続の別条件で、上流仕様にある業務Bearerとの互換を仮定しない。

追加実装済み: 認証方式 `dedicated` / `larm` を追加し、共有方式では既存の `resolveLarmToken` で `LARM_API_TOKEN`（既存LARM互換の次候補は `LARM_CONTROL_TOKEN`）を参照する。追加migration 0005で既存設定は専用方式のまま保持し、0004のSQLを変更していない。共有credentialをSQLiteへ再保存しない。公開API・Artifactに返すのは方式と利用可能のbooleanだけ。同じ接続先では専用ciphertextを残して復帰でき、別の接続先に変更すると以前の専用credentialを消去する。共有方式でcredential欠落時は失敗し、専用方式へ自動fallbackしない。高entropy長期credentialのprivate fingerprintをjob bindingへ保存し、設定revisionが同じでも共有credential変更後の応答を不採用とする。指紋は公開API・モデル・ログに渡さない。

Artifact内の既存画面に認証方式選択を追加した。操作は既存OpenUI action→認証済みsettings PUTを使い、接続先を再入力せず保存済み設定を維持する。接続先が未登録の場合は切替を無効にし、LARM制御入口を物体認識入口として推測しない。認証方式の説明と利用手順は [docs/object-recognition.md](../docs/object-recognition.md) を更新した。

追加対応の検証結果（証拠: [shared-credential verification](verification/object-recognition-shared-credential-2026-10-13/)）:

| 確認 | 結果 |
| --- | --- |
| 部分・API結合 | 物体認識10・設定3・API2成功。共有Authorization、非露出、旧設定migration、専用復帰、接続先変更、環境credential変更後の結果不採用を確認 |
| 利用側backendとAPI | 271成功・0失敗、約25秒（backend-integration.log） |
| Web host結合 | 3成功。媒体入力前の方式切替、参照とrevisionのみ送信、古い操作の競合拒否、遅い受付応答の選択非上書き |
| DesignSystem | 6成功。選択callback、表示、取消結果不採用など |
| ブラウザfixture | 1成功・約1.1分。実Artifactで共有方式を選択して画像・仮想カメラ・動画seek・取消・会話取り込み・再読込・狭い表示を確認 |
| 対象domain gate | object-recognition成功、backend10 / Web3。readonly設定queryの最終点検後に再確認し、最終hash・時間は保存したJSONに記録 |
| Artifact gate | 成功、49試験、2,302 ms |
| 全体型検査 / Web build | 成功（1,218ファイル）。buildの既存bundle容量警告は未修正 |
| settings gate / verify:all | 未合格。web/src/domains/settings/MemoryItemsPanel.test.tsxのsettings→memory依存違反で試験前に停止。担当外として未修正。変更した設定・client・fixtureの個別lint / 書式検査は成功 |
| live / 正式配備 | 18:07 JSTのこの作業環境のreadonly確認はrevision 0・物体認識接続先未登録。設定されたlocal backend入口から公開statusも取得できず、共有credentialでの解析は未実施。credential値自体を取得・表示していない |
| MacBook物理カメラ | 未実施。仮想カメラ試験と区別 |

差分点検済み: 共有credential対応は既存設定・resolver・Artifact操作を再利用し、接続契約と秘密の管理・変更後の結果採用制約に限定した。発話や個別物体名の固定条件は追加していない。別作業の画像・Excalidraw・settings等の変更を維持し、担当外の境界違反を修正していない。git diff --check成功。残条件はbackend起動環境へのLARM_API_TOKEN反映、物体認識入口の保存、正式配備とgatewayの共有Bearer受理のlive確認、および物理カメラ受入。コードと固定試験は完了、実接続受入は未完了。

累計 initial_instructions 1回、context_compile 2回、compile_eval 2回。追加compile runId: 00000000-0000-0000-18de-0ad6dd3a98d4、評価id: 00000000-0000-0000-18de-0bda0b4344b0。

最終gateの再確認1回目は全試験成功後、実行中にこの作業記録を更新したため入力hashの変更で無効になった（invalidatedの証拠ファイル）。製品不具合ではない。記録を固定して再確認し、結果はverify-object-recognition.jsonへ保存する。以後検証中は記録を含め入力を変更しない。

## 正式gatewayの実接続とbackend再起動（19:34〜19:44 JST）

ユーザーの追加依頼により、停止していたbackendを起動し、設定済みLARM_API_TOKENを使用して正式接続を検証した。保存済みControl `http://192.168.0.130:9810` でサービス登録を確認。gnosisの物体認識gatewayは正式systemd配備・enabled / active / running、18796でlisten。MacBookからSSHトンネルを用意し、Eumenes公開settings APIに `http://127.0.0.1:18796` / `credentialSource:larm` / revision 1を保存した。Linuxの配備・credential・DBは変更/コピーしていない。

実画像でyolo26nのbus 1件・person 4件、3秒動画の6時刻の検出、開始後の協調取消、動画1秒の観測を会話へ取り込む実LLM run completedを確認。19:41:49にbackendを正常終了し19:42:07に再起動。設定・結果・元媒体が保持され、workerのidle停止後も閲覧できた。新しい解析でworkerのgeneration 4→5の再起動と成功を確認。OCRは停止したまま。公開設定・結果と運用ログにcredential値がないことも確認した。backendとSSHトンネルは稼働したままにしている。

前回の「接続先未登録・正式配備未確認」は以前の調査時点の結果であり、今回の実測では更新されている。[実接続記録](verification/object-recognition-live-2026-10-13/README.md)に接続経路・正式配備・各stage・相関ID・起動状態を保存。実カメラ、今回のlive結果のブラウザ表示、実際に動く物体の動画は未実施。別のmemory-agentで既存ProfileのLARM404を観測したが担当外として未修正。製品実装は変更せず、実接続確認だけを追加した。
