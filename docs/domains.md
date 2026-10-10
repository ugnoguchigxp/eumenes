# Domain の入口

## Domain 一覧(自動生成)

次の表は `scripts/domains.ts` から `bun scripts/domain-docs.ts` が生成します。手で編集しないでください。`bun scripts/domain-docs.ts --check` が差分を検出します(`verify --all` に組み込みます)。依存の方向は `scripts/boundaries.ts` が検査し、下位 domain は上位 domain を参照しません。

<!-- domains:start -->
| Domain | Backend 入口 | Web 入口 | Components | 依存 (api) | 依存 (web) | 依存 (試験のみ) |
| --- | --- | --- | --- | --- | --- | --- |
| `task-reports` | `api/domains/task-reports/index.ts` | なし | なし | `tasks` | なし | なし |
| `coding-supervision` | `api/domains/coding-supervision/index.ts` | なし | なし | `coding`、`inference`、`queue`、`task-reports`、`tasks` | なし | なし |
| `coding` | `api/domains/coding/index.ts` | なし | なし | なし | なし | なし |
| `artifact` | なし | `web/src/domains/artifact/index.ts` | `web/src/components/domains/artifact/` | なし | `conversation` | なし |
| `tasks` | `api/domains/tasks/index.ts` | なし | なし | なし | なし | なし |
| `capabilities` | `api/domains/capabilities/index.ts` | なし | なし | なし | なし | なし |
| `tool-runtime` | `api/domains/tool-runtime/index.ts` | なし | なし | `capabilities`、`queue` | なし | なし |
| `agent-runtime` | `api/domains/agent-runtime/index.ts` | `web/src/domains/agent-runtime/index.ts` | なし | `capabilities`、`inference`、`queue`、`tool-runtime` | なし | なし |
| `research-routes` | `api/domains/research-routes/index.ts` | `web/src/domains/research-routes/index.tsx` | なし | `capabilities`、`inference`、`queue` | なし | なし |
| `web-research` | `api/domains/web-research/index.ts` | なし | なし | `queue` | なし | なし |
| `attitude-dataset` | `api/domains/attitude-dataset/index.ts` | なし | なし | `delivery` | なし | なし |
| `service-tests` | `api/domains/service-tests/index.ts` | `web/src/domains/service-tests/index.tsx` | なし | `inference`、`larm`、`settings` | なし | なし |
| `delivery` | `api/domains/delivery/index.ts` | なし | なし | なし | なし | なし |
| `avatar` | なし | `web/src/domains/avatar/index.ts` | なし | なし | `delivery` | なし |
| `settings` | `api/domains/settings/index.ts` | `web/src/domains/settings/index.tsx` | なし | なし | `tts-dictionary` | なし |
| `inference` | `api/domains/inference/index.ts` | なし | なし | `attitude-dataset`、`delivery`、`larm`、`settings` | なし | なし |
| `tts-dictionary` | `api/domains/tts-dictionary/index.ts` | `web/src/domains/tts-dictionary/index.tsx` | なし | なし | なし | なし |
| `conversation` | `api/domains/conversation/index.ts` | `web/src/domains/conversation/index.ts` | `web/src/components/domains/conversation/index.ts` | `delivery` | `avatar`、`delivery` | なし |
| `continuity` | `api/domains/continuity/index.ts` | なし | なし | なし | なし | なし |
| `goals` | `api/domains/goals/index.ts` | なし | なし | なし | なし | なし |
| `world` | `api/domains/world/index.ts` | `web/src/domains/world/index.ts` | `web/src/components/domains/world/` | `conversation`、`goals` | `conversation` | `memory` |
| `memory` | `api/domains/memory/index.ts` | なし | なし | `continuity`、`conversation` | なし | なし |
| `larm` | `api/domains/larm/index.ts` | なし | なし | なし | なし | なし |
| `audio` | なし | `web/src/domains/audio/index.ts` | なし | なし | なし | なし |
| `queue` | `api/domains/queue/index.ts` | なし | なし | なし | なし | なし |
| `scheduler` | `api/domains/scheduler/index.ts` | なし | なし | `queue` | なし | なし |
| `timers` | `api/domains/timers/index.ts` | `web/src/domains/timers/` | `web/src/components/domains/timers/` | `queue`、`scheduler` | なし | なし |
| `dialogue` | `api/domains/dialogue/index.ts` | `web/src/domains/dialogue/index.ts` | なし | `agent-runtime`、`conversation`、`delivery`、`inference`、`memory`、`queue`、`scheduler` | `conversation` | `world` |
| `voice-dialogue` | `api/domains/voice-dialogue/index.ts` | `web/src/domains/voice-dialogue/index.ts` | なし | `delivery`、`dialogue`、`inference`、`settings` | `audio`、`avatar`、`dialogue`、`settings` | なし |
<!-- domains:end -->

