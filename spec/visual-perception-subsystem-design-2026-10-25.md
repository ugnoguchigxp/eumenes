# OCR・物体認識の詳細分析サブシステム

作成日: 2026-10-25 JST。状態: 2026-10-25 利用者合意済み。実装・対象domain検証・実LARM API・稼働画面の操作を確認済み。確認範囲と外部サービスの未確認事項は[受入記録](verification/visual-perception-2026-10-25/README.md)を参照。

## 1. 目的・合意する範囲

既存の「文字を読み取る」と「映っている物を調べる」に「詳細分析」を追加する。利用者がボタンを押したときだけ、LARMの視覚解析Providerをオンデマンドで確保し、画像説明、自然文による対象検索、検出、数え上げ、マスク、文字認識・文字位置検索を実行する。新しいツールチェーン、専門エージェント、独立Artifactは作らない。

2026-10-25の利用者指定は「新ツールチェーンではなくOCRやOpenCVのサブシステム」「詳細分析ボタンを押して得た結果を表示する」。両方の既存画面への組込み、初回ボタンで画像説明を実行する操作、保存・APIの詳細は本設計で合意した。

通常OCR・QR・LLM補正・YOLOの結果と処理は維持する。詳細分析は原本や通常結果を上書きしない。通常会話へ自動で送らず、利用者の文言からコードで用途を推定しない。今回、会話から詳細分析を起動する新しいtoolや、YOLOEへの移行、動画全体の連続分析は追加しない。

上流仕様は[利用者提供のLARM視覚解析契約](reference/larm-visual-perception-v1/request.txt)を根拠とする。この資料にある接続先・Profile・モデルの具体値は配備情報であり、製品の固定値や既定値にはしない。LARM側の配備・推論受入は利用者の報告であり、Eumenesからの受入結果とは区別する。

## 2. 現行確認と再利用案

| 現行の責務・実装 | 今回の利用方法と不足 |
| --- | --- |
| [OCR仕様](../docs/ocr.md)、`ocr/service/qr.ts`・`corrections.ts` | 所有者・会話・資料revision、受付UUID、単一writer、既存queue、取消後の不採用、別結果の保存方式を使う。詳細分析をOCR原文・補正案・QRとは別に保持する |
| [物体認識仕様](../docs/object-recognition.md)、`ObjectRecognitionWorkspace/DetectionPreview.tsx` | 原本・履歴・動画の検出時刻・通常の検出一覧を使う。詳細分析用の欄を追加し、動画の選択フレームをruntimeへ伝える |
| `ocr/service/correction-shared.ts`の画像正規化・ffmpeg抽出 | 向きの補正と選択時刻の抽出を再利用する。現状はOCR内部なので、両domainが使う媒体変換部分だけを既存infrastructureへ切り出す。物体認識からOCR内部を参照しない |
| [LARM仕様](../docs/larm.md)、`larm/service/control.ts` | 保存済みsettingsから得たControl origin、既存token解決、origin検査、通信・期限・取消を使う。ブラウザからLARMへ直接接続しない |
| `larm/service/playground-catalog.ts`・`playground.ts`・`playground-provider.ts` | 公開selectorの列挙、catalog整合性、個別Providerの接続・claim・finally解放を参照・再利用する。試用画面のAPIを製品の実行入口にはしない。必要な内部接続処理だけを共有する |
| `larm/contracts/index.ts`・`service/connect.ts` | 通常会話のCapabilityは現在llm/asr/ttsであり、そのまま視覚解析には使えない。視覚解析の外部JSON契約と最小adapterをLARM domainへ追加する |
| 既存queueのresource・concurrency、状態の変更通知、Artifact runtime | 両入口の分析を同じ資源で直列化し、状態の正本を保存側に置く。画面は通知を受け既存APIから再取得する |

指示文だけでは解決しない不足は、新しい推論HTTP契約、マスクと座標の検証・描画、ボタンからの明示実行である。専用実装はこの外部契約との接続、権限・容量・並列数の制約、保存・表示に限定する。対象の意味・関係・行動や文字の解釈は視覚モデルへ任せる。

