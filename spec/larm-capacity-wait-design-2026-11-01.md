# LARMの空き待ち（オンデマンド起動の機能共通）設計

## 状態

合意済み・実装済み・fixture検証済み（2026-11-01、§8）。利用者がLARMの統一の拒否を決定し（「HTTP 503 / code: resource_exhausted resource: memory を統一規格として返す様にします。その想定で実装してください」）、P0の契約が確定した（§4.1）。サーバーの再起動とlive・実機器の受入は未実施。

利用者の依頼（2026-11-01）:
- 「ちょうど3Dモデルを作る推論が走ってる時に、画像生成を依頼した所、APIは待機するのではなく、即座に失敗する動きになりました。リソースの空きを待つ機能を追加したい」
- 「そのエラー次第では、LARMのメモリー解放待ちとして待機状態にし、30秒毎にポーリングチャレンジする様にできますか？」
- 「はい。その方針でいいです。オンデマンド起動で動く機能全般にこれを入れたいです。計画書を作成してください。」
- 「独自でリクエスト入れ直しがあると2重リクエストになるので、今回のロジックのみで再リクエストする形にリファクタリングもしてください」（§4.7）

関連: [LARM接続](../docs/larm.md)（`docs/larm.md:5` 制作の300秒、`:7`・`:102` 生成POSTを自動再送しない）、[TTSの1本化](tts-single-lane-design-2026-11-01.md)（TTSの429は同書のD2で扱う）、[3D生成](instant-3d-model-toolchain-design-2026-10-18.md)、[文章ナレッジベース管理](docling-artifact-on-demand-2026-10-27.md)。

## 1. 観測

| 時刻（JST） | 起きたこと | 根拠 |
| --- | --- | --- |
| 2026-11-01 06:09:43 | 画像生成（image `49a6909b`、job `45937e2f`）が開始1.4秒で失敗。同時に3D生成が実行中（利用者の報告） | `queue.execution_failed`・`queue.settled status=failed` |
| 同上 | 保存された失敗コードは `larm_http_503`。LARMは503を返したが、本文のコードは `image_model_unavailable` ではない（または読めない形）。契約にある409 `media_variant_busy` でもない | `image_generations.record_json.errorCode`、`queue_jobs.error_code` |
| 同上 | LARMの拒否コードはログにもDBにも残らないため、実際のコードは分からない | `image-generation.ts:49` が `larm_http_<status>` に丸める |
| 06:05〜06:07 | `POST /v1/agent-connections` が30秒ごとに409（接続の保持・先行準備）。コードは記録されず `larm_control_409` だけ | `larm.control_rejected` |

これまでの失敗の記録（DB）に、メモリ不足を表すコードは1件も残っていない（画像 `larm_http_503`・`larm_http_400` 各1件、音楽 `deadline_exceeded` など）。

## 2. 対象の機能と今の動き

オンデマンド起動のどの機能も、依頼した時点でLARMに断られると待たずに失敗する。待つのは、接続確保（claim）での409の再試行、3Dの429、OCR・物体認識の照会の再試行だけ。`Retry-After` を読むのは3D（`mesh-library.ts:44`）とcompute（`compute-client.ts:115-122`）だけ。