## 試験と関連文書

| Domain | Backend 入口 | Web 入口 | 所有する試験 |
| --- | --- | --- | --- |
| coding-supervision | `api/domains/coding-supervision/index.ts` | client/API（`docs/coding-supervision.md`） | `api/domains/coding-supervision/test/`、application結合試験 |
| task-reports | `api/domains/task-reports/index.ts` | client/API | `api/domains/task-reports/test/` |
| coding | `api/domains/coding/index.ts` | client/API（`docs/coding-runner.md`） | `api/domains/coding/test/`、`packages/coding-runner/test/`、application結合試験 |
| tasks | `api/domains/tasks/index.ts` | 共通client/API・CLI（`docs/delegated-tasks.md`） | `api/domains/tasks/test/`、結合試験 `api/application/delegated-tasks.test.ts` |
| attitude-dataset | `api/domains/attitude-dataset/index.ts` | CLI/API（`docs/ruri-collection.md`） | `api/domains/attitude-dataset/test/` |
| delivery | `api/domains/delivery/index.ts` | なし | `api/domains/delivery/test/` |
| avatar | なし | `web/src/domains/avatar/index.ts` | `web/src/domains/avatar/test/` |
| service-tests | `api/domains/service-tests/index.ts` | `web/src/domains/service-tests/index.tsx` | `api/domains/service-tests/test/`、`web/src/domains/service-tests/index.test.tsx` |
| settings | `api/domains/settings/index.ts` | `web/src/domains/settings/index.tsx`（カテゴリ別の画面は `sections/`、共通部品は `shared.tsx`） | `api/domains/settings/test/`、`web/src/domains/settings/sections/*.test.tsx` |
| inference | `api/domains/inference/index.ts` | なし | `api/domains/inference/test/` |
| tts-dictionary | `api/domains/tts-dictionary/index.ts` | `web/src/domains/tts-dictionary/index.tsx` | `api/domains/tts-dictionary/test/` |
| conversation | `api/domains/conversation/index.ts` | `web/src/domains/conversation/index.ts` | `api/domains/conversation/test/` |
| continuity | `api/domains/continuity/index.ts` | なし | `api/domains/continuity/test/` |
| capabilities | `api/domains/capabilities/index.ts` | CLI/API | `api/domains/capabilities/test/` |
| tool-runtime | `api/domains/tool-runtime/index.ts` | なし | `api/domains/tool-runtime/test/` |
| agent-runtime | `api/domains/agent-runtime/index.ts` | `web/src/domains/agent-runtime/index.ts` | `api/domains/agent-runtime/test/`、`api/application/toolchain.test.ts`、`tests/browser/toolchain.spec.ts` |
| research-routes | `api/domains/research-routes/index.ts` | `web/src/domains/research-routes/index.tsx`（設定の「取得先と手順」） / CLI/API（`docs/research-routes.md`） | `api/domains/research-routes/test/`、結合試験 `api/application/research-routes.test.ts` |
| web-research | `api/domains/web-research/index.ts` | CLI/API | `api/domains/web-research/test/` |
| memory | `api/domains/memory/index.ts` | なし | `api/domains/memory/test/` |
| larm | `api/domains/larm/index.ts` | なし | `api/domains/larm/test/` |
| audio | なし | `web/src/domains/audio/index.ts` | `web/src/domains/audio/test/` |
| queue | `api/domains/queue/index.ts` | なし | `api/domains/queue/test/` |
| scheduler | `api/domains/scheduler/index.ts` | なし | `api/domains/scheduler/test/` |
| timers | `api/domains/timers/index.ts` | `web/src/domains/timers` と `web/src/components/domains/timers/TimerArtifact.tsx` | `api/domains/timers/test/` |
| dialogue | `api/domains/dialogue/index.ts` | `web/src/domains/dialogue/index.ts` | `api/domains/dialogue/test/`、`web/src/domains/dialogue/test/` |
| voice-dialogue | `api/domains/voice-dialogue/index.ts` | `web/src/domains/voice-dialogue/index.ts` | `api/domains/voice-dialogue/test/`、`web/src/domains/voice-dialogue/test/` |

