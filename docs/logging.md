# ログの確認

backend の運用ログは Pino で1行1件の JSON にし、標準エラー出力とファイルへ同時に出します。既定は `data/logs/api.jsonl`。DB の場所を変更した場合は、その隣の `logs/api.jsonl` を使います。ログ用の SQLite テーブルは追加しません。

## 普段の調査

```sh
# まず警告・エラーを確認する（直近100件）
bun run logs -- --level warn

# 問題の run ID に関係する処理を時系列で確認する
bun run logs -- --id <run-id> --json

# 同じ行の jobId で、ジョブの開始・保存結果まで確認する
bun run logs -- --id <job-id> --json

# 再現中の新しいログを追う
bun run logs -- --follow

# 時間・処理を絞る。JSTの指定も可能
bun run logs -- --since 2026-10-08T10:00:00+09:00 --component inference --json
```

閲覧コマンドは現在のファイルと `.1`〜`.4` の世代を古い順に読み、条件に一致する最後の100件を表示します。`--limit 1000` で件数を増やせます（上限10000件）。`--id` はIDの完全一致で、関連IDを自動で辿る操作ではありません。`--follow` は追加分を毎秒表示し、世代が切り替わっても追従します。壊れた行は件数を stderr に報告し、末尾の未完了行は読み飛ばして、追従時は次回に読み直します。`--json` の stdout は JSONL のみなので、そのまま保存・解析できます。

## 追跡に使う項目

| 項目 | 用途 |
| --- | --- |
| `time` / `level` / `component` / `event` | UTC時刻、重要度、所有する処理、固定のイベント名 |
| `bootId` / `pid` / `schemaVersion` | 起動ごとの識別、プロセス、ログ形式の版 |
| `httpRequestId` | HTTP要求ごとにbackendが発行するID。レスポンスの `X-Request-Id` と一致 |
| `requestId` / `runId` / `jobId` | 入力要求、回答処理、ジョブ。`dialogue.accepted` が相互の対応を記録 |
| `taskId` / `invocationId` | 調査担当の親子taskとtool呼出し。`agent.state_changed` のrunId/jobIdと対応させる |
| `timerId` / `operationId` / `notificationId` | タイマー、その操作receipt、終了通知。ラベルや本文は出さない |
| `workTaskId` | 会話より長く保持する委任タスク。`tasks.registered`、`tasks.start_requested`、`tasks.stop_requested` とAPIのtaskIdを対応させる |
| `inferenceId` / `attemptId` / `subjectId` | 推論要求、各試行、その要求を所有するrunや発話。ASR・LLM・TTSと代替先を追う |
| `sessionId` / `utteranceId` / `generation` | 音声セッション、発話、割込みの世代 |
| `status` / `reason` / `durationMs` | 保存後の状態、処理側で定義した理由、処理の所要時間 |
| `errorFrames` | エラーの発生箇所。生のエラーメッセージは保存しない |
| `stepId` / `phase` / `controlSchema` / `controlAction` | 拒否された処理の段階・適用した契約・既知のaction名。未知のaction値は記録しない |
| `repairAttempt` / `status` | 初回は0、修正試行は1。`repair_scheduled` は修正を予約済み、`failed` は処理失敗 |
| `validationPath` / `validationCode` / `expectedType` / `actualType` / `limit` | 違反した契約項目、違反種別、期待型、実際の型、長さや件数の上限・下限。値は記録しない |
| `bytes` / `outputCharacters` / `jsonOffset` | モデル出力のバイト数・文字数。解析器が位置を返した場合のみ、trim後のJSONの文字位置 |
| `issueCount` / `reportedIssueCount` | 検出した違反総数と記録した数。詳細は先頭8件まで |
| `hitCount` / `documentCount` / `failureCount` | 検索候補、取得本文、取得失敗の件数。内容は記録しない |

画面でAPIエラーが出たときは、ブラウザのNetwork欄でレスポンスの `X-Request-Id` を確認し、`bun run logs -- --id <そのID> --json` で検索します。共通clientの `ApiError.requestId` にも入ります。CLIのAPIエラーはこのIDを stderr に表示するので、CLIの `--json` 出力を壊しません。

`inference.attempt_succeeded` や `dialogue.generation_completed` は生成の終了を示します。結果の採用・保存の確定は `queue.settled` の状態、実行記録API、音声の状態で確認します。取消や権限変更で破棄された結果を成功として扱いません。SSEのHTTPログは接続応答の開始までの時間で、接続寿命やブラウザでの再生時間ではありません。

