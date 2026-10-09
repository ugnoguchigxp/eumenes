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

## 正常系の出力量

既定は `info`。起動・復旧・終了、入力受付、ジョブと推論の開始・終了、音声処理の開始・終了とセッション開始・停止を残します。開始だけ残って終了がない処理や、遅いASR・LLM・TTSを見つけるために必要な範囲です。警告・エラーだけでは途中で止まった処理を特定できません。

成功したGET、HTTP受付の詳細、音声の細かな状態変化、チャンク生成は `debug` のみ。障害再現時は `EUMENES_LOG_LEVEL=debug bun run dev` で起動し直します。警告以上だけを保存したい場合は `EUMENES_LOG_LEVEL=warn` にします。その場合、開始・終了と所要時間による調査材料は残りません。

ブラウザの録音・再生・WebGL内部のログ収集は今回の対象に含めていません。backendログとNetwork欄でAPIまでの経路を確認し、機器側の問題はブラウザのConsoleと実機器受入で確認します。

## 保存と取扱い

`EUMENES_LOG_FILE` で保存先を変更できます。空欄は既定の保存先、`-` は stderr のみ。ファイルは10 MiBを超える前に世代を切り替え、現在分と過去4世代を保持します（約50 MiB）。ファイルの権限は `0600`、新規ログディレクトリは `0700`。ファイル保存に失敗した場合は `logging.file_unavailable` を一度 stderr に通知し、stderr出力で継続します。ファイル出力の復旧にはbackendを再起動します。

会話本文、認識結果、音声バイナリ、HTTPヘッダー・query・body、設定、認証情報、Providerの生応答は出力しません。loggerは許可した運用項目だけを通します。IDやエラー発生箇所には運用上の情報があるため、外部へ共有する前には確認してください。ログはローカルの障害調査用で、改ざん防止や永続的な監査証跡を保証するものではありません。長期保存が必要な記録は世代削除前に別途保管します。

## 取得先学習（research-routes）のログ

出せるのは固定イベント名、`runId`、`jobId`、`reason`（固定の理由code。例: `queue_full`、`stale`、`proof_unavailable`）、`status`、`bytes`、`durationMs` だけです。経路は検索キーワードそのものではなく、必要ならキーのdigestで識別します。調査は通常どおり `bun run logs -- --level warn` から始め、`research_routes.learning_skipped`（回答後の学習がskipされた理由）と、author/review jobの `queue.settled` を jobId で追います。

出さないもの: 検索キーワード・地点・銘柄、SKILL/Context本文、ページ本文・引用、facts、編集指示、Providerの生応答、認証情報、設定。回答後の学習が失敗しても元の回答は保持されるため、skip理由はここだけで確認します。

## 検証

ブラウザfixtureが失敗した場合は、試験結果のディレクトリに `backend.jsonl` を保存し、`backend-log` として添付します。fixture用backendは `debug` で記録するため、一時DBの削除後も失敗直前の経過を調べられます。`bun run logs -- --file <backend.jsonlのパス> --level warn` で閲覧できます。

Toolchainのlive検証も、一時DBを削除する前に運用ログを `verification-reports/toolchain/live-backend.jsonl`（0600）へ保存します。通常の安全なlogger出力だけを保存し、Providerの生応答は記録しません。

`api/infrastructure/logger.test.ts` はJSON形式、並行処理のID分離、秘密の除外、世代管理、書込み失敗時の継続、HTTPの相関ID、閲覧時の絞込みを確認します。`api/application/logging.test.ts` は一時DBとLARM未設定のbackendを実際に起動し、入力受付→ジョブ→推論失敗→終了のログを確認します。これらはfixture試験であり、liveのProvider疎通や実マイク・再生の受入ではありません。
