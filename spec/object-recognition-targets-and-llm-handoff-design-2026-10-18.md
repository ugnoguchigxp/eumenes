# 物体認識の対象指定と、画像＋検出結果のLLM受け渡し

作成日: 2026-10-18。状態: **合意済み・実装中（§5.3）**。§5.1・§5.2は上流の対応待ち。要合意事項は§7（Q3・Q6（上流の対応後）以外は決定済み）。

関連: [物体認識の現行仕様](../docs/object-recognition.md)、[チャット画像入力](../docs/chat-images.md)、[作業記録](.archived/object-recognition-work-record-2026-10-13.md)、[チャット画像添付の計画](.archived/chat-image-attachments-implementation-plan-2026-10-13.md)、[登録と拡張の手順](../docs/toolchain-extension.md)。

## 1. 目的

1. 「映っている物を調べる」で、利用者が探したい物を名前で指定して検出できるようにする（例:「マグカップ、リモコン、鍵」）。
2. カメラ・画面キャプチャ・選択した静止画1枚と、物体認識の検出結果（メタ情報JSON）を、画面の「会話に追加」（チャット欄へ添付）または音声で会話のLLMへ渡し、LLMに画像そのものを見て答えさせる。

## 2. 現状と、性能が悪く見える理由

| 項目 | 現状（コードと文書で確認） |
| --- | --- |
| 上流 | 外部の `object-recognition-host`（Linux、OpenCV + YOLO26n）。Eumenesは `POST /api/analyze`（multipart `file` のみ）・`GET /api/jobs/:id`・cancel を呼ぶ。上流のソースはこのリポジトリにない |
| 語彙 | COCOの80クラス固定。クラス指定の入力欄・API項目なし（`docs/object-recognition.md`「任意クラス指定・追跡ID・人物同定はない」） |
| 会話追加 | `POST /api/object-recognition/:id/conversation` → `service.conversationText()` が作る**文字だけ**を `dialogue.submit({text})` に渡す（`api/application/app-modules.ts` の `registerObjectRecognition` の第4引数）。画像はLLMへ渡っていない |
| 会話の画像入力 | 実装済み。`conversation` domain の `uploadAttachment`（sharpで正規化・検証）、`POST /api/runs` の `attachmentIds`、Providerの `llm.vision` と `chatInput`（`larm-chat-input.v1`）による可否判定、`data:` URLでのLARM送信 |
| 表示中の対象 | `viewing {artifactRevisionId,targetRef}` を送信に付け、hostが発行済みの選択肢と照合する仕組みがある（UI自由制作が利用中）。物体認識の画面は送っていない |
| 動画のフレーム | backendには元動画だけを保存。OCRの補正で `ffmpeg` を使用済み |

性能が悪く見える主な原因は次の3つ。

- **nanoモデル**: YOLO26系で最も小さいモデル。小さい物・重なった物・遠い物に弱い。
- **80クラスにない物が出ない**: 鍵・リモコン以外の家電・文房具・食品の多くはCOCOにない。何も検出されないか、似たクラスに誤って分類される。
- **LLMは座標の文字列しか見ていない**: 会話追加しても、LLMは「cup [x,y,x,y] score=0.6」という文字しか受け取らない。画像の内容を説明できず、性能の低さがそのまま回答に出る。

## 3. 調査：対象を名前で指定できる検出（open-vocabulary検出）