## 3. 操作と結果表示

### 3.1 入口

両画面の選択中の資料に「詳細分析」ボタンを置く。静止画は保存済み原本、動画は通常解析で選んだ観測フレーム1枚を対象にする。資料を再アップロードする操作は不要。静止画は通常解析が完了・失敗・取消のいずれでも、原本が保存済みなら利用可能とする。動画は抽出対象の時刻を持つ完了済み資料に限る。

未実行の対象で押すと、画面内に詳細分析欄を開き、`describe`で画像説明を1回実行する。初回の観点は「この画像で何が起きているか説明してください。」とし、対象の意味を決める固定応答は持たない。実行に時間がかかることをボタン付近に示す。保存済み結果があれば欄を開いてそれを表示し、再表示で推論し直さない。

欄には用途の選択と自由文の入力、「分析する」「中止」を置く。初回説明後は用途・観点を変えて明示実行できる。検出の複数カテゴリは文字列リストとして入力し、自然文をキーワードで分解・分類しない。

| 画面の用途 | 上流task | query |
| --- | --- | --- |
| 画像を説明 | `describe` | 説明してほしい観点 |
| 条件に合う物を探す | `referring` | 関係・行動・状態を含む自然文 |
| 種類で検出 | `detection` | 文字列、または最大32カテゴリの配列 |
| 箱で数える | `count_box` | 対象の指定 |
| 対象を切り抜く | `segmentation` | 対象の指定 |
| 輪郭を滑らかに切り抜く | `matting` | 対象の指定 |
| 文字を読む | `ocr` | 空文字も可。通常OCRとは別の結果 |
| 指定した文字を探す | `ocr_grounding` | 探す文字 |

用途の選択はAPIのtaskとの対応付けであり、入力内容の意味分類ではない。通常OCRの補正・採用には接続しない。OCRの行選択・範囲選択は詳細分析の切抜き範囲に流用せず、画像全体を送ると明記する。

### 3.2 状態・結果

保存状態は未実行、受付済み、起動中、解析中、完了、失敗、中止処理中、中止済みを区別する。起動中は接続作成からclaimまで、解析中は推論POSTから応答検証までとする。進捗率や残り秒数を推測しない。処理中に別資料へ移っても結果は元資料・フレームへ結び付け、選択先に表示しない。

結果は通常OCR/YOLOと別の「詳細分析結果」に表示する。説明・生テキストはテキストとして描画しHTMLを解釈しない。対象一覧の選択で検出枠・対応マスクを強調する。confidence欄は設けない。

枠には`detections[].box`を使い、特殊トークンを解析し直さない。詳細分析欄には、送った画像と同じ向き・寸法の正規化済み画像を表示する。SVGの座標系を応答のwidth/heightへ合わせ、拡大縮小と余白があっても枠と画像を一致させる。通常のYOLO枠と詳細分析の枠は切替表示し、score付きYOLO結果へ混ぜない。

マスクは`detectionIndex`で対応させ、同じlabelだけで結合しない。PNGを重ね、表示のオン・オフができる。binaryは二値、alphaは連続透明度として表示する。`describe`の空detectionsは正常とする。0件は「条件に合う対象は検出されませんでした」とし、不在を断定しない。

`truncated:true`では「生成上限に達したため結果は途中までです」を目立つ位置に表示する。箱の数は「検出した箱の数」とし、切断時に完全な数として扱わない。workerの処理時間（ms）と、Eumenesでの起動待ち・推論待ち・全体経過時間を分ける。model/modelRevisionと実行情報は応答にある値を詳細欄に示す。

## 4. LARM接続と推論

保存済みLARM settingsをbackendの公開読取り操作で取得し、既存のControl credentialを参照する。OCR/物体認識gatewayの接続設定を書換えず、新しい接続先入力欄も追加しない。

