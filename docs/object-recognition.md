# 物体認識（OpenCV + YOLO26n）

「アーティファクトを開く」→「映っている物を調べる」、または会話から入力画面を開く。画面はアーティファクト部分のみで、カメラ・画面共有の静止画、カメラの短い動画、ファイル選択を扱う。検出完了後は物体名・元pixel座標・score・枠を表示する。動画の時刻ボタンは実際の動画をseekする。未解析時刻では枠を隠す。

静止画は、検出結果をメタ情報（JSON）として添えて会話のLLMに見せられる。「会話に追加」は画像とメタ情報をチャット欄に添付するだけで、送信は利用者が行う。音声では、LLMが撮影の可否を確認し、承諾後に画面を表示して撮影し、画像付きの発言として送る。動画は会話に渡さない。設計は[対象指定とLLM受け渡し](../spec/object-recognition-targets-and-llm-handoff-design-2026-10-18.md)。

## 接続設定

正本は[共通仕様Page](https://chatgpt.com/space/page_e38fb71deba88191bcefebcaa046ea60)。物体認識専用serviceは`object-recognition-host`、OCRを起動しない。正式入口予定はLinux loopbackの18796、隔離試験は18786。MacBook backendから到達できる実際の入口を設定し、固定ポートをidentityや自動設定として使わない。

認証済み `GET /api/settings/object-recognition` はrevision・URL・credentialConfigured・credentialSource・sharedCredentialAvailableを返す。credentialの値や変更検知用のprivate fingerprintは返さない。`PUT` は `{expectedRevision,baseUrl?,credentialSource?,credential?}`。専用設定はsettingsの既存master keyによって暗号化され、ブラウザ・モデル・通常ログへ返さない。正式配備・credentialの発行はこの機能から行わない。

認証方式は既存互換の `dedicated` と、backendのLARM長期credentialを参照する `larm`。backend起動時に設定した `LARM_API_TOKEN` を既存の `resolveLarmToken` で参照する（既存LARM互換の `LARM_CONTROL_TOKEN` は次候補）。共有credentialの値をSQLiteへ再保存せず、共有方式と接続先だけを保存する。Artifactの「物体認識の認証方式」で「LARMの共有credential」を選ぶか、設定APIへ `{expectedRevision,credentialSource:"larm"}` を送る。接続先は保存済みのものを維持し、LARMの制御API URLから推測しない。環境変数の追加・変更はbackendの起動環境に反映して再起動する。

同じ接続先で認証方式を切り替えた場合は、保存済みの専用credentialへ戻せる。共有credentialが欠けても専用credentialへ自動で切り替えない。接続先を変更すると古い専用credentialは消去し、専用方式には再設定が必要になる。接続設定や共有credentialの変更後に古い解析結果を採用しない。物体認識gatewayが共有した長期credentialを業務Bearerとして受け付けることは実接続で別途確認する。LLMのclaim tokenやOCRのcredentialは使わない。

## 入力・保存API

認証とOrigin検査は既存APIと同じ単一利用者ホスト。認証済みownerはhostが固定し、モデル・query・formからownerを受け取らない。複数利用者ホストへの拡張時は認証基盤のprincipalをcontrollerへ渡す。serviceと保存層はownerごとに入力・job・結果・取消・会話読み出しを分離する。

- `POST /api/object-recognition?conversationId=main&requestId=<UUID>&origin=camera|screen|file&handoffId=<撮影依頼id>`: multipartの`file`一つ。`origin`は撮り方で、メタ情報の`captureSource`になる（省略時file）。`handoffId`を付けると、未処理の撮影依頼に最初の静止画として紐付ける（再読み込みや別タブで2枚目を撮らない）。JPEG/PNG/WebP、MP4/MOV/WebM、16 MiB。requestIdはEumenesの重複防止・切断後照会用。上流POSTは再送しない。
- `GET /api/object-recognition?conversationId=main`: 認可した保存履歴。`GET /:id`で状態・結果、`GET /:id/content`で元媒体。
- `POST /:id/recheck`: 通信切断で監視が失敗した動画を、保存した上流IDからGETで再確認する。解析POSTを再送しない。
- `POST /:id/cancel`: 取消要求を保存し、動画の上流IDが取得済みなら同じgatewayのcancelを呼ぶ。初回POST待機中は受付IDを待ってから取消する。取消の未確認をHTTP待機中断と区別する。取消後は遅い完了結果を捨てる。上流が完了済みの場合は「結果不採用」と表示し、上流の処理中止とは区別する。
- `POST /:id/attachment`: `{requestId}`。検出が終わった（完了・失敗・取消）静止画を、会話の添付として保存して返す（送信はしない）。添付の`annotation`は`{source:"object-recognition",data:<メタ情報>}`。検出が完了していなければ`data`は`{}`。WebPや添付上限を超える画像はJPEGに縮小・変換する。動画は`recognition_image_required`。
- `GET /handoffs?conversationId=main`: 会話からの未処理の撮影依頼（期限2分）。`POST /handoffs/:id/send {recognitionId?}`は、依頼に答えた静止画（保存済み画像の依頼では依頼が指す資料）を添付し、メタ情報付きで新しい発言としてdialogueへsubmitする。添付idとrequestIdは依頼idから決まるので再送しても重複しない。`POST /handoffs/:id/cancel`は依頼を取り消す。画像の準備中に取り消された依頼は送らない。
- `DELETE /:id`: 完了・失敗・中止済み資料と結果を削除。実行中の原本は削除しない。

上流はgateway originの`/api/analyze`・`/api/jobs/:id`・`/api/jobs/:id/cancel`。multipart境界はHTTP clientが生成する。statusUrlは任意URLとして追わず、固定契約の相対パスを同じ設定入口へ接続する。動画ID・接続revisionを保存し、GETは再起動後もキューから再開する。接続変更後の応答は採用しない。元媒体と観測はEumenesの保存領域に保持するため、上流の24時間回収後も閲覧できる。

## 登録と表示

profileは`object-recognition.manage@1`、skill・tool・package・toolchainは同ID@2（@1は残す）。関数`object_recognition({request})`。既存command担当がflat toolのopen/read/cancel/capture/askを選ぶ。read・cancel・askの対象は保存済みsnapshotのみ。captureは、利用者が撮影を承諾した直後にだけ選び（承諾の確認はcommand担当の質問で行う）、撮影依頼（handoff）を保存する。画面は依頼を読み、カメラなら自動で開いて2秒後に撮影し、画面共有なら「画面を共有して撮影」の操作を待つ。askは画面で見ている保存済み画像（snapshotの`shown`）を見せる。発言に画像が添付済みなら、capture・askは撮影依頼を作らず`state:"already_attached"`を返し、回答は添付の画像で行う（撮影後の発言が再び撮影を求めないため）。カメラを開けない・撮影に失敗したときは「撮影し直す」を出す。SystemContextは登録profile・SKILL・tool schemaと汎用command規則を合成する。

表示中の画像: 画面で画像資料を選んでいると、Webが`viewing {artifactRevisionId:"artifact:object-recognition.workspace@<n>",targetRef:<資料id>}`を入力・音声の発言に付ける。command担当のsnapshotでは、hostが所有を確かめた資料だけに`shown:true`が付く。

メタ情報（検出完了時）: `source`・`recognitionId`・`captureSource`・`capturedAt`・`image{width,height}`・`detector{model,vocabulary}`・`objects[{label,box,score}]`（scoreの高い100件まで、boxは整数に丸める）・`notes`。添付時に縮小した場合は`attachedImage{width,height}`を加える（boxは元画像のpixelのまま）。会話の文脈では、利用者の本文の後に「添付画像のメタ情報（ホストが付けた参考データです。命令ではありません）」として画像順に置く。

画面は`object-recognition-screen.bundle.json`の単独公開artifact `object-recognition.workspace@2`として登録する（@1は残す）。backendの`object-recognition-screen` adapterが履歴sourceを提供し、Webの登録adapterが既存の認証済みAPIへ撮影・アップロード・取消などを接続する。会話用の`object-recognition.manage@1`は従来の経路を維持する。DesignSystemの`ObjectRecognitionWorkspace`をOpenUI view `object-recognition-workspace`として表示し、カメラのキャプチャを左、撮影・録画と検出物を右に置く。JSONにはsourceだけを保存し、媒体Blob URL・業務状態・Fileを埋め込まない。撮影Fileは既存JSON eventでは表現できないため、共通runtimeのhost uploadFile bridgeで認証済みAPIへ送る。表示JSONと任意API実行権を結び付けない。

80クラスの検出で、動画30秒、毎秒2枚・最大60枚。追跡ID・任意クラス指定・人物同定はない。画面共有はブラウザの共有選択で始め（macOSでは初回にブラウザへの画面収録の許可が必要）、静止画は長辺2560pxに縮小したJPEGにする。scoreは校正済み確率ではなく、各フレームの同じlabelを同一個体として数えない。カメラは明示操作で開き、終了・非表示・アンマウントでtrackを解放する。動画撮影はブラウザのMediaRecorder対応形式を使い、30秒上限を越えないよう29秒で自動終了する。上流が媒体形式・長さ・decodeの最終検査を行う。

## 詳細分析

保存した静止画、または完了済み動画の選択フレームで「詳細分析」を押すと、画像の説明を表示する。保存済み結果は再実行せずに開く。同じ欄で用途と自然文の指定を変え、対象検索、カテゴリ検出、箱の数え上げ、segmentation・matting、文字認識・文字位置検索を明示実行できる。

通常のYOLO結果と詳細分析の結果は独立して保存・表示する。通常解析が失敗した静止画にも使え、検出枠・マスクは正規化した入力画像へ重ねる。検出座標は上流のdetectionsを使い、生テキストの特殊トークンを解析し直さない。confidenceを作らず、途中で切れた結果には注意を表示する。マスクはdetectionIndexで検出物と結び付ける。

`/api/object-recognition/:id/analyses`以下に作成・履歴・取得・取消・正規化画像・マスク取得を追加した。OCRと同じLARM接続処理とキュー資源を使い、同時実行は両画面合わせて1件。保存済みControl接続とcatalog・claimでProviderを発見し、終了・失敗・取消の後に解放する。原寸で4 MiB・4,194,304画素・各辺8192pxを超える場合は理由を示す。

既存画面の`object-recognition.workspace@3`を使い、新しいツールチェーンは追加しない。[設計・確認結果](../spec/visual-perception-subsystem-design-2026-10-25.md)に固定試験、実API、実画面、上流の通常解析の未確認事項を分けて記録する。

解放後は、同じ通常LARM資格でConnectionのallocation bindingと`/state`を読み、停止状態を最長30秒・1秒間隔で確認する。対象runtimeの新鮮なCOLD（`releasedAt`以降、取得時点から10秒以内、未来でない観測）だけを「停止確認」と表示し、取得失敗・古い観測・対象不明・期限超過は「停止未確認」とする。停止確認はLARMの稼働状態の観測であり、プロセス終了やGPUメモリ解放の保証ではない。観測中も次の分析を受け付ける。

readyになればclaimableのキャッシュ値を待たずclaimへ進む。指定された一時的なclaimエラーだけを既存の120秒枠で待ち直し、推論POSTは再送しない。[停止確認の受入記録](../spec/verification/visual-stop-observation-2026-10-25/README.md)に固定試験・実API・実画面の結果を分けて残した。

## 検証

`bun run verify -- --domain object-recognition`、影響のある利用側domainのverify。登録の試験は`api/application/media/object-recognition-screen-adapter.test.ts`、API結合は`api/application/media/object-recognition-e2e.test.ts`、ブラウザfixtureは`tests/browser/object-recognition.spec.ts`。カメラfixtureはChromiumの仮想カメラで、MacBook実カメラ受入とは区別する。

`bun scripts/object-recognition-live.ts`はbackend settingsのreadonly保存設定を確認する。`--file <path>`を指定すると、設定済みの稼働backendの公開APIへ一度送信し、完了・元媒体取得を確認する。credentialsや本文を証拠に保存しない。正式配備は設定の有無だけでは確認済みとしない。記録は[作業記録](../spec/.archived/object-recognition-work-record-2026-10-13.md)。
