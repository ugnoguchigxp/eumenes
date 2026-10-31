# Domain の入口

## Domain 一覧(自動生成)

次の表は `scripts/domains.ts` から `bun scripts/domain-docs.ts` が生成します。手で編集しないでください。`bun scripts/domain-docs.ts --check` が差分を検出します（すべての `verify` で実行します）。依存の方向は `scripts/boundaries.ts` が検査します。各 domain は `scripts/domains.ts` で明示した Tier(0 が最下位)を持ち、宣言した依存(api・web・試験のみ)は必ず自分より低い Tier の domain だけを指します。許可リストに加えてこの Tier 検査を通らなければならないため、下位 domain は上位 domain を参照できません。依存を足して Tier が合わなくなった場合は、設計を見直したうえで `scripts/domains.ts` の Tier を更新します。

<!-- domains:start -->
| Domain | Tier | Backend 入口 | Web 入口 | Components | 依存 (api) | 依存 (web) | 依存 (試験のみ) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `docling` | 0 | `api/domains/docling/index.ts` | `web/src/domains/docling/` | `packages/design-system/src/components/ExternalAppLauncher/index.ts` | なし | なし | なし |
| `google-accounts` | 0 | `api/domains/google-accounts/index.ts` | `web/src/domains/google-accounts/` | `packages/design-system/src/components/GoogleAccounts/index.tsx` | なし | なし | なし |
| `excalidraw` | 3 | `api/domains/excalidraw/index.ts` | `web/src/domains/excalidraw/` | なし | `capabilities`、`inference`、`larm`、`queue`、`resources`、`tool-runtime` | `resources` | なし |
| `ocr` | 3 | `api/domains/ocr/index.ts` | `web/src/domains/ocr/` | `packages/design-system/src/components/OcrWorkspace/index.ts` | `capabilities`、`inference`、`queue`、`resources`、`larm` | `resources` | なし |
| `object-recognition` | 1 | `api/domains/object-recognition/index.ts` | `web/src/domains/object-recognition/index.ts` | なし | `capabilities`、`queue`、`larm` | なし | なし |
| `compute` | 1 | `api/domains/compute/index.ts` | `web/src/domains/compute/` | `packages/design-system/src/components/ComputeWorkspace/index.tsx` | `queue`、`resources` | `resources` | なし |
| `model3d` | 1 | `api/domains/model3d/index.ts` | `web/src/domains/model3d/` | `packages/design-system/src/components/Model3dWorkspace/index.ts` | `queue`、`resources` | `resources` | なし |
| `browser` | 1 | `api/domains/browser/index.ts` | `web/src/domains/browser/` | `packages/design-system/src/components/BrowserWorkspace/index.ts` | `queue`、`resources` | `resources` | なし |
| `kanban` | 1 | `api/domains/kanban/index.ts` | `web/src/domains/kanban/index.ts` | なし | `capabilities`、`resources` | `resources` | なし |
| `codex-tasks` | 1 | `api/domains/codex-tasks/index.ts` | `web/src/domains/codex-tasks/` | なし | `coding`、`resources` | なし | なし |
| `shell` | 0 | `api/domains/shell/index.ts` | `web/src/domains/shell/` | なし | なし | なし | なし |
| `terminals` | 0 | `api/domains/terminals/index.ts` | `web/src/domains/terminals/index.ts` | なし | なし | なし | なし |
| `background` | 0 | なし | `web/src/domains/background/index.ts` | なし | なし | なし | なし |
| `image` | 3 | `api/domains/image/index.ts` | `web/src/domains/image/index.ts` | なし | `capabilities`、`inference`、`larm`、`queue`、`resources`、`tool-runtime` | `resources` | なし |
| `ui-compositions` | 3 | `api/domains/ui-compositions/index.ts` | `web/src/domains/ui-compositions/` | なし | `resources` | `resources` | なし |
| `music` | 3 | `api/domains/music/index.ts` | `web/src/domains/music/index.ts` | `web/src/components/domains/music/` | `capabilities`、`inference`、`larm`、`queue`、`resources`、`tool-runtime` | `resources` | なし |
| `dots` | 1 | `api/domains/dots/index.ts` | `web/src/domains/dots/` | なし | `queue` | なし | なし |
| `task-reports` | 1 | `api/domains/task-reports/index.ts` | なし | なし | `tasks` | なし | なし |
| `coding` | 0 | `api/domains/coding/index.ts` | なし | なし | なし | なし | なし |
| `artifact` | 3 | なし | `web/src/domains/artifact/index.ts` | `web/src/components/domains/artifact/` | なし | `conversation` | なし |
| `tasks` | 0 | `api/domains/tasks/index.ts` | なし | なし | なし | なし | なし |
| `capabilities` | 0 | `api/domains/capabilities/index.ts` | なし | なし | なし | なし | なし |
| `pipelines` | 1 | `api/domains/pipelines/index.ts` | `web/src/domains/pipelines/` | `packages/design-system/src/components/PipelineStudio/index.ts` | `capabilities`、`resources` | `resources` | なし |
| `tool-runtime` | 1 | `api/domains/tool-runtime/index.ts` | なし | なし | `capabilities`、`queue` | なし | なし |
| `agent-runtime` | 3 | `api/domains/agent-runtime/index.ts` | `web/src/domains/agent-runtime/index.ts` | なし | `capabilities`、`inference`、`pipelines`、`queue`、`resources`、`tool-runtime` | なし | なし |
| `toolchain-history` | 1 | `api/domains/toolchain-history/index.ts` | なし | なし | `capabilities` | なし | なし |
| `web-research` | 1 | `api/domains/web-research/index.ts` | なし | なし | `queue`、`resources` | なし | なし |
| `attitude-dataset` | 1 | `api/domains/attitude-dataset/index.ts` | なし | なし | `delivery` | なし | なし |
| `monitoring` | 3 | `api/domains/monitoring/index.ts` | `web/src/domains/monitoring/index.ts` | なし | `inference`、`larm`、`queue`、`settings` | `background` | なし |
| `service-tests` | 3 | `api/domains/service-tests/index.ts` | `web/src/domains/service-tests/` | なし | `inference`、`larm`、`settings` | なし | なし |
| `delivery` | 0 | `api/domains/delivery/index.ts` | なし | なし | なし | なし | なし |
| `avatar` | 1 | なし | `web/src/domains/avatar/index.ts` | なし | なし | `delivery` | なし |
| `settings` | 0 | `api/domains/settings/index.ts` | `web/src/domains/settings/index.tsx` | なし | なし | なし | なし |
| `live-voice` | 3 | `api/domains/live-voice/index.ts` | `web/src/domains/live-voice/index.ts` | なし | `settings` | `audio`、`settings` | `conversation` |
| `inference` | 2 | `api/domains/inference/index.ts` | なし | なし | `attitude-dataset`、`delivery`、`larm`、`settings` | なし | なし |
| `tts-dictionary` | 0 | `api/domains/tts-dictionary/index.ts` | なし | なし | なし | なし | なし |
| `conversation` | 2 | `api/domains/conversation/index.ts` | `web/src/domains/conversation/index.ts` | `web/src/components/domains/conversation/index.ts` | `delivery` | `avatar`、`delivery` | なし |
| `resources` | 0 | `api/domains/resources/index.ts` | `web/src/domains/resources/index.ts` | なし | なし | なし | なし |
| `continuity` | 0 | `api/domains/continuity/index.ts` | なし | なし | なし | なし | なし |
| `goals` | 0 | `api/domains/goals/index.ts` | なし | なし | なし | なし | なし |
| `world` | 4 | `api/domains/world/index.ts` | なし | なし | `conversation`、`goals` | なし | `memory` |
| `memory` | 3 | `api/domains/memory/index.ts` | なし | なし | `continuity`、`conversation`、`tool-runtime` | なし | なし |
| `steward` | 5 | `api/domains/steward/index.ts` | なし | なし | `continuity`、`conversation`、`goals`、`memory`、`world` | なし | `queue` |
| `larm` | 0 | `api/domains/larm/index.ts` | なし | なし | なし | なし | なし |
| `audio` | 0 | なし | `web/src/domains/audio/index.ts` | なし | なし | なし | なし |
| `queue` | 0 | `api/domains/queue/index.ts` | なし | なし | なし | なし | なし |
| `scheduler` | 1 | `api/domains/scheduler/index.ts` | なし | なし | `queue` | なし | なし |
| `timers` | 2 | `api/domains/timers/index.ts` | `web/src/domains/timers/` | `web/src/components/domains/timers/` | `queue`、`scheduler` | `resources` | なし |
| `dialogue` | 5 | `api/domains/dialogue/index.ts` | `web/src/domains/dialogue/index.ts` | なし | `agent-runtime`、`capabilities`、`continuity`、`conversation`、`delivery`、`inference`、`memory`、`queue`、`resources`、`scheduler`、`toolchain-history`、`tool-runtime` | `conversation` | `goals` |
| `voice-dialogue` | 6 | `api/domains/voice-dialogue/index.ts` | `web/src/domains/voice-dialogue/index.ts` | なし | `delivery`、`dialogue`、`inference` | `audio`、`avatar`、`dialogue`、`settings` | なし |
<!-- domains:end -->