1. 保存済み設定と既存catalog列挙処理から公開selectorを取得し、capability `vision.perception`・protocol `larm.visual-perception.v1`のProviderを探す。Profile名・モデル名を固定しない。selectorと内部Profile IDを区別し、catalogRevisionが変わった一覧を採用しない。同じ条件の候補が複数あれば既存のcatalog順を使う。公開selectorが取得できず発見できない場合は利用不可を示し、具体名へのフォールバックを加えない。
2. 保存済みaudienceがcatalogで公開され、backendから到達可能なendpointを返すことを確認する。Macからの接続をloopback originだけでsame-hostと推定しない。使えるaudienceが確認できなければ失敗理由を表示し、接続先の推測や保存設定の自動変更をしない。
3. 操作ごとのUUIDをIdempotency-Keyにし、接続作成に発見したselector・revision・Provider名、既存audience、ttlSeconds 600、allowFallback false、deploymentPolicy existing-onlyを送る。他の操作と接続clientを共有しない。接続管理本文は既存契約どおり非圧縮とする。
4. pending/probingはGETで待ち、readyまで120秒の枠を確保する。failed/released/expiredは失敗。claimは`openai-provider-v1`で行い、返されたProviderのprotocol・apiStyle・model・資格期限・endpointをcatalogと照合する。endpointは既存の許可host検査を通し、redirectを追わない。
5. claimのendpointへBearer資格で同期JSON POSTする。modelはclaim値、imageはbase64 data URI、task/query/maxNewTokensだけを送る。既定maxNewTokensは上流の256を使い、省略する。推論待ちは185秒を確保し、接続待ちとは別に測る。新APIの送信圧縮は上流の受理を確認するまで仮定しない。
6. 成功・失敗・取消のすべてで、自分が作った接続を独立したcleanup期限のDELETEで解放する。取消が接続作成中でも返されたIDを回収して解放する。POSTの応答が不明な場合は同一Idempotency-Keyによる接続の回収だけを行い、新しい接続を重複作成しない。推論POSTは再送しない。

処理は1接続につき1推論とし、完了後に接続を保持しない。今回は連続処理のrenewや会話用leaseの共有を導入しない。後日追加する場合はrenew後の再claimを必須とし、TTL更新だけで無通信60秒解放を防げるとは扱わない。

HTTP 400、413、401、429、接続管理409、サービス503/504、通信断・期限切れ、解放未確認を区別する。401の推論を自動再送せず、利用者の再実行で新しく確保する。429は競合を示す。取消は結果の不採用と接続解放を行い、上流の計算が直ちに止まったとは表示しない。解放未確認時は結果の有無とは別に警告を保存する。

## 5. 画像・応答の検証

PNG/JPEG/WebPの静止画1枚を正規化し、実データとMIMEを照合する。復号後4MiB以下、4,194,304pixels以下、各辺8,192px以下、JSON要求全体8MiB以下を送信前に検査する。queryは通常2,048文字以内。detection配列は最大32要素・各1〜128文字、maxNewTokensの指定を公開する場合も16〜512を強制する。未知のフィールドを送らない。

元資料の16MiB/16MP受付と詳細分析の上限は異なるため、詳細分析だけが上限超過になる場合を画面に示す。初版は黙って縮小・切抜き・部分送信せず、原寸の向き正規化とPNG/JPEGへの変換で収まらなければ413相当で失敗する。

動画は既存ffmpeg抽出の入出力制限・取消・時刻照合を維持し、選択時刻との差が0.25秒を超えたら失敗する。実抽出時刻を記録し、詳細分析欄には抽出した静止画を表示する。再生中の別時刻へ枠を重ねない。

応答はcontractVersion、task/modelの一致、EXIF正規化のorientation、画像寸法、有限・範囲内・順序正当なxyxyを検査する。マスクは最大8個、encoding png-base64、mode binary/alpha、厳密なbase64と実PNG、合計4MiB、画像との寸法一致、detectionIndexの参照先を検査する。応答読取りにも本文上限を設け、マスクを含む正常最大応答が通る境界試験を行う。生テキストに依存した座標復元・confidence生成・ラベル補正は行わない。

## 6. 保存・責務・API

