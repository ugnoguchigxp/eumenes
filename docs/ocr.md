# OCR：画像・動画から文字を読み取る

2026年10月14日、`ocr-host` の画像・短い動画の OCR と「文字を読み取る」Artifact を登録した。共通資料の API 契約は [Eumenes Excalidraw OCR OpenCV 連携の共通資料](https://chatgpt.com/space/page_e38fb71deba88191bcefebcaa046ea60) を正本とする。画面の操作契約は [設計記録](../spec/.archived/ocr-artifact-design-2026-10-14.md) を参照する。

## 接続と入力

backend の `/api/settings/ocr` に、backend 自身から到達できる gateway の URL を保存する。画面にも未設定時の保存欄がある。URL は loopback または私設ネットワークの HTTP(S) に限り、パス・認証情報・query を含めない。`LARM_API_TOKEN` は backend 内だけで参照し、画面・DB の OCR 設定・会話へ出さない。gateway の Linux loopback URL を Mac の backend から使う場合は、到達可能な転送先を設定する。サービス ID は `ocr-host`、ポート番号は永続識別子にしない。

認証はbackend共通のトークン解決を使い、`LARM_API_TOKEN`、未指定時は互換名の`LARM_CONTROL_TOKEN`をBearerとして送る。設定APIの`sharedCredentialAvailable`はトークンがbackendにあるか、`credentialConfigured`は接続先とトークンが両方あるかを示す。いずれも実接続の認証成功を保証する値ではない。接続先の未保存だけでトークン不備と判断しない。2026年10月17日の読取り専用確認では、実gatewayは共通トークンで200、不正・未指定は401だった。Macから到達できる正式入口の依頼は[依頼書](../spec/.archived/ocr-larm-connectivity-request-2026-10-17.md)を参照する。

同日の後続作業で、利用者が指定した正式originを設定APIへ保存し、Macからの認証、状態確認での非起動、合成画像・短い動画の解析、動画の取消、原本の一致、アクセス境界を確認した。[Mac実接続の記録](../spec/verification/ocr-mac-gateway-2026-10-17/README.md)に、gnosis内の過去確認と分けて結果を残す。

画像は JPEG・PNG・WebP、動画は MP4・MOV・WebM。16 MiB 以内の原本を `POST /api/ocr?conversationId=...&requestId=...` に multipart の `file` 一つで渡す。写真・録画とファイル選択は同じ受付を使う。動画30秒、画像16MP、動画の毎秒2フレーム・最大60フレームは上流契約の制限であり、超過時は上流の拒否を画面に示す。PDF は直接送らない。

## 保存・取消・会話

OCR domain は原本と結果を所有者・会話・受付 ID ごとに SQLite へ保存する。画像は同期結果、動画は上流 job ID を保存して状態を照会する。上流の `statusUrl` は追わず、保存した接続先へ既知の job path を組み立てる。受付が不明な場合に解析 POST を自動再送しない。再表示は保存済み原本と結果を読み、再解析しない。取消後に到着した結果は採用しない。設定が変わった実行も採用しない。失敗後に上流 job ID がある場合だけ「状態を再確認」を許す。

`GET /api/ocr`、`GET /api/ocr/:id`、`GET /api/ocr/:id/content` は保存済み履歴と原本を返す。`POST /api/ocr/:id/cancel`、`POST /api/ocr/:id/recheck`、`DELETE /api/ocr/:id` は状態と所有者を検証する。削除できるのは完了・失敗・中止した資料だけで、削除時にはその資料を含む OCR 操作結果も消す。接続設定が変わった資料は上流の状態を再確認できない。`POST /api/ocr/:id/conversation` は選択時刻・行番号に対応する原文、polygon、資料 ID を会話の公開操作へ渡す。会話の入力上限である8000文字を超える場合は、行を選んで追加する。保存済みの本文・行は補正・要約せずに扱い、confidence を正答率とは呼ばない。

## データ駆動 Artifact と担当

`ocr.bundle.json` が profile・Skill・open/read/cancel の tool・package・toolchain・binding・Artifact・入力 schema を版付きで定義する。`adapter:ocr@1` は OCR domain の公開操作に接続する。会話の command 担当は登録された SystemContext と認可済み snapshot から操作を選ぶ。画面は JSON の `layout` に登録 view `ocr-media` と `ocr-panel` を組み合わせる。Web adapter が認証済み API と `uploadFile` bridge を使い、原本の Blob URL は表示時だけ作る。履歴のサムネイルは、見えている項目の保存原本をブラウザで縮小して一時的に表示する。ファイル選択は読み上げ名を持つアイコンボタン。履歴選択・時刻・行選択は local actionで、時刻・行の操作には選択中の資料IDを含める。取消・再確認・削除・会話追加は OCR の認証済み API を呼ぶ local action である。

2026年10月17日に[画像生成した画面案](../spec/design/ocr-2026-10-17-redesign/README.md)を反映した。原本を少し広く取り、結果は「全文」「行ごと」で切り替える。選択行と原本の対応領域は同じ青で示し、選択行の操作は帯へ、原文全体の会話追加は別ボタンへまとめる。採用した補正案は全文タブで開き、原文も比較できる。表示領域が760px未満では縦に並ぶ。[実装・検証記録](../spec/verification/ocr-redesign-2026-10-17/README.md)に実装画面と検証の範囲を残す。

## LLM補正案

OCRが完了した画像、または動画の選択中の1フレームで「補正案を作る」を押す。元画像とOCRの文字・行位置を、版付きの`ocr.correct@1` Profile/Skill/Packageを使う一回の専門推論へ渡す。補正専用ツールチェーンはなく、`ocr.workspace@4`の画面操作からOCR domainのAPIを呼ぶ。会話経由のOCR画面は`ocr.manage@4`から同じArtifactを開く。LLMは保存済みLARM接続のvision対応サービスを使い、モデル名は固定しない。

候補は原文と別の履歴として資料・フレームごとに保存する。段落と表のセル、OCR行または元画像領域の根拠、判読困難箇所を保持し、入力行の対応・表の範囲と重なりを検査してから完了とする。表はセルの行・列と結合範囲で表示する。候補は明示的に採用すると既定表示・コピー対象に切り替わり、原文へ戻せる。原文と補正案の会話追加は別のボタンを使う。候補作成、一覧・詳細、取消、採用状態、会話追加は`/api/ocr/:id/corrections`以下のAPIが担当する。候補作成はrequestIdとOCR revisionで重複・競合を検査し、処理中は同じ資料・フレームにつき1件に制限する。

WebP等の画像はbackendで向きを反映し、透明部分を白にして、LARM接続先が許可するPNG・JPEG・BMPへ変換する。PNGが容量上限を超え、JPEGも許可されている場合はJPEGを使う。動画は配備環境の`ffmpeg`でOCR時刻のフレームを取り、実フレーム時刻が0.25秒を超えてずれた場合は補正を失敗にする。画像寸法・容量やOCR本文がLARM契約を超える場合も、資料の一部を黙って省かず失敗にする。取消と資料削除後に遅れて届いた推論結果は採用しない。Providerの生応答や画像の複製は候補に保存しない。

## 確認

固定試験は OCR gateway・保存・所有者境界・取消、HTTP 結合、command 担当、ブラウザのファイル選択・行と polygon・履歴・会話追加・動画時刻を個別に確認する。実 gateway と実カメラの受入は固定試験と区別する。

2026年10月14日の結果と未実施項目は [実装確認記録](../spec/verification/ocr-2026-10-14/README.md) に残す。