| 機能 | 入口 | LARMの呼び方 | キュー（kind・資源・期限） | 今の拒否の扱い | 画面の表示 |
| --- | --- | --- | --- | --- | --- |
| 画像生成 | `image/service/handlers.ts:180-241` | 接続（`provider-connection.ts:50-88`）→同期POST（`image-generation.ts`） | `image.generate`・`image.generate`(1)・run期限−15秒（`image/service/index.ts:31-48`） | 409 `media_variant_busy`・503 `image_model_unavailable` は専用コード、ほかは `larm_http_<status>`。再試行なし | `use-image-creation.ts:137-147`。429・503は文言なし |
| ジャケット画像 | `music/service/artwork.ts:45-134` | 画像生成と同じ経路 | `music.artwork`・`image.generate`(1)・受付+300秒（`:148-158`） | 画像生成と同じ。再試行なし | `MusicWorkspace.tsx:181-185`。コードを出さない |
| 音楽・効果音 | `music/service/handlers.ts:154-273` | 202＋job照会（`playground.ts:382-404`、`musicJob` `:260-341`）。効果音は同じendpointの `task:"sound-effect"`（`music-request.ts:40-45`） | `music.generate`・`music.generate`(1)・run期限−15秒（`music/service/index.ts:41-66`） | 409・429は `larm_http_<status>`。**503は `generation_unknown`**（`playground.ts:398-401`）。再試行なし | `use-music-creation.ts:118-136`。409・429・unknownは文言なし。phaseを表示しない |
| 3D生成（送信） | `model3d/service/handlers.ts:122-232` | 202＋job照会。LARM内で `waiting_gpu` として待つ | `model3d.submit`・`model3d`・60分 | 429は `Retry-After` で待つ。503は `model3d_unavailable`、409は `model3d_idempotency_conflict` で失敗（`:41-75`） | `model3d/contracts/index.ts:77-79` |
| 詳細分析（OCR・物体認識の画面） | `ocr/service/analysis-handler.ts:31-171`、`object-recognition/service/analysis-handler.ts:31-171` | 接続＋claim＋推論POST（`visual-perception.ts:135-312`） | `ocr.analysis`／`object-recognition.analysis`・`vision.perception`(1)・+360秒 | 接続作成の409・429・503は `larm_http_<status>`。claimは503 `provider_semantic_not_ready`・409 `connection_not_ready` だけ1秒ごとに再試行（`visual-claim.ts:20-63`） | `VisualAnalysis.tsx:31-44` |
| OCR・物体認識の解析 | `ocr/service/handlers.ts`、`object-recognition/service/handlers.ts:44-113` | gatewayの `POST /api/analyze`→job照会（`gateway.ts:12-63`） | `<domain>.analyze`・`ocr`／`object-recognition`・+600秒 | 429・503は `ocr_busy`／`recognition_busy` で失敗。照会だけ3回まで再試行 | `OcrPanel.tsx:9-20`、`CaptureControls.tsx:11-22`「混雑しています」 |
| Excalidraw | `excalidraw/service/index.ts:42-108`、会話からは `operations.ts:235-300` | Local Servicesのlease（`local-services.ts:76-87`）＋起動待ち180秒 | 会話からだけ `excalidraw.open`・`excalidraw.connect`(1)・run期限−15秒。画面からの開始はキューなし | 拒否は `local_service_http_<status>`。会話の操作は `excalidraw_start_failed`。再試行なし | `DrawingArtifact.tsx:175-176`。コードを使わない |
| 文章ナレッジベース管理（Docling Desk） | `docling/service/index.ts:23-133` | gatewayの `POST /auth/ui-tickets`（gateway側で最大180秒の起動待ち） | なし（画面から同期） | 401・403以外は `docling_upstream_failed`（502）。自動再試行しない（`docling-artifact-on-demand-2026-10-27.md:55`） | `toolchain-adapter.tsx:71-82`「起動を再試行」 |

LARMのエラー本文の読み方は場所ごとに違う。`image-generation.ts:37-43` は `error`（文字列）→`error.code`→`code`、`visual-claim.ts:28-29` は `error`→`error.code`（`code` を読まない）、ほかは本文を読まずに捨てる。

## 3. 目標

| # | 目標 |
| --- | --- |
| G1 | LARMが「今は空きがない」と断った依頼は失敗にしない。「LARMの空き待ち」の状態にして、30秒ごとに同じ依頼を送り直す |
| G2 | 「空きがない」かどうかの判定はlarm domainの1か所（契約表）で行う。各機能は共通の判定結果を受けて待つ |
| G3 | 空き待ちの時間は、制作の300秒など各機能の処理時間とは別に数える。上限は最初に断られてから30分 |
| G4 | 待っている間は、画面に「LARMの空き待ち」と分かる状態を出す。上限まで空かなかった失敗は、ほかの失敗と区別する |
| G5 | LARMの拒否コードを記録して、契約にない拒否も後から分かるようにする |
| G6 | 対象の機能でLARMへ依頼を送り直すのは、共通部品の規則（§4.2）だけにする。各機能・キュー・Webが独自に送り直す仕組みは消す（§4.7） |

## 4. 設計

### 4.1 契約: 「空きがない」応答（確定）

利用者の決定（2026-11-01）により、LARMは§2のすべてのAPI（接続作成・claim・Local Servicesのlease・gatewayを含む）で、メモリに空きがないとき次の統一の形で断る。この拒否は依頼を受け付ける前に返るので、同じ依頼を送り直しても二重にならない。

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 30
Content-Type: application/json