LARM domainが視覚解析の通信・catalog/claim・外部契約を担当する。OCRと物体認識domainが、それぞれ所有する資料への認可、分析記録、原本取得・削除との整合を担当する。domain間でSQLを共有せず、アプリケーション層が公開操作と単一writer transactionを接続する。

既存のtier（LARM 0、物体認識1、OCR 3）を維持する。両業務domainのhandlerへアプリケーション層から視覚解析の公開操作を注入し、LARMからOCR・物体認識やsettingsを参照しない。保存済み設定とcredentialもアプリケーション層で解決して渡す。既存queue資源への登録は同じcompositionで行う。

分析記録は各domainに追加し、id/requestId、所有者・会話、元資料ID/revision/digest、動画frameIndex・要求/実時刻、task/query、状態、結果、処理時間、エラーと解放確認状態を保存する。credential、claim本文、原本の重複コピーは保存しない。マスクは検証済みの結果資産として保存し、認証済みの取得APIから配信する。履歴再表示にLARM接続は不要。通常結果のrevisionを詳細分析完了で更新しない。

| API案（認証・Origin検査は既存経路） | 操作 |
| --- | --- |
| `POST /api/ocr/:id/analyses`、`POST /api/object-recognition/:id/analyses` | requestId、conversationId、expectedRevision、動画ならframeIndex、task、queryを検証して202で受付 |
| 同じrootへの`GET`、`GET /:analysisId` | 保存済み履歴・状態・結果。所有者・会話・元資料との対応を検証 |
| `POST /:analysisId/cancel` | 取消を保存し、既存queueの実行signalへ伝達 |
| `GET /:analysisId/image`、`GET /:analysisId/masks/:index` | 実際の解析入力の正規化画像を原本から再構成、または検証済みマスクを取得。資格・外部URLを返さない |

同じrequestIdと同じ入力の受付は既存記録を返し、異なる入力は競合にする。両domainが同じqueue resource（capacity 1）・concurrency keyを使い、起動から解放まで同時実行を1件に制限する。Eumenesで待つ受付状態は許すが、上流へ並列要求・推論キューを積まない。jobのmaxAttemptsは1、処理全体の期限は起動120秒＋推論185秒＋cleanupと保存の余裕を含め360秒とする。

完了前に元資料、所有者・会話・revision/digest、LARM設定revision、取消を再検査し、古い応答を採用しない。元資料の削除は関連分析を取消・削除し、遅い完了で復活させない。再起動で推論の受付が不明になった実行は失敗として記録し、自動再送しない。回収できる接続IDは解放する。

画像・query・生応答・資格・保存設定を通常ログへ渡さない。診断用にはrequest/job/analysis ID、HTTP status、状態、時間、制約違反codeだけを使う。結果はEumenesに保存し、LARM中央の暗号化監査方針も適用されるため「一切保存されない」と表示しない。

## 7. 変更箇所と作業順

1. 本設計への合意。実装前にLARMの読取り専用catalogで実際のProvider・公開selector・audience・claim schemaを確認する。提示契約と異なれば根拠と影響を報告し、契約を推測で追加しない。
2. LARM domainの契約・接続adapterと固定試験。既存接続機構の最小共有化、settingsの読取り、期限・解放・単一実行を先に確認する。通常会話leaseの判断・優先順位は変更しない。
3. 媒体変換の最小再利用、両domainの保存・API・queue結合。既存の単一writerと公開操作を使い、独自runnerを追加しない。
4. DesignSystemの共通詳細分析欄・画像と枠/マスク表示を追加し、既存OCR/物体認識のpropsへ接続する。`client`、Web runtime、`artifact-ui`の認証済み操作を接続する。既存bundleのArtifact契約は必要なrevisionのみ更新し、独立toolchain/profile/packageは追加しない。bundle変更時は既存の登録・検証手順に従う。
5. 部分→結合→ブラウザ→liveの順で確認し、結果と未実施項目を記録。最後に差分全体を点検する。

既存のsharp、ffmpeg、queue、SVG/Canvasで対応し、新ライブラリは予定しない。別方式やSDK追加が必要になった場合は、その不足と依存の影響を先に記録する。

## 8. 検証と完了条件

