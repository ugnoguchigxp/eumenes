履歴資料：この提案は2026-10-19の本番契約で置き換えた。
現行は../larm-image-import-v1/README.txtと本番GET /openapi.jsonを参照。以下の旧パス・エラー・上限・未実装という記載は検討当時の内容。

LARM 画像取込API v1 提案仕様（未公開・未実装）
2026-10-18

目的と状態
Eumenesの共通画像選択から、利用者が確定したローカル画像またはGoogleフォトの画像をLARMの保存画像として取り込む。
取り込んだimageArtifactIdは既存の3D APIのsource:{type:"image-artifact",id}にそのまま使える。
この文書とopenapi.jsonはLARM側への提案であり、現在のAPIが使えることを意味しない。Eumenesから未公開endpointは呼ばない。
モデル・Profile名、画像生成サービス、Provider claimに依存しない。取込では生成やGPUサービスの起動をしない。

既存契約との接続
確認済みのGET /v1/image-artifacts、GET /v1/image-artifacts/{id}、GET .../content、DELETE .../{id}を維持する。
一覧は生成画像と取込画像の両方を返す。生成画像以外に架空のmodel/seed/stepsを付けない（既存契約でもこれらは任意）。
新しいIDはimage_に32桁の小文字16進数を続けた形式。既存3D sourceが受理する形式に合わせる。
IDの発行と内容・一覧の正本はLARMが持つ。Eumenesのファイル名やGoogle media IDをLARM IDとして流用しない。
GLB生成は別操作。画像取込・画像選択だけでは生成を始めない。

認証と入力
Controlの同一origin endpoint、既存Control Bearer。Provider credentialやGoogle OAuth tokenは渡さない。
POST /v1/image-artifacts/imports
Content-Type: multipart/form-data
Idempotency-Key: Eumenesが一つの確定操作に対して発行・保存するUUID
multipartはfileをちょうど1個だけ持つ。他のフィールド・任意URL・ローカルパス・Google資格情報は受け付けない。
Google側の画像取得と認証はEumenes backendが担当し、取得したbytesを同じfile経路に渡す。LARMは外部URLへアクセスしない。

受付上限の提案（LARM実装者との合意・計測前の値）
入力：JPEG、PNG、WebPの静止画。アニメーション・動画・SVGは対象外。
上限案：LARM受信bytes 16 MiB、各辺2000px、総画素数4,000,000、画像数1。利用者指定で各辺の上限を2000pxへ変更。現行3Dサービスの4096px・20 MiB制約内に収める。
Content-Lengthだけに頼らず受信中・decode前後で検査する。Content-Typeや拡張子だけで形式を決めない。
HEIC等はv1の保証対象外。Googleから取得した実体が未対応ならunsupported_media_typeを返し、別形式の写真を案内する。
Eumenesは既存のブラウザ画像保存codecを共通化し、アップロード前にEXIF向き適用、縦横比維持・拡大なしの長辺2000px以内への縮小、非可逆WebP品質75（effort6）への変換を一回行う。alphaは保持し、EXIF・ICC・XMPは保存しない。Eumenesが受ける変換前の原本には16MiB・各辺8192px・33,554,432画素の安全上限を設け、LARMへ送る2000px出力と区別する。
LARMはWebPを実体検証し、圧縮画像データを再圧縮せず保存する。PNGへの再変換は行わない。JPEG/PNGの直接受付はLARM側の正式契約で向き補正後PNGとする案だが、Eumenesは事前変換済みWebPを送る。
保存後の寸法・bytes・sha256・hasAlpha・format・mimeTypeは、保存された正規化後の内容を表す。
正規化後の保存bytesは20 MiB（20,971,520 bytes）以下とし、超過は413 image_too_large。既存の画像取得クライアント上限32,000,000 bytesと、3D入力上限20 MiBの両方を満たす。LARMでは暗黙の縮小や再圧縮を行わない。
入力上限は既存チャット添付の上限とは別。値を変える場合は両側の契約と試験を更新する。

応答と状態
初回の成功は201、同じ要求の成功再送は200。本文は{status:"succeeded",artifact:<既存imageArtifact形式>}。
artifactにはid、createdAt、format:"webp"、mimeType:"image/webp"（JPEG/PNGの直接受付ではpng/image/png）、width、height、hasAlpha、bytes、sha256、contentUrlを含む。
成功・進行中・失敗の状態応答にはrequestIdと照会可能期限expiresAtも含める。OpenAPI案が正確な応答形を定義する。
contentUrlはControl同一originの /v1/image-artifacts/{id}/content。資格情報をURLに入れない。
保存した画像と一覧が取得できる状態になってから成功を返す。
同じキーの処理が進行中なら202、{requestId,status:"pending"}とLocationを返す。
GET /v1/image-imports/{requestId} はpending/succeeded/failedの状態と、そのキーに対応する成果物または安全なエラーコードを返す。
このGETで、通信切断やbackend再開後の成否不明を解決できる。

重複防止と通信断
キーは認証主体ごとに区切る。要求digestはアップロードした元bytesで計算し、ファイル名・multipart boundaryは含めない。
同一キー・同一bytesは同じ成果物と応答を返す。別bytesは409 idempotency_conflict。新たな画像を作らない。
キーと最終結果は少なくとも7日保持。受付からの照会可能期限をGET応答のexpiresAtに返す。
クライアントはrequestId・受付時刻・digestを保存し、通信断後はGETで確認。保持期間内かつ本文を同じにできる場合だけ同一キーで再送する。
保持期間外や元bytesを復元できない成否不明要求を自動で新しいキーとして送り直さない。既存一覧と利用者の操作で解決する。
取消や画像差替え後に遅い成功が届いても、Eumenesは現在の選択として採用しない。
取込POSTの再送契約を、画像生成POSTや3D生成以外の操作へ拡張しない。

