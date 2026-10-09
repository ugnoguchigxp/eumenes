# 計画01のfixture検証

日付: 2026-10-09 JST。Bun 1.4.2、macOS、ローカルの一時DBとfake clock。実CLI・Provider・製品workspace・製品DBは使わない。

変更前にQueue/Scheduler/migrationの既存試験を実行し、48件成功・0失敗を確認した。

初回実装ではタスク単体18件とapplication結合13件の計31件が成功。確認したのは、100回再送の一意性、開始とScheduleの同時保存、容量拒否のrollback、60秒の観測、長い停止期間のcoalesce、重複観測のskip、取消と回答の競合、未確認停止の保持、遅い結果の棄却、再起動時の照合、7日/30日の回収、忘却、HTTP認証と入力検査、共通client、実際に起動した製品CLIからのHTTP操作。

実装portはfixtureであり、dispatchの完了でタスクをcompletedへ移さない。実行・観測・停止のQueue kindはこの結合層の `tasks.*.v1` を使う。後続coding domainの実行・Git証拠はこのportへ接続し、同じ副作用を複数のhandlerで実行しない。

初回実装時のゲート（コードレビュー修正前）:

- `bun run verify -- --domain tasks`: 成功。18件。
- `bun run verify -- --domain scheduler`: 成功。11件。
- `bun run verify -- --domain queue`: 成功。31件。
- 最終修正後の `bun test api/domains/tasks/test api/application/delegated-tasks.test.ts`: 成功。31件、353 assertions。質問の空白正規化、汎用Scheduler経由の不正な監視登録の拒否、CLI更新失敗時のrequestId表示を含む。
- 最終修正後の `bun run typecheck` と今回追加したコード・CLIの整形・静的検査: 成功。`git diff --check` も成功。
- `bun run verify:all`: 途中の版で一度成功（backend 434件、Web 94件、browser 16件、buildを含む）。検証時のsource hashは `2e47d87ee720da7e57173e3ea3dc4e6d7ce926bda8c5cbe35165d4ad9f8b599b`。上記の最終修正と並行作業の追加前の結果であり、最終版の全体成功には数えない。
- 最終版の `bun run verify:all`: 依存境界検査で停止。並行作業の `api/domains/research-routes/test/validation.test.ts` に `research-routes -> web-research` の未許可依存と、公開入口を迂回する `../../web-research/service/source-text` のimportがある。今回のタスク基盤には同検査の指摘なし。別作業のファイルは変更せず、全体ゲートは未通過として残す。

包括試験には同時期の別作業の変更も含むため、個別のfixture結果と全体ゲートを区別する。実CLI・監督推論のlive試験、Kanban・実機器・音声受入は未実施。

## コードレビュー修正後の検証

[指摘と修正内容](review.md)を参照。初回の再現では新規8件が失敗し、既存31件は成功した。修正・再レビュー後はtasks 28件とapplication結合21件、計49件が成功した（415 assertions）。

- Queue/Schedulerを含む回帰: `bun test api/domains/tasks/test api/application/delegated-tasks.test.ts api/domains/queue/test api/domains/scheduler/test` が91件成功、0失敗（567 assertions）。実CLI・Providerを使わない。
- `bun run verify -- --domain tasks`: 最終実行は成功。28件、型検査・境界・整形・lintを含む。途中の実行は並行作業によるソース変更や共通検証lockで停止したが、最後はソース変更検査も通過した。
- 今回変更したtasks、application結合、client、CLIの整形とlint、`git diff --check`: 成功。
- `bun run verify -- --domain scheduler`: 最終実行は利用先Queueの型エラーで停止。`api/domains/queue/service/runner.ts:199` の `SettleResult` が未解決。直接のScheduler試験11件は上記回帰で成功。
- `bun run verify -- --domain queue`: 並行変更中の `api/domains/queue/service/runner.ts` の整形で停止。直接のQueue試験31件は上記回帰で成功。
- `bun run typecheck`: 最終実行は並行作業のQueueの未解決 `SettleResult` と、`api/domains/timers/service/index.ts:70` の重複プロパティで停止。今回変更したコードの型エラーは出ていない。
- `bun run verify:all`: 最終実行は並行作業中の11ファイルの整形で停止（Queue runner、timers、World、dialogue contracts、migration試験、package設定）。今回のタスク基盤の整形は成功。全体ゲートの成功とは扱わない。

並行変更のファイルを修復・巻き戻すことなく、対象範囲の修正と回帰試験を完了した。実CLI・live・実機器の受入は引き続き未実施。