| 方式 | 特徴 | Eumenesでの評価 |
| --- | --- | --- |
| **YOLOE-26**（Ultralytics、YOLO26 + YOLOE） | `set_classes(["mug","remote control"])` のように文字で対象を指定。リアルタイム級。論文ではLVISでtext promptのAP 40.6（xサイズ）。プロンプトなしで広い語彙を出すモードもある。export済みモデルは設定したクラスで固定されるため、毎回指定を変えるならPyTorch実行かtext embeddingの差し替えが必要 | **推奨**。現行のYOLO26・Ultralyticsと同系で、上流の改修量が最も小さい |
| **SAM 3**（Meta、2025-11） | 名詞句や見本画像で、該当するすべての個体をマスク付きで返す。PCSのベンチマークでOWLv2の約2倍。モデルが大きく（約8.5億パラメータ）、GPU前提。ROCm（Ryzen AI MAX+ 395）で動くかは未確認 | 精度は最上位。上流ホストで動けば第2段階の候補 |
| Grounding DINO / OWLv2 | 古くからある文字指定の検出 | YOLOE-26とSAM 3に劣る。採用しない |
| **画像対応LLM（VLM）による位置推定** | Qwen3-VL系は 0〜1000 の正規化座標で bbox のJSONを返せる。柔軟だが遅く、座標の精度は専用検出器に劣る（GroundingMEで最上位モデルでも正答45.1%） | 検出器の代わりにはしない。§4で「画像を見て答える」ために使う |
| モデルサイズ拡大（YOLO26n → s/m） | 80クラスのまま精度が上がる。上流の設定変更だけ | 第1段階で効果が大きく、手間も小さい |

**結論**: 対象の指定は上流のYOLOE-26への切替で実現できる。ただし上流は外部サービスのため、Eumenes側だけでは実現できない。上流への依頼（§5.1）と、Eumenes側の契約・画面の拡張（§5.2）に分ける。

日本語の「マグカップ」を英語の名詞句「mug」に直す処理は、検出モデルの文字エンコーダが英語で学習されているために必要。この変換はLLMが行う（音声の依頼ではcommand担当のLLM、画面の入力では会話LLMは介さず利用者の入力をそのまま送り、上流が受け付けない文字ならエラーにする。§7 Q3）。固定の和英辞書や物体名による分岐は追加しない。

## 4. 調査：画像と結果をLLMへ渡す方法

### 4.1 利用場面（利用者決定 2026-10-18）

LLMに見てもらいたい場面で、Macのカメラ映像または画面キャプチャを静止画1枚にし、その画像について話す。例:「今日の服、どう見える？」。物体認識（OpenCV/YOLO）の検出結果は、LLMの判断を補強するメタ情報として画像と一緒に渡す。

- 画像は撮影・キャプチャ・選択した**静止画1枚をそのまま**送る。動画のフレーム取り出し、枠や番号の注釈画像、検出枠での切り抜きは行わない。動画内の時刻の連続性は扱わない（物体認識そのものの動画解析は現行のまま残す）。
- **OCRは独立した機能として残す。** 物体認識からOCRへ回す連携は作らない（画面キャプチャの文字起こしはOCRの画面で行う）。
- 会話の推論先が画像に対応していない場合は、受け渡しできないので失敗を表示する（Q1決定）。

### 4.2 再利用できる部品

- `conversation.uploadAttachment(conversationId, id, file)`: 同じidと同じ内容なら再利用、内容が違えば `request_conflict` を返す。上限は1枚3 MiB・16MP・長辺8192（`attachmentLimits`）。
- チャット欄の下書き画像 `DraftImage {id, file, url, saved?: Attachment}`（`web/src/workspace/useChatAttachments.ts`）: 保存済みの添付（`saved`）を持てるので、backendで作った添付を下書きに載せられる。
- `dialogue.submit({text, conversationId, requestId, attachmentIds})`: 本文と画像を同じ受付処理で発言・run・jobとして保存する。
- 推論側の `llm.vision` 判定と `chatInput` の上限検査。
- カメラ: DesignSystemの `useCameraCapture`（`getUserMedia`、明示操作で開き、非表示・アンマウントで解放）。
- 画面キャプチャ: ブラウザの `navigator.mediaDevices.getDisplayMedia()`。現在は未使用。

### 4.3 画面キャプチャの実現性