## 調査失敗の原因

`bun run logs -- --id <会話のrunId> --json` で、検索と報告作成を分けて確認します。`agent.tool_failed` は検索・読取りなどの操作の失敗で、`reason` に `web_timeout` などの理由を残します。続く `agent.tool_completed` があれば再取得は成功しています。同じ行の `operationId` はWeb取得のrunId、`jobId` はWeb取得のjobIdです。これらで絞ると、`web.failed` の失敗理由と `web.completed` の取得件数を確認できます。`queue.settled.reason` にも保存された失敗理由を残します。会話runとWeb取得runのIDを混同しないでください。

`agent.control_rejected` はモデル出力を採用できなかった理由です。`control_non_text`、`control_empty_output`、`control_markdown_fence`、`control_output_too_large`、`control_json_syntax`、`control_schema_invalid` を区別します。構文エラーでは `validationCode` に `unexpected_end`（途中で終了）、`expected_object_end`（閉じ波括弧が必要）、`expected_property_name` など、解析器から判別できる固定の理由を残します。出力が長いことだけを理由に、トークン上限による切断とは断定しません。

契約違反の詳細は同じ `stepId` の `agent.control_validation_issue` に記録します。例えば `validationPath=report.summary / validationCode=invalid_type / expectedType=string / actualType=undefined` は、報告のsummaryが欠けていたことを示します。`arguments.url` なら読取りtoolのURL引数です。報告の根拠では `unknown_source`（取得していないsourceId）、`quote_mismatch`（引用が取得本文に一致しない）を区別します。`repairAttempt=0` と `status=repair_scheduled` の後、別stepの `repairAttempt=1` と `status=failed` があれば修正試行も失敗したと分かります。`stepId` 自体でも閲覧を絞れます。

これらの拒否ログはtransactionの確定を確認してから出します。取消後の古い結果やrollbackした拒否を確定済みの失敗として記録しません。契約にある項目名、配列の位置、型、数値の制約だけを出し、未知の項目名は `unknown` に置換します。Zodのmessage・未知のキー・モデルの値・検索語・本文・引用・エラーの生メッセージは出しません。過去に省略された診断情報を、この変更で復元することはできません。

制御出力の修正時は、確定した直前stepの診断だけをモデルにも渡します。契約の項目名・型・固定の理由だけを渡し、値や生応答は渡しません。成功した次の操作まで古い診断を引き継ぎません。

本文取得が安全検査で拒否された場合は、同じWeb run/jobに `web.acquisition_rejected` を記録します。`reason=SEGMENT_COUNT_LIMIT` は検査対象の件数上限、`CHARACTER_BUDGET_LIMIT` は検査文字数上限、`INSPECTION_INCOMPLETE` は検査が完了できなかったことを示します。ライブラリが定義した7種類の理由だけを許可し、検出箇所・本文・生メッセージや未知の理由は渡しません。拒否したページの安全検査は省略しません。

音声は同じ会話runIdで `voice.synthesis_started` → `voice.synthesis_completed` を確認します。`voice.synthesis_skipped` の `reason=auto_speak_disabled` は自動読上げ設定による省略です。`voice.processing_failed` には停止した `phase` と固定の `reason` を残します。回答の推論成功と音声合成成功は別です。取消は音声turnのcancel、`voice.session_stopping`、会話runのcancelをHTTPの `X-Request-Id` とsession/utterance/runのIDで追います。セッション停止と次の発話による割込みで進行中の回答が取り消される場合は、LLMの停止障害と区別します。

空の音声認識は `voice.input_ignored` の `reason=empty_transcript` で確認します。本文や音声は記録せず、会話runを作らずに終了します。画面の「マイクを停止」は録音だけを止め、受付済みの推論・検索・読上げを続行します。雑音の検出だけでは割り込まず、新しい認識文の会話runが受け付けられた後に以前の回答を取り消します。明示的な回答中止・権限失効・画面終了時の取消は維持します。

起動時の `capability_revision_conflict` は、`capability.revision_conflict` の `subjectId` で衝突した組込み版を確認します。定義本文や保存済みの内容はログに出しません。保存済みの旧版は保持し、ルール変更を新しいSKILL・packageの版として登録します。最新の版の内容衝突は起動失敗として扱います。