backend の HTTP 組立ては `api/application/`、SQLite の排他・接続・migration 実行は `api/infrastructure/sqlite/`、Web と CLI の共通 HTTP 搬送は `client/` が所有します。domain 間 import の方向は `scripts/domains.ts` と `scripts/boundaries.ts` が検査します。`export … from`、動的 `import()`、型 `import("…")` も同じ規則で検査し、`web/src` と `client` から `api` へは `api/domains/<domain>/contracts` だけ、`cli` からは `client`・contracts・`api/infrastructure/auth-config` だけを許します。`bun run test:domain -- <name>` は所有試験のみ、`bun run verify -- --domain <name>` は format、lint、型依存閉包、境界、試験を確認します。

### migration の追加規則

- migration は名前付きです。各 domain の `repository` が `export const migrations: readonly Migration[]`(`{ id, sql, after? }`)を持ち、`api/application/migrations.ts` が全 domain 分を集めます。DB には適用済みの id と SQL の SHA-256 を `schema_migrations_v2` に記録します。
- id は `"<owner>/<4桁連番>-<slug>"`(例 `conversation/0006-xxx`)。連番は owner ごとに続け、一度配った id は変えません。package の migration は位置で `memory-package/0007` のように名付けます。
- 新しい migration は必ず `after`(先に適用する migration の id)を明示し、追加後も `legacyOrder` には書き足しません。`legacyOrder` は 2026-10-10 以前の位置方式の順序を凍結したもので、旧 DB(INTEGER 表 `schema_migrations`)を初回起動時に `schema_migrations_v2` へ写すためだけに使います。旧表は残します。
- 適用済みの migration の SQL は 1 文字も変更・並べ替え・削除しません。変更は checksum 不一致(`migration_checksum_mismatch:<id>`)で起動失敗になります。直す場合は新しい migration を `after` 付きで足します。DB にあってコードに無い id は `migration_unknown_applied:<id>` で起動失敗になります(DB がコードより新しい)。
- `api/application/migrations.test.ts` の GOLDEN が凍結済みの順序と SQL を固定しています。このテストが落ちたら実装を戻し、期待値は更新しません。

Toolchainは `capabilities` が不変revision・候補検索・必須依存を、`tool-runtime` が所有者付き実行参照・入力検査・短期観測を、`agent-runtime` が制御step・子の予算・要約検査・採用ticketを所有します。既存Web取得を呼ぶadapterは `api/application/toolchain.ts` が組み立てます。下位domainは上位のSQLを参照しません。CLI/Webは共通clientからHTTPを使います。

## 音声 MVP の所有境界

| 領域 | 所有する処理 | 依存 |
| --- | --- | --- |
| `conversation` | 確定メッセージと会話 revision | なし |
| `larm` | Profile 発見、Connection、claim、lease、ASR・LLM・TTS | なし |
| `audio` | ブラウザ録音、発話検出、WAV 化、再生 | なし |
| `queue` | 有界ジョブ、資源枠、取消と復旧 | なし |
| `scheduler` | 時刻指定の起動と定期起動 | queue |
| `dialogue` | 入力受付、LLM、回答採用、取消、復旧 | conversation、larm、queue、scheduler |
| `voice-dialogue` | 発話から再生までの状態と割込み | audio、dialogue、larm |

domain の公開入口は上の自動生成表、所有する試験は「試験と関連文書」にあります。SQLite の writer は backend の単一プロセスが所有し、起動前の OS lock、直列 write queue、WAL、読み取り専用 lane を使います。Web・CLI は API のみからアクセスします。TanStack Query は backend の履歴・run 状態を表示する cache、Zustand はブラウザ音声の一時状態です。音声ファイルは既定で保存しません。