- Webアプリ（ブラウザ）のまま実現できる。`getDisplayMedia()` でブラウザの共有選択（画面全体・ウィンドウ・タブ）を出し、得た映像の現在フレームをcanvasに描いて静止画にする。
- 開始には**クリック等の利用者操作が必要**（ブラウザの制約）。音声だけで共有を開始することはできない。一度開始した共有は、Artifactが表示されている間は維持できる。
- macOSでは初回にブラウザへの「画面収録」許可が必要（システム設定）。
- Retina画面の全体キャプチャは1,400万画素を超えることがあり、3 MiB・16MPの添付上限を超える。キャプチャ時にブラウザで長辺2560pxまで縮小し、JPEGにする。backendでも添付の上限を超える画像は縮小・変換してから添付にする。
- カメラと同じ規則で扱う。明示操作で開始し、終了・非表示・アンマウントで共有を止める。共有中は画面に表示する。

## 5. 実現方法

### 5.1 上流（object-recognition-host）への依頼（Eumenesでは実装しない）

依頼する契約案。正本は上流の共通Pageに置き、合意後にEumenes側を実装する。

- `POST /api/analyze` に任意のmultipart項目 `targets`（JSON配列、英語の名詞句、1〜20件、各60文字以内）を追加する。省略時は現行の80クラスと同じ動作。
- 応答の画像・動画結果に `vocabulary: {mode: "closed" | "open", targets: string[]}` を追加する。`label` は指定した名詞句と一致させる。
- 検出モデルはYOLOE-26（サイズは上流が実測して決める）。80クラスの経路もn→s/mに上げるか検討を依頼する。
- 上限（件数・文字数）と処理時間の目安を `/api/analyze` の文書で公開する。

### 5.2 Eumenes：対象指定（上流の対応後）

| 層 | 変更 |
| --- | --- |
| contracts | 入力に任意の `targets`、結果に `vocabulary` を追加。結果の検査は現行の座標検査を維持する |
| repository | migrationを追加し、入力レコードに `targets` を保存する（既存のmigrationは変更しない） |
| gateway | `targets` があればmultipartに追加する。上流が未対応（400/422）なら `recognition_targets_unsupported` で失敗させ、指定を外して再送しない |
| メタ情報 | 「80クラス」の固定文をやめ、§5.3のメタ情報JSONの `vocabulary` で伝える |
| 画面（DesignSystem `ObjectRecognitionWorkspace`） | 撮影ボタンの上に「探す物」のチップ入力。空なら全般検出 |
| toolchain（bundle＋adapter） | `object-recognition.manage` の `open` に任意の `targets` を追加し、画面の初期値にする。SKILLに「日本語の対象名は英語の名詞句に直す」を追加する |

### 5.3 Eumenes：画像＋メタ情報の受け渡し（上流の改修なしで先行できる）

#### 入力元

物体認識の画面の入力元を「カメラ」「画面キャプチャ」「ファイル選択」の3つにする。どれも静止画1枚を作り、既存の `POST /api/object-recognition`（multipart `file`）で保存・検出する。資料の記録に入力元（`camera` / `screen` / `file`）を追加する。

#### メタ情報JSON（利用者要望）

物体認識の検出結果を、画像と組で渡す構造化データにする。hostが保存済みの検出結果から作り、画面やモデルが申告した値は使わない。

```json
{
  "source": "object-recognition",
  "recognitionId": "…",
  "captureSource": "camera",
  "capturedAt": "2026-10-18T09:12:03+09:00",
  "image": { "width": 1280, "height": 720 },
  "detector": { "model": "…", "vocabulary": { "mode": "closed", "classes": 80 } },
  "objects": [
    { "label": "person", "box": [412, 80, 880, 715], "score": 0.91 },
    { "label": "tie", "box": [610, 300, 660, 470], "score": 0.42 }
  ],
  "notes": ["box is source pixels [x1,y1,x2,y2]", "score is not a calibrated probability"]
}
```