本文の検査予算は4,096区画・2,000,000文字に設定しています。通常の属性やメタデータが多いページも全区画を検査し、命令混入や検査未完了は引き続き拒否します。モデルに提示するtool参照は `web.lookup` などの短い名前です。実行時は現在のtaskに所属する許可へ解決し、内部のUUID・所有者・取消・予算の検査を通します。

## 正常系の出力量

既定は `info`。起動・復旧・終了、入力受付、ジョブと推論の開始・終了、音声処理の開始・終了とセッション開始・停止を残します。開始だけ残って終了がない処理や、遅いASR・LLM・TTSを見つけるために必要な範囲です。警告・エラーだけでは途中で止まった処理を特定できません。

成功したGET、HTTP受付の詳細、音声の細かな状態変化、チャンク生成は `debug` のみ。障害再現時は `EUMENES_LOG_LEVEL=debug bun run dev` で起動し直します。警告以上だけを保存したい場合は `EUMENES_LOG_LEVEL=warn` にします。その場合、開始・終了と所要時間による調査材料は残りません。

ブラウザの録音・再生・WebGL内部のログ収集は今回の対象に含めていません。backendログとNetwork欄でAPIまでの経路を確認し、機器側の問題はブラウザのConsoleと実機器受入で確認します。

## 保存と取扱い

`EUMENES_LOG_FILE` で保存先を変更できます。空欄は既定の保存先、`-` は stderr のみ。ファイルは10 MiBを超える前に世代を切り替え、現在分と過去4世代を保持します（約50 MiB）。ファイルの権限は `0600`、新規ログディレクトリは `0700`。ファイル保存に失敗した場合は `logging.file_unavailable` を一度 stderr に通知し、stderr出力で継続します。ファイル出力の復旧にはbackendを再起動します。

会話本文、認識結果、音声バイナリ、HTTPヘッダー・query・body、設定、認証情報、Providerの生応答は出力しません。loggerは許可した運用項目だけを通します。IDやエラー発生箇所には運用上の情報があるため、外部へ共有する前には確認してください。ログはローカルの障害調査用で、改ざん防止や永続的な監査証跡を保証するものではありません。長期保存が必要な記録は世代削除前に別途保管します。

## ツールチェーンの選択と手順キャッシュのログ

会話の判断は `dialogue.candidates_selected`(`candidateCount`・`retrieval`=fts/embedding/hybrid/none・`durationMs`)と `toolchain.selection_recorded`(`selectionId`・`runId`・`decision`・`toolchainId`)、終了は `toolchain.selection_settled`(`runId`・`outcome`・`reason`)に出ます。`web_search` の手順キャッシュは `recipe.saved`・`recipe.suspended`(`recipeId`・`toolchainId`)です。embeddingの失敗は `toolchain.query_embedding_failed`・`toolchain.vectors_refresh_failed`(1分に1回まで)で、その間は全ツールチェーンを提示して会話を続けます。登録できなかったツールチェーンは `toolchain.registration_failed`(`subjectId`・`reason`)です。

出さないもの: 発話・依頼文・候補の説明、手順のsignature・URL・読む箇所、取得本文。これらは `GET /api/toolchain-history/selections?runId=<runId>` と `bun run cli -- toolchain-history show <runId>` で確認します。調査は `bun run logs -- --level warn` で runId を得てから、選択の記録を引きます。

旧「取得先学習(research-routes)」は2026-10-12に廃止しました。`research_routes.*` のイベントは出ません。

## 検証

ブラウザfixtureが失敗した場合は、試験結果のディレクトリに `backend.jsonl` を保存し、`backend-log` として添付します。fixture用backendは `debug` で記録するため、一時DBの削除後も失敗直前の経過を調べられます。`bun run logs -- --file <backend.jsonlのパス> --level warn` で閲覧できます。

Toolchainのlive検証も、一時DBを削除する前に運用ログを `verification-reports/toolchain/live-backend.jsonl`（0600）へ保存します。通常の安全なlogger出力だけを保存し、Providerの生応答は記録しません。