## 試験と関連文書

| Domain | Backend 入口 | Web 入口 | 所有する試験 |
| --- | --- | --- | --- |
| task-reports | `api/domains/task-reports/index.ts` | client/API | `api/domains/task-reports/test/` |
| coding | `api/domains/coding/index.ts` | Codex SDK runnerの公開口（`docs/coding-runner.md`） | `packages/coding-runner/test/`、application結合試験 |
| tasks | `api/domains/tasks/index.ts` | 共通client/API・CLI（`docs/delegated-tasks.md`） | `api/domains/tasks/test/`、結合試験 `api/application/work/tasks-http.test.ts` |
| attitude-dataset | `api/domains/attitude-dataset/index.ts` | CLI/API（`docs/ruri-collection.md`） | `api/domains/attitude-dataset/test/` |
| delivery | `api/domains/delivery/index.ts` | なし | `api/domains/delivery/test/` |
| avatar | なし | `web/src/domains/avatar/index.ts` | `web/src/domains/avatar/test/` |
| service-tests | `api/domains/service-tests/index.ts` | `web/src/domains/service-tests/toolchain-adapter.tsx` | `api/domains/service-tests/test/` |
| settings | `api/domains/settings/index.ts` | `web/src/domains/settings/index.tsx`（カテゴリ別の画面は `sections/`、共通部品は `shared.tsx`） | `api/domains/settings/test/`、`web/src/domains/settings/sections/*.test.tsx` |
| inference | `api/domains/inference/index.ts` | なし | `api/domains/inference/test/` |
| tts-dictionary | `api/domains/tts-dictionary/index.ts` | なし | `api/domains/tts-dictionary/test/` |
| conversation | `api/domains/conversation/index.ts` | `web/src/domains/conversation/index.ts` | `api/domains/conversation/test/` |
| continuity | `api/domains/continuity/index.ts` | なし | `api/domains/continuity/test/` |
| capabilities | `api/domains/capabilities/index.ts` | CLI/API | `api/domains/capabilities/test/` |
| tool-runtime | `api/domains/tool-runtime/index.ts` | なし | `api/domains/tool-runtime/test/` |
| agent-runtime | `api/domains/agent-runtime/index.ts` | `web/src/domains/agent-runtime/index.ts` | `api/domains/agent-runtime/test/`、`api/application/toolchain/toolchain.test.ts`、`tests/browser/toolchain.spec.ts` |
| toolchain-history | `api/domains/toolchain-history/index.ts` | なし（設定の「ツールチェーンの記録」は `web/src/domains/settings-data/records-adapter.tsx`。CLI/API は `docs/toolchain.md`） | `api/domains/toolchain-history/test/`、結合試験 `api/application/toolchain/toolchain-history.test.ts`・`toolchain-recipe-e2e.test.ts` |
| web-research | `api/domains/web-research/index.ts` | CLI/API | `api/domains/web-research/test/` |
| memory | `api/domains/memory/index.ts` | なし | `api/domains/memory/test/` |
| larm | `api/domains/larm/index.ts` | なし | `api/domains/larm/test/` |
| audio | なし | `web/src/domains/audio/index.ts` | `web/src/domains/audio/test/` |
| queue | `api/domains/queue/index.ts` | なし | `api/domains/queue/test/` |
| scheduler | `api/domains/scheduler/index.ts` | なし | `api/domains/scheduler/test/` |
| ocr | `api/domains/ocr/index.ts` | `web/src/domains/ocr/`（アーティファクト「文字を読み取る」、`docs/ocr.md`） | `api/domains/ocr/test/`、`api/application/media/ocr-e2e.test.ts`、`api/application/media/ocr-adapter.test.ts`、`tests/browser/ocr.spec.ts` |
| terminals | `api/domains/terminals/index.ts` | `web/src/domains/terminals/index.ts`（アーティファクト「ターミナル」、`docs/terminals.md`） | `api/domains/terminals/test/`、`api/application/work/terminals-adapter.test.ts`、`web/src/domains/terminals/connection.test.ts` |
| timers | `api/domains/timers/index.ts` | `web/src/domains/timers/` と `web/src/components/domains/timers/` | `api/domains/timers/test/` |
| dialogue | `api/domains/dialogue/index.ts` | `web/src/domains/dialogue/index.ts` | `api/domains/dialogue/test/`、`web/src/domains/dialogue/test/` |
| voice-dialogue | `api/domains/voice-dialogue/index.ts` | `web/src/domains/voice-dialogue/index.ts` | `api/domains/voice-dialogue/test/`、`web/src/domains/voice-dialogue/test/` |