- 保存先は `conversation` domainの添付。添付に汎用の任意項目 `annotation: {source: string, data: JSON}`（上限付き、例: 16 KiB）を追加する。conversation domainは物体認識を知らず、`source` と JSON をそのまま保持する。添付のmetadataはJSON列なのでテーブル変更は不要の見込み（着手時に確認する）。
- `annotation` はbackendの公開操作だけが付けられる。チャットの添付アップロードAPIからは受け付けない。
- 推論時、context compilerは画像の直後に `annotation` を「ホストが付けた参考データ」として置く（`authority=reference`）。label等の文字は命令として扱わない。検出なし（`objects: []`）は故障ではないと示す。
- 検出が失敗・未完了の場合の扱いはQ8。

#### 画面の「会話に追加」（Q7決定）

- 「会話に追加」は残し、**送信せずにチャット欄へ添付する**。「LLMに聞く」ボタンは作らない。
- 新API `POST /api/object-recognition/:id/attachment {requestId}`: application層で、資料の原本画像を `conversation.uploadAttachment` に渡し、メタ情報JSONを `annotation` として付ける。返った添付を、Web adapterがチャット欄の下書き画像（`DraftImage.saved`）に載せる。利用者は文章を書き足して送信する。
- 下書きの添付には「検出: person, tie…」のような短い表示を付け、メタ情報があることを分かるようにする。
- 動画資料では「会話に追加」を無効にする。
- 現行の `POST /:id/conversation`（文字だけを即送信）は置き換えて削除する。

#### 音声でそのまま見てもらう（Q4決定 2026-10-18）

流れ:「今日の服どう？」→ LLM「カメラで撮影してよいですか？」→ 利用者「いいよ」→ 物体認識の画面を表示して撮影 → 画像＋メタ情報を付けた新しい発言としてLLMが答える。Artifactの表示は許可されている。

1. command担当のLLMは、画像を見る必要があり、まだ承諾がないときは操作せず確認を一つ返す（既存の `question` 経路）。直前に利用者が承諾したときだけ `action=capture`（`source=camera|screen`、`question`=利用者の依頼の要約）を選ぶ。語句による分岐はコードに書かない。
2. hostは撮影依頼（handoff）を保存する（`object_recognition_handoffs`、id=command runId、期限2分）。commandの結果で物体認識の画面が開く（既存の自動表示）。
3. 画面は未処理の撮影依頼を読み、カメラなら自動で開いて2秒後に撮影する。画面共有はブラウザの制約で操作が必要なため「画面を共有して撮影」ボタンを出す。「撮影しない」で依頼を取り消せる。
4. 撮影した画像は既存の受付で保存・検出する。検出が終わる（完了・失敗・取消）と、画面が `POST /api/object-recognition/handoffs/:id/send {recognitionId}` を呼ぶ。application層が画像を添付として作り、メタ情報を付けて `dialogue.submit` する。requestIdと添付idはhandoff idから決めるので、再送しても重複しない。
5. 画面で見ている保存済みの画像について聞かれたときは、command担当が `action=ask`（`id`・`question`）を選ぶ。hostは対象資料付きのhandoffを保存し、画面が同じ `send` を呼ぶ。

**表示中の資料（Q5決定）**: 物体認識の画面で画像資料を選んでいるときだけ、Webが `viewing {artifactRevisionId, targetRef: <資料id>}` を送信に付ける。command担当のsnapshotでは、hostが所有を確かめた資料にだけ `shown: true` を付ける。

**検出できなかったとき（Q8決定）**: 画像はそのまま送り、メタ情報は `{}` とする。

**旧形式の改訂**: 物体認識は旧形式のツールチェーンなので、既存revisionは変えずに profile・skill・tool・package・toolchain の revision 2 を追加する（tool schemaは新キー `recognitionManageV2`）。画面のbundleも artifact revision 2 として追加する。

### 5.4 安全面

- 添付・メタ情報・資料名は参考データとして扱う（既存の主モデル指示を維持する）。
- 所有者はhostが決める。モデルや画面からowner・URL・ファイルパスを受け取らない。
- 画面共有はブラウザの共有選択でのみ開始し、共有中を常に表示する。非表示・アンマウントで止める。共有映像は送信時の静止画1枚以外を保存しない。
- 撮影依頼は期限2分。期限切れ・取消済みの依頼では送らない。自動撮影はカメラのみで、画面共有は利用者の操作で始める。
- 接続設定の変更後や取消後の結果を、メタ情報に採用しない。
- ログに画像・質問本文・メタ情報を出さない（`docs/logging.md`）。