{"error":{"code":"resource_exhausted","resource":"memory","message":"..."}}
```

| 条件 | 扱い |
| --- | --- |
| 状態503、かつコード `resource_exhausted`、かつ resource `memory` | 空きなし。待機に入る |
| コードと resource の位置 | `error`（文字列）→`error.code`→`code`、resource は `error.resource`→`resource` の順に読む |
| `Retry-After` | 秒またはHTTP日付。省略時は30秒、上限300秒 |
| 503でもコードかresourceが違う（`image_model_unavailable`、resource `gpu` など） | 待たない。今までどおり |
| 429、409（`media_variant_busy` を含む） | 待たない。今までどおり |

状態コードだけでは待たない。

### 4.2 共通部品（larm domain）: 送り直しの唯一の窓口

対象の機能がLARMへ依頼を送り直すのは、次の3つの規則のどれかに当たるときだけとする。どの規則に当たるかは共通部品が決める。各機能のコードは規則の結果を受け取るだけで、自分では送り直さない。

| 規則 | 当たる条件 | 送り直し方 | 上限 |
| --- | --- | --- | --- |
| 空きなし | 契約表の `capacity` に載った拒否（§4.1） | 同じ内容を、30秒後（`Retry-After` が長ければその時刻）に新しく送る。キューで動く機能はジョブを入れ直し（§4.3）、画面から動く機能はWebが送る（§4.4） | 最初の拒否から30分 |
| 準備中 | 契約表の `not_ready` に載った拒否。同じ接続でのclaimに限る（今の `visual-claim.ts` の503 `provider_semantic_not_ready`・409 `connection_not_ready`） | 同じ接続に、1秒後にclaimを送る。新しい接続や依頼は作らない | 機能の準備待ち時間（詳細分析は120秒） |
| 応答の喪失 | 通信断・時間切れで、応答が届かなかった。対象は、同じ `Idempotency-Key` を同じ依頼として扱うことがLARMの契約で決まっているAPIだけ（接続作成、3D送信） | 同じキー・同じ本文で、1回だけ送る。LARMの中では2つ目の依頼にならない | 1回 |

上の3つに当たらない失敗では送り直さない。キューの再実行（`classify` の `"retry"`、`recovery: "replay_safe"`）でも送らない。

| 部品 | 置き場所 | 内容 |
| --- | --- | --- |
| 契約と定数 | `api/domains/larm/contracts/capacity.ts`（新規） | §4.1の統一の拒否（`LARM_CAPACITY_REFUSAL`）、コード `larm_capacity_busy`・`larm_capacity_timeout`、状態 `waiting_capacity`、`LARM_CAPACITY_RETRY_MS = 30_000`、`LARM_CAPACITY_WAIT_LIMIT_MS = 1_800_000`、`Retry-After` の上限 `300_000`、次の試行を決める `planCapacityWait` |
| 拒否の読み取り | `api/domains/larm/service/resend.ts`（新規） | `checkRefusal(response, path)` は拒否の本文を最大16 KiB・1秒で読み、空きなしなら `LarmCapacityBusy`（`retryAfterMs` 付き）を投げ、ほかは `larm.refused` に記録して呼び出し元へ返す。読み済みの本文には `capacityRefusal(status, body, headers, path)` を使う |
| 準備中・応答の喪失 | 同上 | `claimWhenReady`（同じ接続へのclaim）、`sendAgainIfLost`（同じキーで1回。送るたびに時間切れの時計を作り直すため、呼ぶ側が `send` の中で signal を作る） |
| 呼び出し側の変更 | `playground.ts` の control（受け付けない状態のとき）、`image-generation.ts`、`playground.ts` の音楽POST（空きなしを `generation_unknown` にしない）、`provider-connection.ts`（接続作成）、`visual-perception.ts` の control・`visual-claim.ts`、`local-services.ts`、`mesh-library.ts`（3D）、`ocr`・`object-recognition` の `gateway.ts`、`docling/service/index.ts` | LARMへの依頼は必ずこの部品を通す |
| 依存の宣言 | `scripts/domains.ts` | model3d の api 依存に larm を足す。docling は tier 0→1 にして larm を足す（docling・model3d に依存する domain はない） |

送り直しの間隔は30秒とする。`Retry-After` が30秒より長いときはそれに従い、上限は300秒とする。

### 4.3 キューで動く機能の待ち方

対象: 画像生成、ジャケット画像、音楽・効果音、3D送信、詳細分析、OCR・物体認識の解析、Excalidraw（会話から）。3D送信の `{ waitMs }` の仕組み（`model3d/service/handlers.ts:230-232`）と同じ形にする。

| 段階 | 動き |
| --- | --- |
| 実行 | ハンドラーは `larm_capacity_busy` を受けたら失敗にせず、`{ capacityWait: retryAfterMs }` を結果として返す。接続はこの時点で解放されている（`withAgentConnection` は `finally` でDELETEする） |
| 決着 | 初回なら `capacityWaitStartedAt` を記録し、待った回数を数える。状態を `waiting_capacity` にする |
| 入れ直し | 同じ段のジョブを `availableAtMs = now + max(30秒, Retry-After)` で積む。dedupeKeyは `<id>:<stage>:w<回数>`、`maxAttempts` は1のまま。記録の `queue_job_id` と、会話runとのつなぎ（`onJob`）を新しいジョブに付け替える |
| 期限 | 機能の期限を `次の試行時刻 + 処理時間` まで延ばす。処理時間は画像・ジャケット画像・音楽が300秒、詳細分析が360秒、OCR・物体認識が600秒、Excalidrawが起動待ちの180秒。ただし `capacityWaitStartedAt + 30分 + 処理時間` を超えない |
| 会話run | 新しい `onWaiting(db, runId, untilMs)` を application（`server-media.ts:46-57` など）からdialogueにつなぎ、既存の `extendRunDeadline` で延ばす。呼び出し元が期限を固定したrun（`deadlineFixed`）と委任タスクの予算（`task-media-execution.ts:100-107`）は延ばさない |
| 打ち切り | 次の試行が30分の上限を超える、または延ばせない期限を超えるときは、`larm_capacity_timeout` で失敗にする |
| 取消 | 待っているジョブは `queued` のままなので、既存の取消でそのまま取り消せる。取消後は送らない |
| 再起動 | 待っているジョブは `queued` で保存されているので、再起動後も時刻が来れば続きから再開する |
| 成功 | 空いて受け付けられれば、今までどおり生成・結果取得・採用へ進む |

会話の流れは変えない。会話runは制作が終わるまで開いたままで、完了の知らせも今までどおり出す。画像ジョブには会話ごとの順番の鍵（`concurrencyKey`）がないので、待っている間も同じ会話の次の発言は処理される（P1の結合試験で確かめる）。

LARMの中での順番は保証しない。空いた直後に、待っていた複数の依頼（画像と音楽など）のうち、先に届いたものが通る。

### 4.4 画面から直接動く機能の待ち方

対象: 文章ナレッジベース管理（Docling）と、画面から開くExcalidraw。どちらもキューを使わず、保存する状態もない。

| 段階 | 動き |
| --- | --- |
| backend | 空きなしの拒否を受けたら、HTTP 503 `{"error":"larm_capacity_busy","retryAfterMs":30000}` を返す |
| Web | アーティファクトを開いている間は「LARMの空き待ち」を表示し、`retryAfterMs` 後に同じ要求を送り直す。最初の拒否から30分たったら止め、今の「起動を再試行」を出す |
| 閉じたとき | 待つのをやめる。backendには何も残らない |

Doclingは「自動では再試行しない」と決めていた（`docling-artifact-on-demand-2026-10-27.md:55`）。本書は、空きがないという拒否に限ってこれを変える。

### 4.5 表示

| 状態・コード | 文言 |
| --- | --- |
| `waiting_capacity`（待機中） | 「LARMの空きを待っています。ほかの処理が終わりしだい始めます。」 |
| `larm_capacity_timeout`（失敗） | 「LARMの空きを待ちましたが、待てる時間内に空かなかったため中止しました。」 |

| 場所 | 変更 |
| --- | --- |
| `web/src/domains/image/use-image-creation.ts:137-147` | phaseが `waiting_capacity` のときは待機中の文言を出す。失敗コードの対応表に `larm_capacity_timeout` を足す |
| `web/src/domains/music/use-music-creation.ts:118-136` | 待機中を表示する（今はphaseを表示していない）。`larm_capacity_timeout` を足す |
| `packages/design-system/src/components/MusicWorkspace/MusicWorkspace.tsx:181-185` | ジャケット画像の待機中と期限切れを表示する |
| `packages/design-system/src/components/VisualAnalysis/VisualAnalysis.tsx:31-44` | 同上 |
| `OcrPanel.tsx:9-20`、`CaptureControls.tsx:11-22` | 同上 |
| `web/src/domains/excalidraw/DrawingArtifact.tsx:175-176` | 待機中を表示し、§4.4のとおり送り直す |
| `web/src/domains/docling/open.ts:3-10`、`toolchain-adapter.tsx:71-90` | 同上 |
| `api/domains/model3d/contracts/index.ts:77-79` | stageの表示に `waiting_capacity` を足す |
| `api/domains/service-tests/contracts/index.ts:120-157` | サービス試用は待たず、拒否コードの文言だけ足す（§5） |
| `api/domains/dialogue/service/error-report.ts` | 理由コードの表に `larm_capacity_timeout` を足す（`docs/logging.md:120` の決まり） |

画面定義がbundleにある機能は、[登録手順](../docs/toolchain-extension.md)に従って新しい版を作り、旧版は変えない。

### 4.6 ログ

| イベント | レベル | 項目 |
| --- | --- | --- |
| `larm.capacity_refused` | info | `route`（IDは `:id`）・`status`・`larmCode`・`retryAfterMs`、実行コンテキスト（jobId・subjectId） |
| `larm.refused` | info | 空きなし以外の拒否。`route`・`status`・`larmCode`。失敗は各domainのwarnが正本なので info とする |
| `<domain>.capacity_wait_scheduled` | info | `jobId`・`subjectId`・`waitCount`・`waitedMs`・`nextInMs` |
| `<domain>.capacity_wait_expired` | warn | `reason=larm_capacity_timeout`・`waitedMs` |

`larmCode` には、`^[a-z][a-z0-9_]{0,63}$` に合うコードの文字列だけを残す。合わないものは `unknown` とする。本文・message・Providerの生応答は残さない。既知のコードだけを残す決まり（`docs/logging.md:86`）の例外になるが、契約にない拒否を見つけるために必要なため、この形に限る。

### 4.7 独自の送り直しの整理（リファクタリング）

空きなしの待機を足すと、各機能が独自に持つ送り直しと重なり、同じ拒否に対して2か所から依頼が届くおそれがある。そこで、対象の機能が持つ独自の送り直しを消し、§4.2の規則に移す。

| 場所 | 今の送り直し | 扱い |
| --- | --- | --- |
| `larm/service/provider-connection.ts:77-88` | 接続作成を、通信断・時間切れのとき同じ `Idempotency-Key` で1回送る（画像・ジャケット画像・詳細分析が通る） | 消して、共通部品の「応答の喪失」に移す |
| `larm/service/visual-claim.ts:20-63` | claimを、503 `provider_semantic_not_ready`・409 `connection_not_ready` のとき1秒ごとに送る | 消して、共通部品の「準備中」に移す |
| `model3d/service/handlers.ts:63-75`（`guarded`） | 送信と取消を、429のとき `Retry-After` 後に同じキーで送る | 消す。429が契約表の `capacity` にあれば「空きなし」で待ち、なければ失敗にする |
| `model3d/service/handlers.ts:131`・`:209`（`model3d.submit`） | `recovery: "replay_safe"`、`maxAttempts: 3`、`classify: failsOnce` により、キューが同じキーで最大3回送る。再起動のときも送り直す | `recovery: "interrupt"`、`maxAttempts: 1`、`classify: () => "fail"` にする。通信断は共通部品の「応答の喪失」で1回だけ送る。再起動で中断した送信は、同じキーの1回の回収として、共通部品を通して積み直す |
| `model3d/service/handlers.ts:286`・`:319`（`model3d.poll`） | 同上（状態の照会） | GETの照会なので依頼は増えない。ただし `replay_safe` と `failsOnce` によるキューの再実行はやめ、照会の間隔は今の `patient`（`:80-95`）の待ちだけにする |
| `model3d/service/handlers.ts:452`・`:470-481`（`model3d.cancel`） | job IDが未確定なら同じ本文を送り直してjob IDを得てから取り消す。キューが最大3回再実行する | 本文の送り直しは共通部品の「応答の喪失」（同じキー）だけで行う。キューの再実行はやめる |
| `excalidraw/service/connection.ts:42-132` | 上流への要求と操作のたびに `ready()` がleaseを確保し直す | leaseの更新は残す（同じleaseの維持で、新しい依頼ではない）。拒否されたときに、`ready()` が独自に送り直さないようにする。空きなしは§4.4のWebの1本の時計だけで送る |
| `web/src/domains/excalidraw/useDrawingEditor.ts:267-289` | 画面に戻ったとき（`onResume`）に、セッションを接続し直す | 空き待ちの間は接続し直さない。Webの時計だけで送る |
| `web/src/domains/docling/toolchain-adapter.tsx:71-90` | 手動の「起動を再試行」 | 空き待ちの間は押せなくする。止まった後（30分後）だけ押せる |
| 画像・音楽の画面（`use-image-creation.ts:25`、`use-music-creation.ts:25`、`use-music-artwork.ts:55`） | `retry: false`。自動では送り直さない | 変えない。待機中に同じ依頼を送るボタンは出さない |

送り直しではないため、次は残す。

- 状態の照会（GET）: 音楽の `musicJob`、3Dの `patient`、OCR・物体認識の `poll`、computeの照会、保存済み画像の取得。どれも依頼を新しく作らない。
- 対象外のリアルタイム系の送り直し: `establish.ts:65-77`・`:93-117`、`acquire-provider.ts:171-186`。空き待ちを入れないので重ならない。

整理の後に守る決まり:

| # | 決まり |
| --- | --- |
| R1 | 対象の機能でLARMへの依頼を送るコードは、共通部品（`larm/service/resend.ts`）を通す。ほかの場所に送り直しのループを書かない |
| R2 | 対象の機能の依頼の段のキューは、`maxAttempts: 1`、`classify: () => "fail"`、`recovery: "interrupt"` にする。照会の段もキューの再実行で依頼を送らない |
| R3 | Webは、空き待ちの間に同じ依頼を送るボタンや再接続を動かさない。画面から動く機能では、送り直しの時計を1本だけ持つ |
| R4 | 1つの拒否に対して、送り直しは1回だけ予定する。予定済みのジョブが残っている間は、次の予定を作らない（dedupeKey `<id>:<stage>:w<回数>` と、記録の `queue_job_id` で確かめる） |

## 5. 変更しないこと

- 結果が分からないとき（通信断、時間切れ、`generation_unknown`、取消後の遅い結果）は、今までどおり送り直さない。
- 契約表にない拒否（`image_model_unavailable`、400・401・403・404・422・507、契約外の409・503）は、今までどおり一度で失敗にする。
- 各機能の処理時間（画像・音楽の300秒など）の意味は変えない。空き待ちは別に数える。
- 別のモデルへの自動切替はしない。LARMの起動・停止・優先順位はLARMが決め、Eumenesは順番を予約しない。
- 会話のLLM・ASR・TTS・意図判定・表情判定・embeddingは対象外とする。常駐・保持の接続で、遅れが許されないため。TTSの429は[TTSの1本化](tts-single-lane-design-2026-11-01.md)のD2で扱う。
- サービス試用は、LARMの今の応答を見るための画面なので待たない。拒否コードの文言だけ足す。
- computeは対象外とする（モデルのオンデマンド起動ではなく、429・503は既に待つ）。
- DB migrationは行わない。待機の記録は各記録の `record_json` に足し、3Dは既存の `stage` 列を使う。
- サーバーの起動・停止・再起動はしない。

## 6. 段階と検証

| 段階 | 内容 | 検証 |
| --- | --- | --- |
| P0 | 拒否コードのログ（§4.6の `larm.refused`）を入れる。契約は利用者の決定で確定した（§4.1） | larmの固定試験（判定の条件、`Retry-After`、本文を残さないこと） |
| P1 | 共通部品（§4.2）、画像生成・ジャケット画像（§4.3）、会話runの期限延長、表示。接続作成の送り直しを共通部品へ移す（§4.7） | 固定試験（下表）。`bun run verify -- --domain larm`・`image`・`music`・`dialogue` |
| P2 | 音楽・効果音 | 固定試験。`--domain music` |
| P3 | 3D送信、詳細分析、OCR・物体認識の解析。3Dのキューの再実行・429待ちと、詳細分析のclaimの再試行を共通部品へ移す（§4.7） | 固定試験。`--domain model3d`・`ocr`・`object-recognition` |
| P4 | Excalidraw、Docling（§4.4）。`ready()` と画面復帰の再接続、手動の再試行を整理する（§4.7） | 固定試験、Webの部品試験。`--domain excalidraw`・`docling` |
| P5 | `docs/larm.md:7`・`:102`、`docs/images.md`、`docs/model3d.md`、`docs/docling.md` を更新し、各段の結果を本書に記録する | ブラウザE2Eは対象domainの試験ファイルを個別に実行する。live受入は利用者の合図の後 |

固定試験（各機能で同じ形にする）:

| # | 条件 | 期待 |
| --- | --- | --- |
| T1 | 1回目が空きなし、2回目が成功 | 30秒後に1回だけ送り直して成功する。状態が `waiting_capacity` から `completed` になり、会話runの期限が延びる |
| T2 | `Retry-After: 90` | 次の試行は90秒後になる |
| T3 | 空きなしが続く | 30分を超えて送らない。`larm_capacity_timeout` で失敗する |
| T4 | 待機中に取消 | `cancelled` になり、その後は送らない |
| T5 | 期限を固定したrun・委任タスク | runの期限を超えずに `larm_capacity_timeout` で止まる |
| T6 | 契約外の503、`image_model_unavailable`、通信断、`generation_unknown` | 一度で失敗し、送り直さない |
| T7 | 待機中に同じ会話の次の発言 | 待たずに処理される |
| T8 | 待機中に再起動 | 待っているジョブが残り、時刻が来れば再開する |
| T9 | 待機中のLARM接続 | 接続が解放されている（DELETE済み） |
| T10 | 空きなしの拒否を1回受ける（LARMの偽物で、機能ごとに依頼の数を数える） | 次の試行時刻までLARMへの依頼は0件で、試行時刻には1件だけ届く。キューの再実行・Webの再試行・画面復帰からは届かない |
| T11 | 接続作成・3D送信で応答が失われる | 同じ `Idempotency-Key` の送り直しが1回だけ届く。キューの再実行や再起動で、それ以上は送らない |
| T12 | 詳細分析のclaimが準備中 | 同じ接続へのclaimだけが1秒ごとに届き、接続の作成は1回だけ |

結果は、fixture・live・実機器の受入を分けて記録する。live受入（3D生成の実行中に画像を依頼し、空き待ちを経て完成すること）は、利用者の合図の後に行う。

## 7. 決めたこと

| # | 決定 | 理由 |
| --- | --- | --- |
| D1 | 送り直しの間隔は30秒。`Retry-After` が長ければそれに従う（上限300秒） | 利用者の指定。LARMが示す時刻より早く送らない |
| D2 | 空き待ちの上限は最初の拒否から30分で、各機能の処理時間とは別に数える | 300秒の中で待つと、5分を超える3D生成の間に間に合わない。3Dの追跡（60分）より短くし、会話runを開いておく時間を抑える |
| D3 | 対象は§2の8機能。リアルタイム系・サービス試用・computeは外す | §5の理由 |
| D4 | 期限を固定したrunと委任タスクの予算は延ばさない | `docs/larm.md:5` の「呼出元が明示した期限や委任タスクの予算は超えない」を守る |
| D5 | 待つかどうかは契約表のコードだけで決める。状態コードだけでは決めない | モデル未準備などの本当の失敗まで待たせないため |
| D6 | 対象の機能の送り直しは共通部品の3つの規則だけにする。キュー・各機能・Webの独自の送り直しは消す（§4.7） | 利用者の指示。2か所からの送り直しで、依頼が二重になるのを防ぐ |
| D7 | 同じ `Idempotency-Key` での1回の送り直し（応答の喪失）は、共通部品の規則として残す | LARMの中では同じ依頼として扱われ、二重にならない。消すと、3D生成でLARMに残ったjobを追えず、取り消せなくなる |

P1以降は、P0でLARMの契約が確定してから着手する。

## 8. 実施記録（2026-11-01）

### 8.1 実装したもの

| 範囲 | 内容 |
| --- | --- |
| larm | `contracts/capacity.ts`（統一の拒否、定数、`planCapacityWait`）、`service/resend.ts`（`checkRefusal(response, path, waitable)`・`capacityRefusal`・`sendAgainIfLost`・`claimWhenReady`）。空き待ちにするのは受付を起こす依頼だけ（接続作成・claim・画像生成POST・音楽POST・3D送信・詳細分析の推論POST・Local Servicesのlease確保・gatewayの解析POST・Doclingのticket）。照会・取得・取消・更新は空きなしでも今までどおり失敗。共通の control は待ちに変えない。`sendAgainIfLost` の2回目が空きなしで断られたら、1回目が受け付けられた可能性があるので元の喪失として報告する。詳細分析の claim の準備中は `claimWhenReady` へ移した |
| dialogue | `extendOperationDeadlineInTransaction`（固定期限は延ばさない、終わったrunは null）。エラーレポートの理由コード表に `larm_capacity_busy`・`larm_capacity_timeout` |
| 画像・ジャケット画像・音楽/効果音 | §4.3。記録の `capacityWait`、phase（ジャケット画像は `artwork.phase`）`waiting_capacity`、再開時に戻す。委任タスクは期限を延ばさない |
| 3D | 送信の空き待ち（payloadに `capacity`、stage `waiting_capacity`、再開時に stage を戻す）。429待ち・キュー再実行（submit・poll・cancel の `replay_safe`・`failsOnce`）を削除し、429 は `model3d_busy`。通信断は同じキーで1回、再起動で中断した送信も同じキーで1回だけ回収。送信中の取消は同じキーで送り直してjobを特定してから取り消す。待機中（ジョブが queued）の取消は送らずに取り消す |
| 詳細分析・OCR/物体認識の解析 | §4.3。state は `queued` のまま `capacityWait` で待機を示す。gatewayが受け付けたら `capacityWait` を消す。起動時の回収は待機中の分析を失敗にしない |
| Excalidraw・Docling | §4.4。backend は 503 `{error:"larm_capacity_busy",retryAfterMs}`。Webは共通の `web/src/hooks/capacity-wait.ts` の1本の時計で送り直し、待機中は手動の再試行・画面復帰の再接続・activity・保存を動かさない。会話からの `excalidraw.open` は §4.3 |
| 表示 | 待機中「LARMの空きを待っています。ほかの処理が終わりしだい始めます。」、打ち切り「LARMの空きを待ちましたが、待てる時間内に空かなかったため中止しました。」。サービス試用は `larm_capacity_busy` の文言だけ |
| 依存・ログ | `scripts/domains.ts`（model3d→larm、docling は tier 1 で larm）。`logger.ts` に `larmCode`・`retryAfterMs`・`waitCount`・`waitedMs`・`nextInMs` |
| 文書 | `docs/larm.md`（LARMの空き待ち）、`docs/logging.md`、`docs/images.md`・`model3d.md`・`ocr.md`・`object-recognition.md`・`docling.md`・`excalidraw.md`、[Doclingの旧設計](docling-artifact-on-demand-2026-10-27.md)の「自動再送しない」に例外を追記 |

409 `media_variant_busy` は統一の拒否ではないので、今までどおり待たない。

### 8.2 検証（fixture）

| 検証 | 結果 |
| --- | --- |
| 独立レビュー（1回） | 確定2件（3D: 待機明けの送信中の取消でLARMのjobが残る、OCR/物体認識: 受付後も空き待ち表示）、リスク4件（照会・取得にも空き待ちが効く、応答喪失後の空きなし、429での取消、回収の印の持ち越し）、nit。全件を修正し、試験を追加した。Excalidrawの拒否済みの利用単位がMapに残る点は、解放後の利用単位も残る既存の作りと同じため変えていない |
| 部分試験 | 各domainの T1〜T6・T10・T11・T12、3Dの T8、larm の判定・`Retry-After`・応答喪失・準備中・画像/音楽/3D/詳細分析の拒否、dialogue の期限延長 |
| `bun run verify -- --domain larm --domain image --domain music --domain model3d --domain ocr --domain object-recognition --domain excalidraw --domain docling --domain dialogue --domain service-tests` | 成功（152.9秒）。inventory・境界・system-context・size-budget・SQL境界・domain-docs（選択外の既存指摘1件は失敗扱いでない）・整形・lint・design-system型/build・型・bun 1,224件・web 205件・design-system 4ファイル |
| design-system の対象部品（MusicWorkspace・ExternalAppLauncher・VisualAnalysis・Model3dWorkspace） | 個別実行で成功 |

画像・音楽の T7（待機中の同じ会話の次の発言）と T8（待機中の再起動）は専用試験がない（待機は通常の queued ジョブで、会話の順番の鍵を持たない）。ブラウザE2E・live・実機器の受入（3D生成中に画像を依頼し、空き待ちを経て完成）は未実施で、サーバーの再起動は利用者が行う。

## 9. LARM再デプロイ後の実接続確認と再レビュー（2026-11-01）

### 9.1 実接続（live）

利用者からLARM側の実装完了・再デプロイの連絡を受け、動作中のbackend（今回のコードを含む）とCLIで確認した。会話ID `capacity-wait-live-20261101`。

| 時刻（JST） | 起きたこと | 結果 |
| --- | --- | --- |
| 08:17:31 | 3D生成を依頼（`32caf1a6`）。stage `image`（元画像の生成）へ | — |
| 08:18:25 | 画像生成（`9911acb9`）のPOSTに LARM が 503・`resource_exhausted`（`larm.capacity_refused`、route `/v1/images/generations`、`Retry-After` なし） | 期待どおり。phase `waiting_capacity`、`image.capacity_wait_scheduled`（waitCount 1、nextInMs 30000） |
| 08:18:25〜55 | backend が再起動（pid 99549→8672。こちらの操作ではない） | 待機中のジョブは queued のまま残り、予定時刻に再開（T8 を live で確認） |
| 08:18:56 | 30秒後の送り直しに LARM が 409 `media_variant_busy`（3D は stage `waiting_gpu`） | 統一の拒否ではないため失敗（設計どおり）。LARM側の統一が、3Dの段階によっては未適用 |
| 08:21:18 | 3D生成が完成 | — |

LARMは同じ「重い処理の実行中」でも、3Dの段階により 503 `resource_exhausted` と 409 `media_variant_busy` を返し分けている。統一規格どおりなら後者も 503 `resource_exhausted`（resource `memory`）であるべきで、LARM側の修正を利用者に依頼する。Eumenes側で 409 を待ちに加えるのは D5 の変更になるため行っていない。空き待ちから完成までの通しは、LARM側の修正後に再確認する。

### 9.2 再レビュー（二重化の観点）

同じ拒否に対して同じ依頼が2回届く経路はなし。別セッションの会話用接続（agent-capacity・generation-lanes など）は `resend.ts` を使わず、503 の独自処理もなく、重ならない。

| 指摘 | 対応 |
| --- | --- |
| Excalidraw: 一度拒否された利用単位が再接続まで送らない（保存が空いても通らない） | 拒否を時間窓（`capacityRetryMs`）に変え、窓の後は実際に送る。窓の過ぎた利用単位を `tick` で消す。activity の失敗も同じ1本の時計で待つ。試験追加 |
| 決着処理が7か所に重複し、延長の判定が少しずつ違う | `api/domains/larm/service/capacity-wait.ts` の `settleCapacityWait` に一本化（判定・ログ・打ち切り）。記録の書込み・入れ直しは各domain。延長の窓口がない場合は延ばさずに待つ、に統一 |
| Excalidraw の会話からの起動が試行ごとに新しいsessionを作る（30分で約60行） | 同じsessionを `reconnect` で起動し直す。1操作1session |
| `Retry-After` の解釈が3Dで別実装 | `resend.ts` の `retryAfter` を共用 |
| Web の定数（30秒・5分・30分・コード）の再定義 | `web/src/hooks/capacity-wait.ts` が larm contracts から読む。web の domain はこの hook 経由で読む |
| 待機・打ち切りの文言が6か所に直書き | design-system の `utils/capacity.ts` を唯一の出所にし、web と各部品が使う。api の 3D の stage 表示だけは境界のため複製のまま |
| 3D: 応答喪失の後の空きなしを失敗にしていた | 3Dは全試行で同じキーを使うので待機へ（`sendAgainIfLost(send, true)`）。到達しない busy 処理を削除。待機ログに新しいジョブIDを出す |

別セッションの範囲（報告のみ）: `agent-connections.ts` の接続 Map が増え続ける、会話用接続の拒否コードがログに残らない（`larm.control_rejected` は status のみ）、`establish.ts` の接続作成の再送が `sendAgainIfLost` と別実装。

### 9.3 検証（fixture）

`bun run verify -- --domain larm --domain image --domain music --domain model3d --domain ocr --domain object-recognition --domain excalidraw --domain docling` 成功（96.1秒、bun 786件・web 191件・design-system 4ファイル）。design-system の対象部品 104件、larm の共通部品の試験（`capacity-wait.test.ts`・`resend.test.ts`）成功。改善後のコードを live で確認するには backend の再起動が要る。
