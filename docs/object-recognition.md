# 物体認識（OpenCV + YOLO26n）

「アーティファクトを開く」→「映っている物を調べる」、または会話から入力画面を開く。画面はアーティファクト部分のみで、カメラの静止画・短い動画とファイル選択を扱う。検出完了後は物体名・元pixel座標・score・枠を表示する。動画の時刻ボタンは実際の動画をseekする。未解析時刻では枠を隠す。表示中のフレームを会話に追加し、さらに解釈する場合は既存の会話モデルへ渡す。

## 接続設定

正本は[共通仕様Page](https://chatgpt.com/space/page_e38fb71deba88191bcefebcaa046ea60)。物体認識専用serviceは`object-recognition-host`、OCRを起動しない。正式入口予定はLinux loopbackの18796、隔離試験は18786。MacBook backendから到達できる実際の入口を設定し、固定ポートをidentityや自動設定として使わない。

認証済み `GET /api/settings/object-recognition` はrevision・URL・credentialConfigured・credentialSource・sharedCredentialAvailableを返す。credentialの値や変更検知用のprivate fingerprintは返さない。`PUT` は `{expectedRevision,baseUrl?,credentialSource?,credential?}`。専用設定はsettingsの既存master keyによって暗号化され、ブラウザ・モデル・通常ログへ返さない。正式配備・credentialの発行はこの機能から行わない。

認証方式は既存互換の `dedicated` と、backendのLARM長期credentialを参照する `larm`。backend起動時に設定した `LARM_API_TOKEN` を既存の `resolveLarmToken` で参照する（既存LARM互換の `LARM_CONTROL_TOKEN` は次候補）。共有credentialの値をSQLiteへ再保存せず、共有方式と接続先だけを保存する。Artifactの「物体認識の認証方式」で「LARMの共有credential」を選ぶか、設定APIへ `{expectedRevision,credentialSource:"larm"}` を送る。接続先は保存済みのものを維持し、LARMの制御API URLから推測しない。環境変数の追加・変更はbackendの起動環境に反映して再起動する。

同じ接続先で認証方式を切り替えた場合は、保存済みの専用credentialへ戻せる。共有credentialが欠けても専用credentialへ自動で切り替えない。接続先を変更すると古い専用credentialは消去し、専用方式には再設定が必要になる。接続設定や共有credentialの変更後に古い解析結果を採用しない。物体認識gatewayが共有した長期credentialを業務Bearerとして受け付けることは実接続で別途確認する。LLMのclaim tokenやOCRのcredentialは使わない。

## 入力・保存API

認証とOrigin検査は既存APIと同じ単一利用者ホスト。認証済みownerはhostが固定し、モデル・query・formからownerを受け取らない。複数利用者ホストへの拡張時は認証基盤のprincipalをcontrollerへ渡す。serviceと保存層はownerごとに入力・job・結果・取消・会話読み出しを分離する。

- `POST /api/object-recognition?conversationId=main&requestId=<UUID>`: multipartの`file`一つ。JPEG/PNG/WebP、MP4/MOV/WebM、16 MiB。requestIdはEumenesの重複防止・切断後照会用。上流POSTは再送しない。
- `GET /api/object-recognition?conversationId=main`: 認可した保存履歴。`GET /:id`で状態・結果、`GET /:id/content`で元媒体。
- `POST /:id/recheck`: 通信切断で監視が失敗した動画を、保存した上流IDからGETで再確認する。解析POSTを再送しない。
- `POST /:id/cancel`: 取消要求を保存し、動画の上流IDが取得済みなら同じgatewayのcancelを呼ぶ。初回POST待機中は受付IDを待ってから取消する。取消の未確認をHTTP待機中断と区別する。取消後は遅い完了結果を捨てる。上流が完了済みの場合は「結果不採用」と表示し、上流の処理中止とは区別する。
- `POST /:id/conversation`: `{requestId,frameIndex?}`で保存済み観測を既存dialogueの公開submitへ渡す。資料ID・物体名・元pixel座標・動画時刻を保持する。
- `DELETE /:id`: 完了・失敗・中止済み資料と結果を削除。実行中の原本は削除しない。

上流はgateway originの`/api/analyze`・`/api/jobs/:id`・`/api/jobs/:id/cancel`。multipart境界はHTTP clientが生成する。statusUrlは任意URLとして追わず、固定契約の相対パスを同じ設定入口へ接続する。動画ID・接続revisionを保存し、GETは再起動後もキューから再開する。接続変更後の応答は採用しない。元媒体と観測はEumenesの保存領域に保持するため、上流の24時間回収後も閲覧できる。

## 登録と表示

profile・skill・packageは`object-recognition.manage@1`、toolは同ID@1。toolchain `object-recognition.manage@1`、関数`object_recognition({request})`。既存command担当がflat toolのopen/read/cancelを選ぶ。readとcancelの対象は保存済みsnapshotのみ。SystemContextは登録profile・SKILL・tool schemaと汎用command規則を合成する。

画面は`object-recognition-screen.bundle.json`の単独公開artifact `object-recognition.workspace@1`として登録する。backendの`object-recognition-screen` adapterが履歴sourceを提供し、Webの登録adapterが既存の認証済みAPIへ撮影・アップロード・取消などを接続する。会話用の`object-recognition.manage@1`は従来の経路を維持する。DesignSystemの`ObjectRecognitionWorkspace`をOpenUI view `object-recognition-workspace`として表示し、カメラのキャプチャを左、撮影・録画と検出物を右に置く。JSONにはsourceだけを保存し、媒体Blob URL・業務状態・Fileを埋め込まない。撮影Fileは既存JSON eventでは表現できないため、共通runtimeのhost uploadFile bridgeで認証済みAPIへ送る。表示JSONと任意API実行権を結び付けない。

80クラスの検出で、動画30秒、毎秒2枚・最大60枚。追跡ID・任意クラス指定・人物同定はない。scoreは校正済み確率ではなく、各フレームの同じlabelを同一個体として数えない。カメラは明示操作で開き、終了・非表示・アンマウントでtrackを解放する。動画撮影はブラウザのMediaRecorder対応形式を使い、30秒上限を越えないよう29秒で自動終了する。上流が媒体形式・長さ・decodeの最終検査を行う。

## 検証

`bun run verify -- --domain object-recognition`、影響のある利用側domainのverify。登録の試験は`api/application/media/object-recognition-screen-adapter.test.ts`、API結合は`api/application/media/object-recognition-e2e.test.ts`、ブラウザfixtureは`tests/browser/object-recognition.spec.ts`。カメラfixtureはChromiumの仮想カメラで、MacBook実カメラ受入とは区別する。

`bun scripts/object-recognition-live.ts`はbackend settingsのreadonly保存設定を確認する。`--file <path>`を指定すると、設定済みの稼働backendの公開APIへ一度送信し、完了・元媒体取得を確認する。credentialsや本文を証拠に保存しない。正式配備は設定の有無だけでは確認済みとしない。記録は[作業記録](../spec/object-recognition-work-record-2026-10-13.md)。