`EUMENES_LIVE_VOICE=1 bun scripts/voice-live.ts` は、一時DBの隔離backendで実TTSの試験入力→実ASR→検索・本文取得→実LLM回答→実TTSを確認します。最終回答と読上げ文の一致・音声の取得も合格条件です。運用ログは `verification-reports/voice-live/backend.jsonl`、試験の入力・回答・出典は `result.json`（双方0600）へ別々に保存します。試験結果は会話本文を除外した運用ログとは区別し、実マイク・スピーカーの受入試験とも区別します。

`api/infrastructure/logger.test.ts` はJSON形式、並行処理のID分離、秘密の除外、世代管理、書込み失敗時の継続、HTTPの相関ID、閲覧時の絞込みを確認します。`api/application/logging.test.ts` は一時DBとLARM未設定のbackendを実際に起動し、入力受付→ジョブ→推論失敗→終了のログを確認します。これらはfixture試験であり、liveのProvider疎通や実マイク・再生の受入ではありません。

## Codex SDKによる調査の失敗

LunaのSDK呼出しでは `inference.attempt_failed` に `phase=sdk_start/sdk_turn/sdk_output` と安全な分類を残します。`codex_research_process_exit` はCLIランタイムの異常終了、`codex_research_http_401` などは外部応答のHTTP状態、`codex_research_invalid_json_schema` などは許可したProviderコード、`codex_research_invalid_event` はSDKイベントの不正です。最終応答のJSON・契約違反は共通workerの `agent.control_rejected` に記録し、構文違反・schema違反・不正な根拠を区別します。未分類は `codex_research_failed` とし、原因を推測しません。

利用可能な場合だけ `exitCode`、許可した `processSignal`、HTTPの `status`、許可したProviderコードの `validationCode` を追加します。SDKイベントと例外の生メッセージはメモリー内で分類し、通常ログ・会話・DBへ保存しません。`inferenceId/attemptId/jobId/subjectId` からagentの `runId/taskId` を辿ります。`queue.settled.reason` とtask APIのerrorCodeにも分類を保持し、会話のcompletedを調査成功とは扱いません。


## LLM生成JSONの補正と拒否

`llm_json.rejected` は共通JSON処理が補正を採用できなかった理由をdebugで記録します。`reason` は `llm_json_duplicate_key`（重複キー）、`llm_json_unsafe_repair`（値・構造の変更が必要）、`llm_json_incomplete`（途中切断）、`llm_json_too_deep`（深さ超過）、`llm_json_too_large`（容量超過）、`llm_json_invalid_syntax` 等の固定コードです。容量と、その処理のrunId/jobId等の実行コンテキストを記録し、キー名・値・生応答は含めません。補正成功はdebugの `llm_json.corrected` で区別します。これは保存前の構文観測であり、取消・古い結果・rollbackを確定した処理失敗として扱いません。処理の拒否は各domainの採用判定後の既存warnログが正本です。

workerは共通補正の拒否分類を `agent.control_rejected.validationCode` と修正通知に保持し、元のJSON.parseの別の構文エラーで上書きしません。途中切断・通常の構文不正は従来の安全な詳細分類も使用します。会話function引数でも同じ固定コードと `validationPath=arguments` を修正資料に渡します。補正で正常なJSONになった後の型・ツール権限・根拠の違反は、各domainの既存検証と分類が正本です。

## 応答開始までの時間を調べる（2026-10-14追加）

`performance.stage` は `performance.now()` による区間時間です。既存の `runId` / `utteranceId` に加え、推論のProvider呼出しと回答後の態度判定では `inferenceId` / `attemptId` を下位のLARMログにも引き継ぎます。本文、音声、URL、設定やProvider応答は追加しません。`outcome=ok` はその処理から返ったという意味で、採用済みを意味しません。`error` には取消も含み、理由は既存の推論終了ログを参照します。