## 6. 実装順と検証

| 段階 | 内容 | 依存 |
| --- | --- | --- |
| P1 | conversation：添付の `annotation`、context compilerでの表示 | なし |
| P2 | object-recognition：入力元の記録、メタ情報JSON、`/:id/attachment`、旧 `/:id/conversation` の削除 | P1 |
| P3 | 画面：画面キャプチャ入力、「会話に追加」→チャット欄添付、下書きの検出表示、bundle改訂 | P2 |
| P4 | 音声：revision 2（`capture`・`ask`）、撮影依頼（handoff）と画面の自動撮影、`viewing` | P2 |
| P5 | §5.1 上流への依頼文の作成（利用者が上流へ渡す） | なし |
| P6 | §5.2 対象指定 | 上流の対応 |

検証は `bun run verify -- --domain object-recognition` に加え、`conversation`・`dialogue`・`capabilities` を確認する。API結合は `api/application/media/object-recognition-e2e.test.ts` に、添付とメタ情報が作られること、再送で重複しないこと、チャットのアップロードAPIから `annotation` を付けられないこと、画像非対応の推論先で失敗すること、動画資料を拒否することを追加する。ブラウザは `tests/browser/object-recognition.spec.ts` を個別に実行し、画面共有はChromiumの自動選択フラグで固定試験する。liveは実カメラ・実画面共有で「今日の服」の質問に画像の内容に依存する回答が返ることを確認する。fixture・live・実機器の結果は分けて記録する。

## 7. 要合意事項

| # | 論点 | 状態 |
| --- | --- | --- |
| Q1 | 推論先が画像非対応のとき | **決定**: 失敗を表示する |
| Q2 | 添付する画像 | **決定**: 静止画1枚をそのまま。動画・注釈・切り抜きなし |
| Q3 | 画面で入力した対象名の英訳 | 未決（§5.2、上流の対応後） |
| Q4 | 音声で「そのまま見てもらう」方式 | **決定**: LLMが撮影の可否を聞き、承諾後に画面を表示して撮影（§5.3） |
| Q5 | `viewing` の範囲 | **決定**: 物体認識の画面で画像資料を選んでいるときだけ |
| Q6 | 上流のモデル | 未決。推奨YOLOE-26、SAM 3は第2段階 |
| Q7 | 「会話に追加」 | **決定**: 残す。送信せずに画像＋メタ情報をチャット欄へ添付。「LLMに聞く」は作らない |
| Q8 | 検出できなかったときの送信 | **決定**: 画像をそのまま送り、メタ情報は `{}` |
| Q9 | OCR連携 | **決定**: 作らない。OCRは独立した機能 |


## 8. 出典

