# 通知(SSE)と再接続

backend 起動時に LARM への接続を一度確認します。失敗時は画面に原因を表示し、「接続を再確認」から再試行できます。状態確認の GET は新しい接続を作りません。画面は認証付き SSE の接続を共有し、DB の保存確定と LARM の接続状態変化を受けて既存 API から最新状態を読み直します。会話・回答待ち・音声・設定・予約の定期取得はありません。変更通知は100ms単位でまとめ、15秒ごとの heartbeat は再取得を起こしません。接続や再接続のたびに最新状態を読み直すため、切断中の変更やサーバー再起動にも追いつきます。通知接続の失敗時は5秒から最大30秒まで再試行間隔を延ばし、401・403・404では自動再試行を停止します。回答は従来どおり確定後に表示し、音声再生の操作も変えていません。

## SSE の実装（2026-10-27）

送り手は `api/infrastructure/sse.ts`（`sseStream`・`sseFrame`・`SSE_HEADERS`）、受け手は `client/sse.ts`（`sseParser`・`readSse`）の一つずつを使います。新しい経路も独自に組み立てず、これらに設定を渡します。

| 経路 | 送り手 | 遅い受け手 | heartbeat | 受け手 | 接続待ち | 無通信 | 上限 | エラーコード |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 状態変化 `/api/events` | `createChanges` | 切断（再取得させる） | 15秒 | `client/events.ts` | 10秒 | 45秒 | 64KB | `invalid_event_stream`・`event_frame_too_large` |
| run の進捗 `/api/runs/:id/stream` | `snapshotStream`（同時32本） | 最新の1件だけ保持 | 15秒（保持中は送らない） | `client/run-stream.ts` | なし | 45秒 | 1MB | `invalid_run_stream`・`run_frame_too_large`・`run_stream_disconnected` |
| 端末の出力 | `outputStream` | 切断（最後の `exit` は入れる） | 15秒 | `terminal-connection.ts` | 45秒 | 45秒 | なし | なし（切れたら再接続） |

無通信は読み取りを止めるだけで、要求は中断しません（切断と同じ扱い）。上限は1つのフレームの data の大きさで、1回の読み込みに完結した小さなフレームが多数あっても超過にしません。

## 定期取得について

会話・回答待ち・音声・設定・予約について、一定間隔で API を読みにいく処理(`refetchInterval` や固定間隔の polling)はありません。状態の更新は上記の SSE 通知を契機に行います。タイマー(予約)の期限だけは SSE に対応する event が無いため、期限の時刻に一度だけ再取得します(`web/src/domains/timers/deadline.ts`)。