| component / phase・event | 区間と用途 |
| --- | --- |
| `dialogue / query_embedding` | 候補選択のquery embedding待ち。既存 `dialogue.candidates_selected` はrecall等も含む |
| `larm / main_connection_wait` | 同じ主会話接続の先行要求待ち |
| `larm / provider_ready` | 接続・claim・必要なrenew等が返るまで。`kind` がProviderの役割。再利用ならほぼ0 |
| `larm / token_count` | 正式token計数とその契約検査。計数不要のProviderでは即時に返る |
| `larm / response_headers` | HTTP要求開始からヘッダー到着まで。body受信完了・純粋なモデル計算時間ではない。`kind` は操作名 |
| `inference / provider` | ASR/LLM/TTSのadapter呼出し全体。接続・計数・受信も含む |
| `inference / answer_delivery` | 回答生成後の態度判定の実際の待ち時間。接続準備・収集処理を含みうる |
| `voice-dialogue / asr` | 音声認識要求から結果が返るまで |
| `voice-dialogue / input_control` | ASR後の言語・継続関係・入力完了判定。ASR自体と区別する |
| `inference.prepared` | 推論試行開始からProvider呼出し直前まで。TTSでは言語分類・態度準備等を含む |
| `dialogue.body_policy` | 今回の生成が `held`（採用待ち）か `streamed` か。内容や保持理由の詳細は出さない |
| `dialogue.first_delta` | 生成処理開始から最初の非空本文を受け取るまで。`held` は公開していない。修正を挟む場合もその生成処理の最初の一回 |
| `voice.first_chunk_ready` | 合成処理作成から、最初の音声チャンクを採用・公開するまで。最初の試行が失敗しても最初に成功したチャンクで一回 |

`larm.llm_timing.ttftMs` は従来どおり、接続確保後の計数等を含む最初の非空本文までの時間です。追加した `providerTtftMs` は計数完了後、生成要求の送信直前から最初の非空本文まで。通信、Provider内部待ち、応答ヘッダー後のexchange記録待ちを含むため、純粋なprefill時間ではありません。非streamのcontrol要求には本文TTFTを付けません。`totalMs` も単調増加時計に変更しています。

これらの区間は**入れ子**です。`provider` に `provider_ready`・`token_count`・`response_headers` が含まれるため、全行の `durationMs` を合計しないでください。`inference.delivery_selected.durationMs` は採用するdelivery内の値で、既存deliveryをTTSで再利用した場合は過去の判定時間です。新しい待ち時間として重複加算しません。

ブラウザではUser Timingに次のイベントを残します。外部送信はせず、各名前につき最大64件、上限到達時にその名前の古い記録をクリアします。`detail` はrunIdまたはutteranceIdとchunkIndexだけです。

- `eumenes.text_received`：SSEで最初の表示可能な本文を受け取った時点。
- `eumenes.text_committed`：その本文のReact commit後のeffectまで。ピクセルの描画時刻とは区別する。
- `eumenes.audio_fetch`：live音声チャンク取得時間。
- `eumenes.audio_decode`：音声decode時間。
- `eumenes.playback_scheduled`：AudioBufferSourceのstart呼出し時点。Bluetooth・機器バッファ・WAV先頭の無音を含む可聴音の時刻ではない。

ブラウザConsoleで `performance.getEntriesByType('measure').filter(x => x.name.startsWith('eumenes.'))` を確認できます。サーバーとブラウザの単調時計の値を直接引き算せず、IDで対応させ、それぞれの区間を比較します。実際の初回描画・発話終了・最初の可聴音は実機器受入で別に確認します。

再計測は `bun scripts/response-latency-live.ts --run`（adapter経路、各3回）と `bun scripts/response-latency-api-live.ts --run`（一時DBの会話API、文字3回・合成音声入力3回）です。保存済み接続はsettings domainの読み取り専用操作で取得し、API試験では一時backendの設定APIに保存します。後者はtools無効・新規会話であり、通常の個人履歴付き会話の代表値ではありません。音声API試験は最初のチャンク取得後に停止します。両方とも本文と音声ファイルをレポートに保存せず、機器の録音・再生やOpenAI/Claude比較は行いません。結果は `verification-reports/response-latency{-api}-live/`。同じ入力・prompt・出力制約ではない二経路の値を引き算してアプリの追加遅延としないでください。

LARMが`timings`を返す場合、`larm.llm_timing`に`providerPromptMs`（入力処理）、`providerDecodeMs`（生成）、`providerPromptTokens`（処理した入力）、`providerCachedTokens`（再利用した入力）、`providerOutputTokens`（生成token数）を追加します。これはProvider報告値です。5項目の有限・非負の数値だけを抽出し、未知項目・文字列・生応答を記録しません。未提供は不明として省略し、0で埋めません。`promptTokens`はusageの入力全体、`providerPromptTokens`はtimingsの処理済み入力であり、同じ値とは限りません。クライアントの`totalMs`との差には計数・通信・Provider内部の待機などが含まれ得るため、その差をqueue時間と断定しません。