保存と削除
decode・検証・保存は一時領域から原子的に確定する。失敗した部分ファイル・不完全な一覧行を残さない。
クラッシュ後にpending要求を回復し、成功済みIDの再発行や二重保存をしない。回復不能ならfailed/import_interruptedとして明示する。
容量不足は507。既存素材の削除で勝手に容量を作らない。既存LARM容量管理と、未確定ファイルの回収を接続する。
成功した取込画像は、既存の保存画像と同じ所有・取得・削除・容量の扱いとする。
取消済みの取込が完了した場合も、UIの選択取消と保存画像削除を混同しない。画像を勝手に削除しない。
明示したDELETEは既存契約を使う。原本のローカルファイルやGoogleフォトの写真は変更・削除しない。
削除済み成果物に対応する取込キーを再送しても再作成しない。410 imported_asset_deletedを返す。

エラー（本文は{error:<安全なcode>}）
400 invalid_import_request：file欠落・複数・未知項目・キー形式不備。
401 unauthorized / 403 forbidden：既存Control認証。
404 import_not_found：未受付または照会保持期間外。成功したと推測しない。
409 idempotency_conflict：同じキーで内容が異なる。
410 imported_asset_deleted：当該キーの成果物は明示削除済み。
413 image_too_large：受信bytes・寸法・総画素数のいずれかが上限超過。
415 unsupported_media_type：未対応・アニメーション・動画・偽形式。
422 invalid_image：破損・decode失敗。
429 import_busy：取込処理枠の待機。Retry-Afterを秒単位で付ける。同じキーだけで再開する。
503 import_unavailable：サービス利用不可。
507 storage_full：保存容量不足。
エラー・ログに画像本文、Google token、元ファイル名、位置情報、外部Providerの生応答を含めない。

Eumenes側の接続条件
仕様と公開確認後、image domainに取込の公開操作を設け、既存host uploadFile bridgeと接続する。
共通ImagePickerはprops/eventsで結果を受け、LARMのIDを選択確定として3Dフォームへ返す。FileはOpenUI JSONへ入れない。
Google連携は同じアカウントでPhotos Picker scopeへの追加同意が必要。現在のopenid/email/profileだけでは写真を読めない。
Photosのセッション・pollingConfig・期限・取消・選択bytesの取得・片付けはbackendが所有する。
外部URLを永続参照として渡さず、選んだ静止画だけを取得・検証・取込する。
現在3D生成に使えるのはLARM保存画像。「LARM画像」「Googleフォト」の2タブと独立した「参照…」ボタンを表示する。「参照…」ではファイル選択・ローカル確認まで可能だが、未アップロードと表示し生成用IDとしては確定しない。Googleフォトは未接続理由を表示し、外部要求を発行しない。

画像と文章の併用について
2026-10-18の実OpenAPIを再確認し、3D生成sourceはpromptまたはimage-artifactの排他的な契約で、画像に補足文を添える項目は無い。画像取込APIを追加するだけではこの制約は解消しない。
併用を実現する場合は、画像と文章から3D生成用の元画像を編集する段階を設けるか、両方を扱える3D生成サービスが必要。どちらも現行契約外の設計案であり、この取込提案に暗黙に含めない。UIの文章欄だけ追加して、生成に効いているように表示しない。

受入条件
・JPEGの回転と位置情報除去、透過PNG、WebPを正規化し、既存一覧・取得と3D生成で使える。
・偽MIME、破損、複数画像、動画、巨大入力、画素爆弾を拒否し、成果物を残さない。
・同一キー再送・並行要求・応答断・クラッシュ回復・削除後再送で重複生成しない。
・容量不足・認証失敗・中断・照会期限外を区別し、古い選択に遅い結果を採用しない。
・取込だけでは生成POST、Provider claim、GPU起動、原本削除を行わない。
・Google実アカウント受入とLARM実取込受入はfixtureと分けて記録する。

根拠
docs/model3d.md / docs/images.md / docs/google-accounts.md / docs/openui-artifact.md
api/domains/larm/contracts/image-library.ts / api/domains/larm/contracts/mesh.ts
2026-10-18の実LARM OpenAPIには上記import APIが無いことを確認済み。
https://developers.google.com/photos/picker/guides/get-started-picker
https://developers.google.com/photos/picker/guides/sessions
https://developers.google.com/photos/picker/guides/media-items

追加依頼の範囲（2026-10-18）
利用者の最新指示により画像専用とする。汎用ファイル保管、PDF、音声、動画等の受付は追加しない。LARM側の既存3D実装チャットへ、画像取込APIの実装を依頼する。製品側から未公開APIを呼ぶ処理は正式契約確認後。
ライブcatalogの3D入力条件を再確認し、初期案の8192px・正規化32,000,000 bytesを4096px・20 MiBへ訂正。これにより、取込に成功した画像を既存3Dへ渡す要件に合わせた。上限は依頼案であり、LARM側の確定応答で再照合する。

品質75と共通化の指定（2026-10-18）
利用者が長辺2000pxとアップロード前の非可逆WebP品質75を明示指定。画像検証・圧縮はapi/infrastructure/webp.tsへ既存browser encoderから共通化し、browser adapterとimage/service/prepare-upload.tsで利用。会話添付のJPEG/PNG/BMP契約やブラウザ撮影2500px上限は変えない。LARM担当チャットへ2000px・WebP非再圧縮保存の訂正を送信済み。