- [YOLOE-26 論文（arXiv 2602.00168）](https://arxiv.org/pdf/2602.00168)、[Ultralytics YOLOE](https://docs.ultralytics.com/models/yoloe)、[PyImageSearch: YOLOE-26](https://pyimagesearch.com/2026/08/24/yolo26-open-vocabulary-object-detection-with-yoloe-26/)
- [SAM 3: Segment Anything with Concepts（arXiv 2511.16719）](https://arxiv.org/pdf/2511.16719)
- [Qwen3-VLの検出座標（JAMK）](https://arena.jamk.fi/en/arena-pro/qwen-vl-vlms-for-zero-and-few-shot-object-detection/)、[GroundingME（arXiv 2512.17495）](https://arxiv.org/pdf/2512.17495)、[Roboflow: Qwen3-VLのopen-vocabulary検出](https://blog.roboflow.com/use-qwen3-vl-in-google-colab/)

## 9. 実装記録（2026-10-18、§5.3）

実装済み（fixture試験まで）。§5.1・§5.2（対象指定）は上流の対応待ちで未着手。

| 範囲 | 実装 |
| --- | --- |
| conversation | 添付に任意の `annotation {source,data}`（16 KiB以内）。公開のアップロードAPIからは付けられない |
| dialogue | `withAttachmentNotes` で利用者の本文の後にメタ情報を画像順に置く。command担当の物体認識snapshotへ run の `viewing` を渡す。`recognitionResult` の指示に capture/ask を追加（golden 21件を更新、差分はこの一文のみ） |
| object-recognition | 入力元 `origin`、撮影依頼テーブル（migration `object-recognition/0002-handoffs`）、`/:id/attachment`・`/handoffs`・`/handoffs/:id/send`・`/handoffs/:id/cancel`。旧 `/:id/conversation` と `conversationText` は削除 |
| application | `recognition-sharing.ts`：画像を添付に変換（WebP・上限超過はJPEGに縮小）し、メタ情報を付けて添付・submit。添付idとrequestIdは依頼idから決める |
| capabilities | skill・tool（`recognitionManageV2`）・package・toolchain の revision 2、画面 artifact revision 2。@1 は変更なし |
| voice-dialogue | 発言の確定（commit）に `viewing` を追加し、`submitVoice` へ渡す |
| Web | 入力元に画面共有、撮影依頼の表示・自動撮影・取りやめ、「会話に追加」でチャット欄へ添付（検出の短い表示付き）、表示中の画像を `viewing` として入力・音声の発言に付ける |

検証（fixture）: `bun run verify -- --domain object-recognition`・`conversation`・`dialogue`・`capabilities`・`voice-dialogue` 成功。API結合 `api/application/media/object-recognition-e2e.test.ts` 3件、DesignSystem部品12件、Web runtime 4件、Web workspace・toolchain-artifacts・OCR 111件成功。

未実施: ブラウザE2E（`tests/browser/object-recognition.spec.ts` は新しい「会話に追加」に合わせて更新したが、試験用サーバーの起動が必要なため未実行）、実LLM（画像対応モデル）でのlive、MacBook実カメラ・実画面共有の受入、自然言語での「撮影してよいですか？」→承諾→撮影の受入。

既知の担当外の失敗: `client/test/integrations.test.ts` の run を返す3件（OCR既存2件を含む）は、別作業で run schema に追加された `specialistSessionId` が試験データにないため失敗する。

### 9.1 独立レビューと修正（2026-10-18）

重大な指摘はなし。次を一度で修正し、fixture試験で確認した。

| 指摘 | 修正 |
| --- | --- |
| 撮影後の画像付き発言が再び撮影依頼になるループ | 発言に画像が付いていれば capture/ask は依頼を作らず `already_attached` を返す（hostで判定）。回答の指示に「添付済みの画像で答える」を追加。golden 21件の差分はこの一文のみ |
| 並行した `open()` の失敗が後の stream を止める | 失敗時に世代を確認し、古い要求は何もしない |
| 再読み込み・別タブで2枚目を撮る | アップロード時に `handoffId` で依頼へ紐付け。紐付け済みの依頼は自動撮影しない |
| 検出が多いとメタ情報が16 KiBを超える | score上位100件、boxを整数に丸め、切り詰めを `notes` に書く |
| 縮小した添付とboxの座標系がずれる | 縮小時は `attachedImage{width,height}` を加える |
| 送信中の取りやめが効かない | 添付の準備後、送信直前に依頼の状態を確認 |
| 撮影失敗後に何も出ない | 「撮影し直す」ボタン |
| 不正JSONで500 | 400で返す |

残す事項: capture はLLMの承諾判断に依存する（2秒のカウントダウンと「撮影しない」、画面共有のクリック必須で緩和）。履歴の画像ごとにメタ情報がプロンプトに再掲される（1件あたり上限内）。artifact revision 1 の画面を開いたままのタブでは「会話に追加」が入力schemaの違いで拒否される（再読み込みで revision 2 になる）。

補足: §9 の実装は、別作業のコミット `b3bf62e7` に含まれてコミット済み。§9.1 の修正は未コミット。