### 固定試験・結合

- 契約8task、画像・query・mask上限の境界、不正MIME/PNG・寸法・index、describeの0件、truncated、時間単位を検査する。モデル名・Profile名を変えたfixtureでも同じ経路が通ることを確認する。
- pending/probing→ready→claim→推論1回→解放と、起動失敗、期限切れ、HTTP各種、接続作成中/推論中の取消、解放失敗を検査する。通信断で推論POSTが再送されないこと、Provider credentialがbrowser・永続領域・ログへ漏れないことを確認する。
- 所有者・会話・revision、不正なframeIndex、同一受付/競合、両画面同時受付の直列化、資料削除・設定変更・取消後の不採用、再起動時の不明実行を検査する。
- 部品試験でボタンからの初回実行と保存済み再表示、用途切替、二重操作、状態、枠・mask対応を確認する。EXIF回転、縦横の違い、同一label複数、画像余白、拡大と狭い画面を含める。
- `bun run verify -- --domain larm --domain ocr --domain object-recognition`を実行し、登録/画面変更が影響する利用側domainも`scripts/domains.ts`の対応に沿って追加する。既存OCR・QR・補正、YOLO、通常会話の回帰を含める。
- ブラウザE2Eは`tests/browser/ocr.spec.ts`と`tests/browser/object-recognition.spec.ts`を明示して実行する。現在のE2Eはbackend/Viteを起動するため、サーバー起動の明示許可がある場合にのみ実施する。`verify:all`とブラウザE2Eの結果を混同しない。

### 実LARM・画面

保存済みsettingsを使う公開API経由で検索・説明・segmentationの実結果と表示を確認する。両画面からの実行、正規化した原寸画像と座標・mask、truncated表示、worker時間とEumenes待ち時間、終了・失敗・取消時の接続解放、再取得による再利用を記録する。8taskの外部契約と3種類のlive必須受入を区別する。

停止状態からの初回確保と、他の利用者が接続していない条件での最終解放後の自動停止を、LARMの公開状態で確認する。放置後の無通信自動解放は、上流が公開する接続状態を用い、稼働中の他接続を解放しない。worker/systemdを直接操作しない。停止状態を用意するための手動停止・サーバー再起動が必要なら、プロジェクト規則による明示許可を得てから行う。

固定試験、Eumenesからのlive、画面表示の証拠を分ける。今回未実施の通し試験は成功扱いにせず、未実施理由と続行条件を記録する。設計のみの段階ではコードを変更していないため、実行検証は省略し、契約との対応と差分を点検する。

## 9. 実装と確認の結果

LARMの新しいJSON契約、catalogからのProvider発見、既存接続管理の共有化、両domainの独立した保存と取消・起動時回収、共通queue資源、共通DesignSystem部品、認証済みclientとArtifact操作を実装した。従来のbundleを変更せず、追加bundleで`ocr.workspace@6`・`ocr.command@6`・既存`ocr.manage@6`と`object-recognition.workspace@3`を登録する。

対象domainのverifyは成功（backend 365件、Web 22件、既存OCR部品10件）。追加のアプリケーション結合7件、Web hookを含む18件、詳細分析・物体認識部品16件と全体型検査も成功した。実LARMで説明・検索・segmentation、保存済み結果の再表示とマスク切替、画面からの推論、約60秒の無通信解放、claim後の取消と解放、その後の明示操作による再取得を確認した。試行と証拠は受入記録にまとめる。

共通queueはcancel_requestedの実行完了時にdomainのsettleを呼ばない。そのため取消受付時に結果不採用を確定し、releaseConfirmedが未確定の間は画面に「中止処理中」と示す。解放確認は独立して保存し、計算が直ちに止まったとは扱わない。再起動時は公開された既知の接続IDを回収し、推論を再送しない。

通常YOLOの上流への今回の受付は未確認、LARMのモデルプロセス停止のinspectionはHTTP403だった。既存サーバーだけで確認するという利用者指定により、一時サーバーを起動するブラウザfixtureは未実行とし、稼働画面での確認と部品・hook・API試験を別に記録した。これらを成功に含めず、上流や権限の変更は行っていない。

