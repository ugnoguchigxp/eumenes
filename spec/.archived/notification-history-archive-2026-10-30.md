# 通知履歴のクリア

2026-10-30。利用者の依頼: 通知エリアのドロップダウンに「履歴をクリア」を置き、物理削除せずアーカイブする。

## 範囲と動作

- 通知センター内の共通ボタンで、タイマー・Kanban・TODOの既読／未読の通知をまとめて非表示にする。取得ページ外の古い通知も対象。
- 各domainの既存writerと公開APIを使い、それぞれの取引開始時に存在する通知をアーカイブする。後から作られた通知は通常どおり表示する。
- タイマーは既存の `dismissed` と `dismissed_at_ms` を利用し、claimを失効させる。タイマー本体、進行中のカウントダウン、仕事、Kanbanのカード・実行、成果物は変更しない。
- Kanbanは `kanban_notices.archived_at`、TODOは `dialogue_work.notice_archived_at` を追加する。通知の一覧・未読数だけがこの状態を参照する。TODO本体の `archived_at` と区別する。
- API: `POST /api/timer-notifications/archive`、`POST /api/kanban/notices/archive`、`POST /api/todo-notices/archive`。本文なし、成功204。画面にある件数に制限せず現在の対象全件を更新し、繰り返しても処理済みの記録は変えない。
- 処理中は「クリア中…」を表示して連打を防ぐ。成功後に既存queryを再取得し、一覧・未読数・バナーを更新する。通知がなくなったタイマーの再生は中止する。一部失敗でも全APIの結果を待って再取得し、エラーを表示する。
- 物理削除は行わない。既存の保存期間・回収処理は変更しない。アーカイブ一覧や復元機能、LLMの指示・判断方式、ツールチェーン登録の変更は範囲外。

## 作業と完了条件

1. 各domainの保存とAPI、clientを拡張する。
2. 既存通知センターにボタンと処理状態・失敗表示を接続する。
3. 部分試験で保存・ページ外の対象・繰り返し・新着・本体への影響なしを確認する。結合試験で3種のAPIと一覧／バッジ更新、失敗を確認する。
4. `bun run verify -- --domain timers --domain kanban --domain dialogue` と利用側の対象試験を実行し、差分を点検する。ブラウザE2Eはサーバー起動許可が必要なため、既存稼働環境を使えない場合は未実施として区別する。

## 実装と検証結果

状態: 実装済み・fixture検証済み。live・ブラウザE2Eは未実施。サーバーの起動・停止・再起動、本番の通知のクリアは行っていない。

- 3つのAPIとclient、通知センターのボタンを追加した。通知のqueryだけを再取得し、進行中の会話やタイマーのqueryはクリア操作で更新しない。
- `bun test api/domains/timers api/domains/kanban api/domains/dialogue`: 65ファイル・526件通過。保存記録・仕事の結果・タイマー本体の保持、取得ページ外のクリア、繰り返し、新着、タイマーclaim失効を確認した。
- Webの通知・Kanban・TODO通知・dialogue hook・workspace統合試験: 8ファイル・60件通過。3種の一覧とバッジの更新、再マウント、新着音、処理中の連打防止、一部失敗からの再試行を確認した。規模制限を満たすため音声有効化の処理を同一ファイルの関数へ移した後、影響する2ファイル・22件を再実行して通過した。
- `bun check --no-pretty --all`: 2,785ファイルの型検査通過。変更ファイルのlint・formatと`git diff --check`通過。`TimerNotifications`の関数は既存の規模上限内。
- `bun run verify -- --domain timers --domain kanban --domain dialogue`: 既存の `NotificationCenter.tsx` の `timers → resources` 参照（`domains/resources/kind-icon`）が境界検査で失敗。変更前のHEADにも同じ参照があることを確認し、担当外の設計変更はしなかった。新しい統合試験はdomainを横断するためworkspaceに置いた。
- `bun run verify -- --domain kanban --domain dialogue`: 通過（backend 506件・Web 35件、静的検査とDesignSystemの型検査・buildを含む）。選択外の既存の境界・規模違反は警告として記録されている。レポート: `verification-reports/runs/2026-10-30T13-58-11-114Z-179e48ae-94b3-4615-b62f-38ae2dde9f7e/report.json`。
- ブラウザE2Eは専用サーバー起動の許可がないため省略した。APIは実SQLiteとHonoのインプロセスHTTP、画面は既存hooksを組み合わせたfixtureで検証した。
- 差分点検: 語句・シナリオで意味判断する分岐、LLMの判断方式・優先順位・フォールバックの追加はない。通知状態の保存・検証だけを各domainに追加した。着手前からあった別作業の差分は保持した。