backend の HTTP 組立ては `api/application/`、SQLite の排他・接続・migration 実行は `api/infrastructure/sqlite/`、Web と CLI の共通 HTTP 搬送は `client/` が所有します。domain 間 import の方向は `scripts/domains.ts` と `scripts/boundaries.ts` が検査します。`export … from`、動的 `import()`、型 `import("…")` も同じ規則で検査し、`web/src` と `client` から `api` へは `api/domains/<domain>/contracts` だけ、`cli` からは `client`・contracts・`api/infrastructure/auth-config` だけを許します。`bun run test:domain -- <name>` は所有試験のみ、`bun run verify -- --domain <name>` は format、lint、型依存閉包、境界、試験を確認します。

### domain 内の標準構成

backend の domain は `contracts/`(公開型・schema)、`controller/`(HTTP 登録)、`service/`(業務判断)、`repository/`(SQL と migration)、`test/`(所有する試験)に分け、外部へは `index.ts` と `contracts` だけを公開します。各ディレクトリの入口は `index.ts`、1 ファイルが 800 行に近づいたら主題ごとにファイルを分けます。例外は、配布物が置く `google-accounts/distribution-client.json`(`service/desktop-client.ts` が読む)と、Vite 設定が直接読む `google-accounts/proxy-errors.ts` です。

