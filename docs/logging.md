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
| `inferenceId` / `attemptId` / `subjectId` | 推論要求、各試行、その要求を所有するrunや発話。ASR・LLM・TTSと代替先を追う |
| `sessionId` / `utteranceId` / `generation` | 音声セッション、発話、割込みの世代 |
| `status` / `reason` / `durationMs` | 保存後の状態、処理側で定義した理由、処理の所要時間 |
| `errorFrames` | エラーの発生箇所。生のエラーメッセージは保存しない |

画面でAPIエラーが出たときは、ブラウザのNetwork欄でレスポンスの `X-Request-Id` を確認し、`bun run logs -- --id <そのID> --json` で検索します。共通clientの `ApiError.requestId` にも入ります。CLIのAPIエラーはこのIDを stderr に表示するので、CLIの `--json` 出力を壊しません。

`inference.attempt_succeeded` や `dialogue.generation_completed` は生成の終了を示します。結果の採用・保存の確定は `queue.settled` の状態、実行記録API、音声の状態で確認します。取消や権限変更で破棄された結果を成功として扱いません。SSEのHTTPログは接続応答の開始までの時間で、接続寿命やブラウザでの再生時間ではありません。

## 正常系の出力量

既定は `info`。起動・復旧・終了、入力受付、ジョブと推論の開始・終了、音声処理の開始・終了とセッション開始・停止を残します。開始だけ残って終了がない処理や、遅いASR・LLM・TTSを見つけるために必要な範囲です。警告・エラーだけでは途中で止まった処理を特定できません。

成功したGET、HTTP受付の詳細、音声の細かな状態変化、チャンク生成は `debug` のみ。障害再現時は `EUMENES_LOG_LEVEL=debug bun run dev` で起動し直します。警告以上だけを保存したい場合は `EUMENES_LOG_LEVEL=warn` にします。その場合、開始・終了と所要時間による調査材料は残りません。

ブラウザの録音・再生・WebGL内部のログ収集は今回の対象に含めていません。backendログとNetwork欄でAPIまでの経路を確認し、機器側の問題はブラウザのConsoleと実機器受入で確認します。

## 保存と取扱い

`EUMENES_LOG_FILE` で保存先を変更できます。空欄は既定の保存先、`-` は stderr のみ。ファイルは10 MiBを超える前に世代を切り替え、現在分と過去4世代を保持します（約50 MiB）。ファイルの権限は `0600`、新規ログディレクトリは `0700`。ファイル保存に失敗した場合は `logging.file_unavailable` を一度 stderr に通知し、stderr出力で継続します。ファイル出力の復旧にはbackendを再起動します。

会話本文、認識結果、音声バイナリ、HTTPヘッダー・query・body、設定、認証情報、Providerの生応答は出力しません。loggerは許可した運用項目だけを通します。IDやエラー発生箇所には運用上の情報があるため、外部へ共有する前には確認してください。ログはローカルの障害調査用で、改ざん防止や永続的な監査証跡を保証するものではありません。長期保存が必要な記録は世代削除前に別途保管します。

## 検証

ブラウザfixtureが失敗した場合は、試験結果のディレクトリに `backend.jsonl` を保存し、`backend-log` として添付します。fixture用backendは `debug` で記録するため、一時DBの削除後も失敗直前の経過を調べられます。`bun run logs -- --file <backend.jsonlのパス> --level warn` で閲覧できます。

`api/infrastructure/logger.test.ts` はJSON形式、並行処理のID分離、秘密の除外、世代管理、書込み失敗時の継続、HTTPの相関ID、閲覧時の絞込みを確認します。`api/application/logging.test.ts` は一時DBとLARM未設定のbackendを実際に起動し、入力受付→ジョブ→推論失敗→終了のログを確認します。これらはfixture試験であり、liveのProvider疎通や実マイク・再生の受入ではありません。