通常の文章や個別対象に応じた専用分岐は追加しない。専用のHTTP契約と容量・座標・権限の検査は、添付の外部仕様に必要な制約として扱う。着手時に存在した別作業の差分は今回の変更対象から外す。

## 10. 停止観測とclaim待機の仕上げ（2026-10-25 利用者依頼）

利用者から提示されたLARM側修正（commit `ae62948340e2e0959bbbae9eca362dba7a060626`、本番反映済み）と公開API契約を根拠とする。取消直後の停滞は旧instance停止との競合であり、資源待ちやEumenesの待機条件を原因と確定しない。LARM側が行った実モデル4回連続成功は上流側の証拠で、今回のEumenes受入とは分ける。

既存の視覚解析接続だけ、ConnectionがreadyになればProviderの識別情報を照合してclaimへ進む。claimableは10秒のキャッシュ値なので、falseだけを理由にGETを続けない。HTTP200の資格付きdescriptorの検証を最終判定とし、503 provider_semantic_not_readyは短いbackoff、409 connection_not_readyは状態再取得を行う。接続がfailed/released/expiredになったら終了し、待機全体の120秒枠を延長しない。推論POSTは再送しない。共通接続機構を再利用し、既存の試用・通常会話の待機方式を無断で変更しない。

接続のallocationIdと`GET /v1/allocations/:id`のbindingsから、capability vision.perceptionのruntimeを特定する。通常のControl資格を使って`GET /state`をcache:no-storeで読み、online true、対象runtime存在、status COLD、observedAtがConnectionのreleasedAt以降かつ取得時点から10秒以内で未来でないという条件を満たした観測だけを保存する。観測は1秒間隔・30秒上限とする。取得失敗、古い観測、runtime不明、上限到達は停止未確認とし、COLDを見ないことだけで異常としない。解放・停止観測のメタデータを既存の分析記録に追加し、両画面へ反映する。COLDはLARMの稼働状態であり、PID消滅やGPUメモリ解放の厳密な証明とは表示しない。

停止観測は解放後の読み取りだけで行い、モデルの再取得や推論を起こさない。30秒の観測を次の解析受付・接続取得の条件にせず、既存の変更通知と保存結果を使って表示を更新する。取消後も解放と観測を独立した期限で行い、再起動で観測が途切れた結果は停止未確認にする。bootEpoch変更で旧Connectionが410 connection_epoch_expiredになった場合は、旧接続を再利用せず、新しい操作で新規接続を取得する。

実装順は契約・LARM入出力→保存・表示→固定/結合→新しいepochのlive→既存サーバーでの画面確認。固定試験は新鮮/古いCOLD、offline、対象なし、取得失敗、warm継続、claimable false、指定503/409、terminal、失敗/取消の解放、観測と直後の再取得の独立を含める。LARMの起動停止を直接操作せず、接続とsnapshotを使う。サーバー起動停止の既存制約を維持する。

### 仕上げの受入結果

通常資格で`/state` HTTP200、bootEpoch変更前の既知ConnectionはHTTP410 connection_epoch_expiredを確認した。新epochでclaim後・推論送信前に取消し、停止観測を待たず新規取得した分析は約21秒で成功した。解放した接続のbindingに対応するruntimeで、releasedAt以降の新鮮なCOLDを保存できた。readyからclaimまで11秒空けた実接続では、readiness ready・claimable falseからclaim HTTP200、推論と解放が成功した。

再起動後のEumenes画面では、OCRの分析完了とCOLD表示、物体認識の解析中取消・結果不採用・接続解放・COLD表示を確認した。snapshot取得失敗時の保存と停止未確認表示は、障害を注入した固定試験と画面部品試験で確認し、実LARMの障害を起こした試験とは区別する。詳細と残る公開APIの限界は[受入記録](verification/visual-stop-observation-2026-10-25/README.md)に記載した。過去のinspection HTTP403や旧版での停滞は当時の記録であり、今回の停止観測にはinspectionを使用しない。