### HTTP の入出力

| 対象 | 使うもの | 規則 |
|---|---|---|
| JSON の本文 | `parseJsonBody(c, schema, {code?, emptyAs?})`(`api/infrastructure/http.ts`) | 読めない本文・壊れた JSON・schema 違反はすべて 400(既定 `invalid_input`)。`c.req.json()` を直接呼ばない。長さ上限を自前で検査する経路(`readBounded` など)だけは読み取りを持つ |
| クエリ | `parseQuery(c, schema, {code?})`、数値は `queryInt` | 変換・検証する値はすべて schema を通す。無い値は schema の既定値。空文字や数字でない値は 400 で、0 や NaN にしない |
| 投げたエラーの status | 各 domain の `contracts` の `errorStatus`、複数 domain が投げるコードは `api/application/error-status.ts` の `shared` | `app.onError`(`answerError`)が `{error: code}` と表の status を返す。表に無いコードは 500 `internal_error`。同じコードに別の status を付けると起動時に失敗する。controller は status の変換だけの catch を持たない |
| client の呼び出し | `callJson`、`json(body, method?)`、`withQuery(path, params)`(`client/transport.ts`) | JSON の応答は契約の schema で検証する。本文とクエリ文字列を手で組み立てない。バイナリ・SSE・本文の無い応答だけ `call` を直接使う |

### migration の追加規則

- migration は名前付きです。各 domain の `repository` が `export const migrations: readonly Migration[]`(`{ id, sql, after? }`)を持ち、`api/application/migrations.ts` が全 domain 分を集めます。DB には適用済みの id と SQL の SHA-256 を `schema_migrations_v2` に記録します。
- id は `"<owner>/<4桁連番>-<slug>"`(例 `conversation/0006-xxx`)。連番は owner ごとに続け、一度配った id は変えません。package の migration は位置で `memory-package/0007` のように名付けます。
- 新しい migration は必ず `after`(先に適用する migration の id)を明示し、追加後も `legacyOrder` には書き足しません。`legacyOrder` は 2026-10-10 以前の位置方式の順序を凍結したもので、旧 DB(INTEGER 表 `schema_migrations`)を初回起動時に `schema_migrations_v2` へ写すためだけに使います。旧表は残します。
- 適用済みの migration の SQL は 1 文字も変更・並べ替え・削除しません。変更は checksum 不一致(`migration_checksum_mismatch:<id>`)で起動失敗になります。直す場合は新しい migration を `after` 付きで足します。DB にあってコードに無い id は `migration_unknown_applied:<id>` で起動失敗になります(DB がコードより新しい)。
- `api/application/migrations.test.ts` の GOLDEN が凍結済みの順序と SQL を固定しています。このテストが落ちたら実装を戻し、期待値は更新しません。

Toolchainは `capabilities` が不変revision・候補検索・必須依存を、`tool-runtime` が所有者付き実行参照・入力検査・短期観測を、`agent-runtime` が制御step・子の予算・要約検査・採用ticketを所有します。既存Web取得を呼ぶadapterは `api/application/toolchain/toolchain.ts` が組み立てます。下位domainは上位のSQLを参照しません。CLI/Webは共通clientからHTTPを使います。

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
