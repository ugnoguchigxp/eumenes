# 参照されていないコードの整理計画

2026-10-31。状態: 合意済み（2026-10-31 利用者「消して良さそうな物ばかりなので消してください」。D1・D2 とも削除）・C1〜C6 実装済み・domain 単位の fixture 検証済み・未コミット。記録は §8。

利用者依頼（2026-10-31）「コードベースが巨大になっているのですが、参照されていないコード等を整理削除するタスクを依頼したいです。詳しく調査してください。保守領域は小さく保ってほしいです。」

この文書は調査結果と、削除作業の段階・規則をまとめたものです。製品の振る舞いは変えません。消すのは、本番の起動点（server・Web・CLI・coding-runner）から届かないコード、テストやスクリプトだけが呼ぶコード、終わった一回限りの検証スクリプト、置き換え済みの旧版です。§5 の2項目だけは利用者の判断が要ります。

## 1. 調査の方法

| 観点 | 方法 | 結果 |
| --- | --- | --- |
| 未使用ファイル・export（テスト込み） | `knip`（既存の `knip.json`） | 未使用ファイル 34、export 249、type 174。ファイルはすべて誤検出（パス文字列で読まれるfixture・`vite.config.ts` からのimportなど） |
| 本番から届かないコード | 起動点だけを入口にし、テストを project から外した knip（§7 の設定）と、Bun のトランスパイラで import を辿るスクリプト | 本番から届かない src ファイルは 7（すべてテスト・vite・手動コマンドの用途）。本番で使われない export 605・type 265 |
| ファイル内の未使用 | `tsc --noUnusedLocals --noUnusedParameters` | 12件（うち3件は作業中のファイル） |
| HTTP ルート | 312ルートを抽出し、web/src・cli の呼出しと、web/cli が実際に使う `client/` メソッドの中の URL に照合。候補88件は個別に確認 | 呼ばれないルート約45（テストだけ、または呼出しなし） |
| スクリプト | package.json・docs・AGENTS.md・.claude・設定・他コードからの参照を照合。候補は1本ずつ目的と状態を確認 | 削除できるもの 60ファイル・約9,000行 |
| 旧版・legacy | capability の登録・選択、bundle の pin、保存済みの行（`data/eumenes.sqlite3` を読み取り専用で確認）から到達性を追跡 | §4 C4・C5・C6 |
| s11tnext の context | `.s11tnext/catalog.json` の86キーを本番コードと照合 | 未参照 0（作業中の変更で既に整理済み） |
| 依存パッケージ | package.json の各依存を import と照合 | 未使用 0（`@playwright/mcp` は `require.resolve`、`s11tnext` は生成カタログの type import で使用） |
| CSS | web/src・artifact-ui の CSS クラス306件をコードと照合 | 未使用 25 |

規模の参考（追跡ファイル、テスト込み）: api/domains 約20万行、api/application 約7.3万行（うちテスト4.1万行）、web 約6.8万行、packages 約10万行、scripts 約3.3万行。

## 2. 対象外（残すもの）

| 対象 | 理由 |
| --- | --- |
| 適用済みのマイグレーション SQL、`legacyOrder`、`retired-migrations.ts`、`*_legacy` の改名 SQL、`legacy_route` 列 | 適用済みDBのチェックサムと順序のため。バイト単位で維持 |
| `find_toolchain`（検索の段） | 固定 |
| `single-harness-plan-2026-10-31.md` の対象（クラウドハーネス、道具を自分で呼ぶループ、`full` の system、agency の `respond`、評価の cloud 用の組み立て） | その計画で扱う。この整理では触れない |
| 固定の runtime map（`capabilities/contracts/runtime-meta.ts`）と物体認識の legacy 実行の枝 | web.search@8・web.service-search@5・history.research@2・world.query@8・music.create@4・music.library@2・image.create@2・object-recognition.manage@2・excalidraw.edit@1 が稼働中。削除ではなくデータ駆動への移行の作業 |
| 保存済みデータの読み取り互換（`legacyWorkerReportSchema`、tts の旧項目、通知音の旧ID、ui-compositions の旧行、music の旧 source `music-<id>`、Kanban v1 アダプタ） | 保存済みの行・定義を読む。消すにはデータ移行が先に要る。Kanban v2 は v1 アダプタの上に作られている |
| intent の `"legacy"` モード | 判定を切るスイッチとして使われている |
| `task-execution.bundle.dormant.json` と `dormantBundleFile` | 2026-10-21 に停止した機能。`docs/task-execution.md` が実装と試験を意図して残すと明記 |
| 文書に運用手段として書かれた操作用ルート（§4 C2 の「残すルート」） | 設定の唯一の書き手を含む |
| `spec/verification/`（追跡78MB）・`spec/design/`（69MB）の記録 | コードではない。保守の対象外 |
| 作業ツリーの未コミットの変更（2026-10-31 時点で141件） | 別の作業中。§6 の着手条件を参照 |

## 3. 見込み

| 段階 | 内容 | 削除の見込み（テスト込み） |
| --- | --- | --- |
| C1 | 未使用のシンボル・export・CSS | 数百行と、公開面の export 約580件の縮小 |
| C2 | 呼ばれない HTTP ルートと `client/` メソッド | 約45ルート、約1,000行と付随テスト |
| C3 | 終わった一回限りのスクリプト | 60ファイル、約9,000行 |
| C4 | capability・toolchain の旧版 | 約1,500行 |
| C5 | legacy の経路 | 約900行（D2 を削除にすると +約300行） |
| C6 | Codex CLI を直接起動する旧ランナー（D1） | 約11,000行 |
| 合計 | | 約13,000行（D1 を削除にすると約24,000行） |

## 4. 段階

各段階は独立にコミットできます。順番は C3 → C1 → C2 → C4 → C5 → C6 です（スクリプトを先に消すと、スクリプトだけが使っていた export が C1 の検出に出てくるため）。

### C1 未使用のシンボル・export・CSS

規則:

| 状態 | 処置 |
| --- | --- |
| 定義がどこからも使われない | 定義を削除 |
| 本番から使われず、テストだけが使う（ファイル内でも未使用） | 定義と、それだけを試す試験を削除 |
| ファイル内では使うが、他から import されない | `export` を外す |
| ファイル内で使い、テストが import する | 残す（試験のための export） |
| 番号付きの公開口（`index.ts`）の再exportで、どこからも import されない | 再exportを削除 |
| 公開口の再exportで、同じ domain のテストだけが import する | テストを domain 内部の module からの import に変え、再exportを削除 |
| 公開口の再exportで、他の domain や application のテストが import する | 残す（domain の境界のため） |

削除する定義（どこからも使われない。削除前に `find_referencing_symbols` で0件を確認する）:

| ファイル | シンボル |
| --- | --- |
| api/application/pipelines/pipelines-adapter.ts | `pipelinesDomainSchemas` |
| api/domains/browser/contracts/history.ts | `HISTORY_TITLE_CHARS` |
| api/domains/inference/adapters/codex-sdk.ts | `lockedCodex` |
| api/domains/larm/contracts/monitoring-v1.ts | `MONITORING_RETENTION_MS`、型 `MonitoringRuntime` `MonitoringGpu` `MonitoringCoverage` `MonitoringEvents` |
| api/domains/larm/service/visual-perception.ts | `visualError`（`larm/index.ts` の再exportも） |
| api/domains/resources/contracts/index.ts | `RESOURCE_SCHEME` |
| api/domains/steward/repository/index.ts | `decisionsOfMessages` |
| api/domains/steward/service/steps/shared.ts | `allMessageIds` |
| web/src/domains/pipelines/toolchain-adapter.tsx | `PIPELINE_STUDIO_ARTIFACT_ID` |
| 型のみ | `AgencyHost` `LateResources` `TaskExecutions` `TimeLimits` `AgentTurnV1` `ResourceViewing` `ContextKeeper` `MessageReply` `MeshAsset` `MeshCatalogService` `MeshJob` `MeshLibrary` `Model3dCreate` `MonitoringHealth` `ExecutionControl` `ComputedDefinition` `Model3dFocus` `PromptEdit`。`ReturnType<typeof …>` の別名は使う側がないなら削除 |

本番から使われずテストだけが使う定義（試験ごと削除。試験が他の振る舞いも見ている場合は、その部分だけ残す）:

| ファイル | シンボル |
| --- | --- |
| api/application/migrations.ts | `hostMigrations` |
| api/application/world/world.ts | `manualAccess` |
| api/domains/agent-runtime/service/report-projection.ts | `readStoredReportProjection` |
| api/domains/capabilities/index.ts | `builtinToolchainFunctions` |
| api/domains/dialogue/repository/intent.ts | `intentJudgmentsOfMessage` |
| api/domains/goals/repository/index.ts・service/index.ts | `goalHistory` `goalRevisionOfUnscoped` `goalEpochOf` |
| api/domains/inference/contracts/operation-output.ts | `operationOutputContract` `operationOutputReceipt` |
| api/domains/kanban/service/text.ts | `FOLLOWUP_QUOTED_NOTE_MAX` |
| api/domains/memory/repository/tendency.ts・service/quote.ts | `quoteMatchedOf` `locateQuote` |
| api/domains/settings/contracts/spatial.ts | `spatialControls` |
| api/domains/world/controller/index.ts | `registerWorldQuery`（どこにもマウントされていない。world/README.md:264） |
| api/domains/world/service/ | `createWorldQueryTool` `createRuntimeObservation` `gapTaskRequestId` |
| web/src/domains/audio/tone.ts | `TIMER_TONE` |
| web/src/domains/music/artifact-definition.ts | `musicArtifactDefinition` |
| web/src/errorMessages.ts | `describeTurnStatus` |

残すもの: 残すスクリプトが使う `readStoredLarm` `readStoredObjectRecognitionConnection` `readStoredExcalidrawAvailability`・`api/application/toolchain/toolchain-live-check.ts`。`flushLogging` は C3 の後に検出し直して決める。

その他:

| 対象 | 処置 |
| --- | --- |
| `export` を外す対象（どこからも import されないが、ファイル内で使う） | export 約170・type 約60。§7 の設定で一覧を出す |
| 公開口の再export（どこからも import されない） | export 約40・type 約80。例: `dialogue/index.ts` の `queueLinkMigration` など個別マイグレーション、`browser/index.ts` の型群、`inference/index.ts` の型群、`pipelines/index.ts` の `QUOTE_SUFFIX` `references` `PIPELINE_RESOURCE_KIND` |
| 公開口の再export（テストだけが import する） | 約220。上の規則で同じ domain のテストだけのものを外す |
| 未使用の引数・変数 | `agent-runtime/service/execution-child.ts:39` `input`、`dialogue/service/execution-command.ts:181` `db`、テストの4件。`dialogue/service/executor-{delegation,search,work}.ts` は作業中のファイルなので対象外 |
| CSS | `packages/artifact-ui/src/styles.css` の showcase・token editor の20クラス（`aui-showcase*` `aui-token-*` `aui-inspector` `aui-sample-tabs` `aui-preview` `aui-code` `aui-controls` `aui-definition` `aui-description` `aui-events` `aui-grid*` `ds-tabs-root`）、`ui-studio.css` の `aui-ui-step`、`web/src/app.css` の `status-completed` `status-error` `status-listening` `status-ready` |
| 重複した定義 | `steward/contracts/index.ts` の `eventsQuerySchema` と `activityQuerySchema`（同じ値）、`artifact-ui/src/browser-components.tsx` の `BrowserWorkspaceView` と `BrowserSettingsView`（同じ値）。使う側を一方に寄せる |

### C2 呼ばれない HTTP ルートと `client/` メソッド

データ駆動へ移った画面は、汎用の toolchain-artifact API とサーバー側の DomainAdapter（`*InTransaction` の関数）を使います。移行前のドメイン別のルートと `client/` のメソッドは残っていますが、呼び出しているのはテストだけです。ルートを消してもサービスの関数は残ります（アダプタが使うため）。

削除するルート（テストだけが呼ぶ、または呼出しなし）:

| ルート | 一緒に消すもの |
| --- | --- |
| GET `/api/agent-executions`、`/api/agent-executions/:id` | controller 部分。`docs/task-execution.md:13` の記述 |
| GET `/api/browser/connection`、`/api/browser/tasks/:id`、`/api/browser/captures` | controller 部分、`service.listCaptures` の包み |
| GET `/api/compute/environment` | service `environment()`。`docs/compute.md:38` の記述 |
| GET `/api/conversations/:id/continuity` | `continuity/controller` 一式、公開口の export、`app-modules.ts` のマウント |
| GET `/api/inference/status`、`/api/inference/probes/:id`、GET/POST `/api/inference/probes`、POST `/api/inference/probes/:id/cancel`、GET `/api/inference/usage/page` | controller 部分、`app.ts` の probes の制限、`startProbe` の包み、`client/settings.ts` の5メソッド |
| GET `/api/model3d/assets/:id/source` | `model3d/service/assets.ts` と `larm/service/mesh-library.ts` の source 取得 |
| GET `/api/music/tracks/:id/metadata` | `larm/service/music-library.ts` の `metadata()` |
| GET `/api/service-tests/runs/:id`、GET `catalog`、POST `catalog/refresh`、POST `diagnose`、GET/POST `runs`、POST `runs/:id/cancel`、POST `runs/:id/retry-artifact` | controller 部分、`app.ts` の制限、包みの関数、`client/service-tests.ts` の7メソッド。残す: POST `/uploads`（Web が使う）、GET `runs/:id/artifact`（サーバーが組み立てるプレビューURL） |
| GET `/api/steward/events` | controller 部分 |
| GET `/api/world/documents/page`、GET `/api/world/documents`、DELETE `/api/world/documents/:id` | controller 部分、`withdraw` と `repository/documents.ts` の `withdrawDocument` |
| POST `/api/world/query` | C1 の `registerWorldQuery` |
| GET `/api/world/status`、`/claims`、`/claims/:id`、`/forgets` | `world/controller/claims.ts`、`app-modules.ts` の `registerWorldClaims`、`client/world.ts` |
| GET `/api/coding/workspaces`、`/api/coding/executions/:id`、`/api/coding/executions/:id/events` | coding controller、`client/coding.ts`（D1 を削除にすると C6 で一緒に消える） |
| GET `/api/tasks/:id/reports`、`/api/tasks/:id/supervisor` | task-reports controller、`reports.list`、`client/coding-supervision.ts`。`docs/coding-supervision.md:49-50` の記述 |
| GET `/api/queue/status`、GET `/api/jobs/:id/attempts`、POST `/api/jobs/:id/cancel` | controller 部分、`listAttempts`、`client/queue.ts` |
| GET `/api/memory/short-term`、`/tendencies`、`/context` | controller 部分、`memory/service/views.ts` の `context`、`client/memory.ts` の3メソッド |
| GET `/api/toolchain-history/selections/page`、`/recipes/page` | controller 部分、`client/toolchain-history.ts` の2メソッド |
| GET `/api/toolchain-interactions/:id`、POST `/api/toolchain-interactions/:id/cancel` | controller 部分、`interactions.get`、`interaction-answers.ts` の `cancel`、`client/toolchain-actions.ts` の2メソッド。`docs/toolchain-extension.md:291` の調査手順は「ログで見る」に書き換える |
| GET `/api/tts-dictionary`、POST `/save`、POST `/delete` | `tts-dictionary/controller` 一式、包みの関数、`client/tts-dictionary.ts`。`tests/browser/settings-data-driven-p3.spec.ts` の準備は設定画面の操作か DomainAdapter に置き換える |
| GET `/api/dots/tasks/:id/snapshot` | controller 部分（`taskSnapshot` は MCP が使うので残す） |

残すルート（文書に書かれた運用手段、外部からの呼出し、サーバーが組み立てるURL）:

| ルート | 理由 |
| --- | --- |
| GET/PUT `/api/settings/docling` | `docs/docling.md:11,53`。`settings_docling` の唯一の書き手 |
| GET/PUT `/api/settings/excalidraw` | `docs/excalidraw.md:9,56-57`。唯一の書き手 |
| GET `/api/toolchains/search-check` | `docs/toolchain-extension-verification.md:73` |
| POST `/api/pipelines/check`・`/fixture`・`/publish` | `docs/toolchain-extension.md:49` の手動登録 |
| POST `/api/capabilities/toolchains/:id/publish`・`/artifacts/:id/publish` | `docs/toolchain-extension.md:266` の rollback API |
| GET/PUT `/api/capabilities/dots-packages`、PUT `/api/dots/connections`・`/api/dots/projects`、POST `/api/dots/tasks/:id/schedules` | `docs/dots.md:182,297`・`docs/toolchain-extension.md:333,352-353`。接続・package の唯一の書き手 |
| `/api/schedules` 一式 | `docs/settings.md:83`（管理は API だけ） |
| POST `/api/world/documents` | world 文書の唯一の取込み口（`scripts/world-documents-import.ts`） |
| `/.well-known/oauth-protected-resource/mcp/dots/:owner`、`/oauth/google/result`、POST `/hooks/terminals/:id` | 外部（MCP・OAuth・Claude Code の hook）が呼ぶ |
| GET `/api/browser/captures/:id/content`、`/api/google-accounts/photos/:handle/items/:id/content`、`/api/service-tests/runs/:id/artifact` | サーバーが組み立てたURLを Web が `<img>` などで開く |

`client/` は、web/src・cli・残すスクリプトが呼ばないメソッドを消します。対象は上の表で消すもののほか、`client/dots.ts` の6メソッド（運用者は HTTP を直接使う）、`client/scheduler.ts`（`client/dots.ts` 以外に使う側がない）、`client/music.ts` の `musicPlaylist`、`client/shell.ts` の `shellSessions`、`client/timers.ts` の `pauseTimer` `resumeTimer` です。`client/test/` の試験は、消したメソッドの分を削除します。

### C3 終わった一回限りのスクリプト

削除するもの（参照なし、または日付付きの検証記録だけが参照する。取り込みは全て解決していて、壊れたものはない）:

| ファイル | 理由 |
| --- | --- |
| `scripts/codex-tasks-p0/` の `continue` `git-live` `orphan-live` `permissions` `process-tree` `run` `runner-boundaries` `runner-client` `runner-live` `runtime` `stop` `turn`（12） | P0 の検証（P0〜P5 完了）。`process-tree.ts` は sdk-process-tree.ts の古い写し |
| `scripts/dots-mvp/` 一式（15、`mvp.test.ts` を含む） | `packages/dots-mcp` に置き換え済み（`docs/dots.md:7`） |
| `scripts/conversation-speech-live.ts` `first-round-live.ts` `recipe-reuse-live.ts` `short-answer-live.ts` `larm-instruction-history-live.ts` `ocr-qr-benchmark.ts` `world-fixture-server.ts` | 参照なし |
| `scripts/dots-messaging-live.ts` | P5 の受入は完了 |
| `scripts/generate-attitude-seed.ts` | 出力の `data/attitude-seed/attitude-seed-1-2026-10-24.jsonl` は生成済み |
| `scripts/larm-provider-deployment-check.ts` `larm-provider-isolation-live.ts` `larm-provider-readiness-live.ts` | 準備の作業は完了（spec/larm-provider-readiness §137-145） |
| `scripts/music-answer-live.ts` `music-creation-ui-check.ts` `profile-live.ts` `service-search-live.ts` `settings-voice-sample-live.ts` `speech-voice-pair-live.ts` `voice-repair-live.ts` `ocr-correction-live.ts` `ocr-correction-probe.ts` `ocr-ui-check.ts` `ocr-ui/app.tsx` | 日付付きの検証記録だけが参照する。OCR の画面は `tests/browser/ocr.spec.ts` が見ている |
| `scripts/notification-sounds-check.ts` `notification-sounds-generate.ts` | 10音は採用・検証済み |
| `scripts/response-decision/cache-control.ts` `visibility.ts` | 対照実験と診断は終わり、結果は README に記録済み。README からそのコマンドを消す |
| `scripts/toolchain-routing-eval.ts` | `toolchain-search-check.ts` に置き換え済み |
| `scripts/visual-analysis-live.ts` `visual-perception-lifecycle-live.ts` `visual-stop-observation-live.ts` | `visual-response-live.ts` に置き換え済み |
| `scripts/world-documents-seed-check.ts` `world-reference.live.ts` | 一回限りの確認。world-reference の spec は archive 済み |

残すもの: `excalidraw/configure-live.ts`（docs）、`dots-oauth/*`（docs/dots.md:233 の受入手順）、`response-decision/cache.ts` `cache-input.ts` `report.ts`、`decision-bench/*`、`codex-tasks-p0/transport.ts` とその2試験、`task-execution-live.ts` と `live-pipelines.ts`、`visual-response-live.ts` `visual-response-app-live.ts`、`evaluate-delivery-live.ts`（spec/decision-model-benchmark-design.md:27）、`world-documents-import.ts`。knip が「未使用」とした test-support の17ファイルはパス文字列や vite 設定から読まれているので残します。

利用者の手元の作業（リポジトリ外）: `~/.codex/config.toml` の `[mcp_servers.eumenes-dots-mvp]`（407-409行）が `scripts/dots-mvp/headers.ts` を呼びます。dots-mvp を消すときに、この項目も利用者が消してください。

### C4 capability・toolchain の旧版

registry は行を消しません（`capabilities/service/registry.ts:46-58,96-103`）。古い revision の定義をコードから外しても、既存DBに登録済みの行は使え続けます。新しいDBにその版が入らなくなるだけです。

| 対象 | 処置 | 根拠 |
| --- | --- | --- |
| web-research の `SKILL.md`・`SKILL.v2`〜`SKILL.v8.md` と `builtin/web-research.ts` の大部分（package web.research/lookup/read の全版、web.quick@1-2、web.search@1、web.recipe@1、skill web.research@1-8・web.search@1、profile web.research@1/@2、tool web.lookup@1・web.forecast@1・web.quote@1）、`builtin-seed.ts` の `isSupersededBuiltin` | 削除 | 新しい実行は bundle の `web.quick@7`（`agent-runtime/service/start-task.ts:100-105`）。web.search@8 は `package:web.recipe@6` |
| 上の中で残す tool: `web.lookup@2` `web.read@1` `web.find@1` `web.read_saved@1` `recipe.find@1` | 残す（bundle が pin） | 新しい版が古い版を展開して作られている（`web-research.ts:207-480`）。残す版は展開をやめて同じ JSON を直接書く。JSON が1文字でも変わると既存DBで `capability_revision_conflict` になる |
| dots `MESSAGING.v1.md` | 削除 | どこも読まない（`builtin/dots.ts:73-85` は v2 だけ） |
| dots `SKILL.v1.md`、`dots.orchestrate@1` | 削除 | 保存済みの project は `@2` を pin。@1 は `work/dots-audit.test.ts:18` だけ |
| music `SKILL.md` `SKILL-v2.md`、music-playback `SKILL.md`、tool music.generate@1/@2・music.library@1、package music.create@1/@2・music.playback@1、`toolchains.json` の music.create@1・music.library@1、validator `musicPlan` `musicPlanV2` `musicPlaybackPlan` | 削除 | 稼働中は music.create@3・music.playback@2 |
| object-recognition `SKILL.md`、tool・package @1、`toolchains.json` @1、validator `recognitionManage` | 削除 | 稼働中は @2（SKILL-v2） |
| history `SKILL.md`、package @1、`toolchains.json` history.research@1 | 削除 | `conversation-history.bundle.json` が @2 を pin |
| `toolchains.json` image.create@1 | 削除 | 同じファイルの @2 に置き換え済み |
| bundle 内の古い revision の連なり: `web-guided.bundle.json` 一式（web.recipe@2・web.search@2・web.quick@3）と `guided-contract.ts` の対応部分、web.search@5-7、web.service-search@1-4、ocr.manage@2-5、dots.delegate@5、toolchain music.create@3 | 削除 | 現在の状態から届かない。既存DBの行は履歴として残るが、外した版への rollback はしない（入力検証・実行の対応がコードからなくなる） |
| `timers.bundle.json` の toolchain @2-4 と @1 の pin、timers `SKILL.md`、`package:timers.manage@1`、`timer-compatibility.test` | 削除 | 稼働中の @6 は package@2 |

消す版を試す試験（`web-research-rename` `web-research-codex-retire` `lookup-upgrade` `music-versions` `timer-compatibility`、`capabilities.test` の該当部分）も消します。

文書の更新（この計画への合意で方針の変更とする）: `docs/toolchain-extension.md` 付録R の手順1（旧版を残す決まり）を「置き換えた版はコードから外す。既存DBの行は registry が保持する」に改めます。同じ文書の 5・484行と `.claude/skills/data-driven-toolchain/SKILL.md:3` は dots を未移行としているので、移行済みに直します。

### C5 legacy の経路

| 対象 | 処置 | 根拠 |
| --- | --- | --- |
| dots の legacy 実行: `toolchain/task-legacy-execution.ts` の dots の半分、`work/dots-dialogue.ts`、`dialogue/contracts/delegation.ts`、`execution-command.ts:214-229` の `legacyTask` `cancelLegacyTask`、`contracts/toolchains.ts:59-66` の `requires: "timers"\|"dots"`、`task-execution-catalog.ts:27` の判定、`task-execution-legacy.test` の dots 部分 | 削除 | dots では `legacyAvailableInTransaction` が常に false（`execution-command.ts:180-186`）。dots は `binding:dots.delegate@3` に移行済み。保存済みの `{kind:"legacy",type:"dots"}` の参照は読取りと取消しだけで使われるので、消す前に該当の行が残っていないことを読み取り専用で確かめる。残っていれば終了扱いにするマイグレーションを足す |
| learned route-only の capability: `registerLearned` `pruneLearned` `hasLearned`、`skill:web.research@2` への fallback（`capabilities/service/index.ts:27-37,199-300`）、`contracts/index.ts:463-466`、`registry.ts:26,104-115`、`agent-runtime/test/route-harness.ts` の該当部分 | 削除 | 本番から呼ばれない（呼ぶのはテストだけ）。DBの learned 項目は0。2026-10-12 に退役した route 学習の残り。DBの列は残す |
| `dots/contracts/index.ts:44` の既定 `package:dots.orchestrate@2` | 対象外（不具合として別に扱う） | 役割の選択肢は @4（`work/dots-project-role.ts:17`）。削除ではなく既定値の修正 |
| `api/application/repair-legacy-continuity.ts`、`continuity/repository/legacy-events.ts`、`hasLegacyContinuityEvents`、`archiveLegacyContinuityEventsInTransaction`、`docs/logging.md:90-96`、`infrastructure/sqlite/index.ts:106-140,241-245` の `importLegacyMigrations` | D2 | 利用者のDBは修復・変換済み（`continuity_legacy_bookmark_events` があり、`schema_migrations_v2` は226行） |

### C6 Codex CLI を直接起動する旧ランナー（D1）

Codex を動かす経路は2本あります。稼働中は `@openai/codex-sdk` を使う SDK 版（`packages/coding-runner/src/sdk-*` の常駐プロセス。Kanban の実行者 `codex` と codex-tasks が使う）です。旧ランナーは `codex` コマンドを MCP 経由の worker から起動し、Eumenes が監督する計画02・03の仕組みで、有効化されていません。Claude Code（Kanban の実行者 `claude-code`、terminals ドメインと hook）と Codex の SDK 版は残します。

| 対象 | 行数 |
| --- | --- |
| `packages/coding-runner/src/` の `core` `worker` `server` `host` `admin` `mcp` `decoder` `event-writer` `git-operations` `continuation` `config`、`contracts`・`client`・`observation` の eumenes-coding/1 の部分 | 約2,000 |
| `packages/coding-runner/test/` の `runner` `git` `protocol`（旧系の部分） `observation` `retention` `review`、`fixture-server.ts` | 約1,700 |
| `api/domains/coding`（SDK の再exportの `index.ts:23-30` と共有の `storage.ts`・`workspace.ts` は残す） | 約1,300 |
| `api/domains/coding-supervision` | 約4,150 |
| `api/application/work/coding*.ts`、`server-tasks.ts:43-45` の配線、`EUMENES_CODING_RUNNER_CONFIG` | 約1,900 |

根拠: `EUMENES_CODING_RUNNER_CONFIG` があるときだけ配線され（`server-tasks.ts:43-45`、`config.ts:143`）、本番の probe は常に `isolation_not_verified`（`core.ts:233-242`）、supervision の流れは利用不可に固定（`work/coding-supervision.ts:30-36`）。`docs/coding-runner.md:3` は「実装中、有効化しない、C4〜C7 が残り」。DB の `coding_workspaces` `coding_executions` `coding_supervisors` は0行。稼働中の Codex の経路は SDK 版（codex-tasks、`kanban-sdk-host`）です。

消す場合、`coding` と `coding-supervision` の適用済みマイグレーションは `retired-migrations.ts` へ移し、バイト単位で維持します（research-routes の前例と同じ）。表を消すかどうかは別のマイグレーションで決めます（行は0）。計画02・03（`spec/delegated-coding-implementation-2026-10-09/`）は中止として索引に記録し、`docs/coding-runner.md` `docs/coding-supervision.md` を SDK 版だけの記述にします。

## 5. 利用者の判断が要る項目

| 番号 | 問い | 推奨 |
| --- | --- | --- |
| D1 | Codex CLI を直接起動する旧ランナー（C6、約11,000行）を消してよいか。計画02・03の CLI runner・supervision を中止することになる。Claude Code と Codex の SDK 版は残る | 削除。有効化されたことがなく、Codex は SDK 版で動いている |
| D2 | 2026-10-10 より前の形式のDB（continuity の旧イベント、旧マイグレーション表）が、利用者のDB以外に残っているか | 残っていなければ削除（C5 の最後の行、約300行） |

それ以外の判断はこの文書で決めました（§2 の対象外、§4 C2 の残すルート、§4 C4 の古い revision の連なりの削除）。

## 6. 実施の規則

| 項目 | 決まり |
| --- | --- |
| 着手の条件 | 作業ブランチ `local-review-intake` の変更がコミットされてから、main で行う。着手時の `git status` で変更中のファイルには触れず、該当箇所は後回しにする |
| 他の計画との関係 | `single-harness-plan-2026-10-31.md` の対象には触れない。その計画が先に入った場合は、§7 の検出をやり直してから始める |
| 削除の確かめ方 | シンボルは `find_referencing_symbols` で参照0を確かめてから消す。ファイルは basename をリポジトリ全体（docs・spec を含む）で検索してから消す。パス文字列での読込み（`bun build` の入口、spawn、vite 設定）に注意する |
| 連鎖 | 消した結果、新たに未使用になったものは同じ段階で消す。段階の終わりに §7 の検出を再実行し、0件（または残す理由を書いた ignore）にする |
| 試験 | 消したコードだけを試す試験は消す。ほかの振る舞いも見ている試験は、該当部分だけ消す。試験を通すために本番コードを残さない |
| 文書 | 消したルート・スクリプト・版を挙げている docs の記述を同じコミットで直す。spec/verification・archive 済みの記録は書き換えない |
| 検証 | 段階ごとに `bun run lint`、`bun run typecheck`、`bun run verify -- --domain <name>`（消した domain と、それを使う domain）。C2 で E2E の準備を変えた場合は、その試験ファイルを個別に実行する。fixture の結果として記録する |
| サーバー | 起動・停止・再起動はしない。再起動が要る確認は利用者に頼む |
| サイズの記録 | `scripts/size-budget.json` `scripts/bundle-budget.json` に消したファイルが載っていれば `--write` で記録し直す |

## 7. 再発の防止

既存の `deadcode`（`knip --include exports,types`）はテストを入口に含むため、テストだけが使うコードと、届かないファイルを見つけられません。`knip.json` を次の形に置き換え、`deadcode` を `knip --include files,exports,types` に変えて、本番の起動点から検出します。設定ファイルは増やしません。

```json
{
	"$schema": "https://unpkg.com/knip@6/schema.json",
	"ignoreWorkspaces": ["packages/design-system"],
	"ignoreExportsUsedInFile": true,
	"workspaces": {
		".": {
			"playwright": false,
			"vitest": false,
			"bun": false,
			"vite": false,
			"entry": [
				"web/src/main.tsx",
				"api/domains/ocr/service/qr-decode.ts",
				"web/src/domains/background/models/*.ts",
				"scripts/**/*.{ts,tsx,mjs}",
				"!scripts/**/*.test.{ts,mjs}"
			],
			"project": [
				"api/**",
				"web/src/**",
				"client/**",
				"cli/**",
				"!**/*.test.{ts,tsx}",
				"!**/test/**",
				"!**/*.fixture.{ts,tsx}",
				"!**/fixtures/**",
				"!**/fixture.ts",
				"!**/fixtures.ts",
				"!**/test-support.tsx",
				"!**/eval/**"
			],
			"ignore": [
				"api/infrastructure/wait-for.ts",
				"api/application/work/dots-fixture.ts"
			]
		},
		"packages/artifact-ui": {
			"project": ["src/**", "!src/**/*.test.{ts,tsx}"]
		},
		"packages/coding-runner": {
			"entry": ["src/sdk-transport.ts", "src/sdk-git-mcp.ts"],
			"project": ["src/**"]
		},
		"packages/dots-mcp": {
			"project": ["src/**"]
		}
	}
}
```

| 設定 | 意味 |
| --- | --- |
| `entry` | 本番の起動点のうち knip が package.json から拾えないもの（Web・別プロセスで起動するファイル・背景モデルの glob 読込み）と、scripts のすべて（テストを除く）。server・db-backup・CLI と各 package の公開口は package.json の scripts・exports から拾われる。scripts だけが使う export は「使用中」になる。scripts そのものが要るかどうかは機械では決めず、C3 のように個別に判断する |
| `project` | テスト・fixture・eval を外す。テストだけが使うコードが検出に出る |
| `ignoreExportsUsedInFile` | ファイル内で使う export（試験のための export）は報告しない |
| `ignore` | テストからだけ読まれる2ファイル（`wait-for.ts`・`dots-fixture.ts`） |
| plugin の無効化 | Playwright・Vitest などの plugin がテストの入口を足すのを止める |

2026-10-31 の作業ツリーでの結果は、未使用ファイル 0、export 229、type 182 です（この数が C1 の対象）。C1 の後は0件にします。意図して残す export（他の domain のテストが使う公開口の再exportなど）には `/** @public */` を付けて除外します（再exportの指定子にも効くことを確認済み）。

`--production` は使いません。この repository では、knip 6.38.0 の production 解析で `api/application/server.ts` が依存グラフから外れ、server 配下のほぼすべてが未使用と誤って出ました。

## 8. 実施記録

2026-10-31 実施。別セッションの未コミット作業（`local-review-intake` ブランチ、着手時140件）のファイルには原則触れず、こちらの削除で壊れた箇所だけ最小の差分で直した。コミットはしていない。

### 8.1 段階ごとの結果

| 段階 | 実施したこと |
| --- | --- |
| C3 | §4 C3 の60ファイル（9,049行）を削除。`scripts/response-decision/README.md` から消したコマンドを外した |
| C6 | Codex CLI を直接起動する旧ランナー（`packages/coding-runner` の旧系、`api/domains/coding` の旧系、`api/domains/coding-supervision`、`api/application/work/coding*`、`client/coding*.ts`）を削除。適用済みマイグレーション4件（`coding/0001-init` `coding/0002-indexes` `coding-supervision/0001-init` `coding-supervision/0002-indexes`）は `retired-migrations.ts` へ移し、id・`after`・SQL が HEAD と一致することを確認。連鎖で `delegated-tasks.ts`（実行の経路が常に無効だった。コミットごとに queue・scheduler を起こす処理は `server-tasks.ts` に残した）、tasks の coding 種別、設定の `codingSupervision.approveInstructions` と設定画面「外部作業」（bundle の artifact 2版）、lifecycle の `exclusive` を削除。保存済み設定の `codingSupervision` は読込み時に落とす。docs と README を SDK 版・dots・Claude Code の記述に更新 |
| C4 | §4 C4 の旧版を削除。`history.research@1` を外した結果、置き換え先だった `conversation-history.bundle.json` を別セッションが外したため、新規DBに会話履歴の担当がなくなる。これは `conversation-read-tools-design-2026-10-31.md`（合意済み・実装中）の R2（`conversation_history` を消して `read_history` にする）と同じ方向なので戻さない。`requirements-toolchain.test.ts` の `history.research` を使う試験は R2 の範囲で直る。残す版の定義 JSON は削除前と一致（新規DBの revision 394行→294行、残る全行の `definition_json` が一致）。利用者DBの複製への seed で `capability_revision_conflict` なし。利用者DBに残る「外部作業」画面の pointer は `capabilities/0010-retire-external-work` で外す（複製に適用して確認）。追加で `web-service-search` bundle の孤児（`browser.service-search` package @1〜5・skill @1〜4、`browser.page.collect` @1〜2）、使われなくなった validator（`recognitionManage` `musicPlan` `musicPlanV2` `musicPlaybackPlan` `forecast` `quote` `lookup`）、音楽の版ごとの分岐、`capabilities/contexts/web-research` の context 5本、`runtime-meta.ts` の `web.forecast` `web.quote` を削除。DB に残る旧 tool の validator がない場合は `capability_revoked` として扱う |
| C5 | dots の legacy 実行（`work/dots-dialogue.ts`、`dialogue/contracts/delegation.ts`、`legacyTask` など）、learned route-only の capability、D2 の `repair-legacy-continuity.ts` と `importLegacyMigrations` を削除。利用者DBの複製に `{kind:"legacy",type:"dots"}` の参照は0件 |
| C2 | §4 C2 の削除するルートをすべて削除（continuity の GET を含む）。`client/queue.ts` `client/scheduler.ts` `client/tts-dictionary.ts` `client/world.ts` と、呼ばれない client メソッドを削除。`tests/browser/settings-data-driven-p3.spec.ts` の準備はデータ駆動の経路（toolchain-artifact の読取りと `POST /api/toolchain-actions`）に置換 |
| C1 | `knip.json` を §7 の設定に置換し、`deadcode` を `knip --include files,exports,types` に変更。未使用の定義・型・再export を約195件削除、テストだけが使う定義を試験ごと削除、同じ domain のテストだけが使う再export 98件はテストの import を内部 module に変更、他の domain・application のテストが使う公開口の55指定子に `/** @public */`。連鎖で world の runtime 観測一式、`report-projection.ts`、`ResourcesScreen`、inference の `operation-output` の context、`codex-launcher.ts` を削除。未使用CSS（artifact-ui の showcase・token editor、`app.css` の `status-*`）を削除 |

削除量は、別セッションの変更ファイルを除いて536ファイル、追加1,419行・削除35,922行（差し引き約34,500行）。

### 8.1.1 追補（2026-10-31 利用者「削除、修正やっていいです。やりきってください」）

| 項目 | 実施 |
| --- | --- |
| 独立レビューの指摘 | コミットごとに queue・scheduler を起こす処理を `server-tasks.ts` に戻し、停止時に外す（`delegated` の close）。`capabilities/0010-retire-external-work` を追加。外した版へは rollback しないことを `docs/toolchain-extension.md` 付録R に明記 |
| `EUMENES_DELEGATED_TASKS_ENABLED` | `config.ts`・`config.test.ts` から削除 |
| verify の boundaries（既存の違反） | `web/src/domains/resources/index.ts` から `KindIcon`・`ArtifactIcon` を公開し、`NotificationCenter.tsx` は公開口から読む。`scripts/domains.ts` の timers の web 依存に `resources`（tier 0）を宣言し、`docs/domains.md` を再生成。C1 で kanban の試験が capabilities の内部を読んでいた2件を kanban 自身の `contracts` からの import に直した |
| size-budget（既存の超過） | `bun scripts/size-budget.ts --write` で記録し直した。新たに載ったのは HEAD から予算外だった `agency/host.ts`（file 939・`createAgencyHost` 801）、`buildServices`（348）、`ImagePicker`（376）、`useRecognitionRuntime`（306）、`voice-dialogue/test/settings-integration.test.ts`（1,001）。今回の削除で閾値を下回った6項目は表から外れた |
| 別セッションのファイルに残っていた未使用 export | `memory/index.ts` の再export（同じ domain の試験だけが使う4件は試験を `../repository` に張り替えて削除、他の domain の試験が使う7件と `MemoryEmbed`・`profileItemFields` は `@public`、`TurnRecall`・`CheckedItems` は削除）、`inference/contracts/index.ts` の `probeSchema`・`startedProbeSchema`・`IntentLabel` の再export、`larm/contracts/index.ts` の `imageImportReceipt`・`MusicProviders` の再export、`context-keeper.ts` の `ContextKeeper` を削除 |
| 試験だけが使っていた本番コード | `interaction-answers.ts` の `cancel`（HTTP の取消しはC2で削除済み）と `OPEN_STATUSES` を削除。取消しだけを試す2件を削除し、保持期間の試験は期限切れ（`maintenance` の expired）でやり取りを終える形に変更。`intentJudgmentsOfMessage` は別セッションの `executor-read.ts` が本番で使うようになったので `@public` を外した |
| `bun run deadcode` | 0件 |

### 8.2 検証（fixture、2026-10-31 12:05 時点）

| 確認 | 結果 |
| --- | --- |
| `bun run typecheck`・`bun run lint`・`bun run context:check`・`bun run deadcode` | 通過（deadcode は0件） |
| `scripts/size-budget.ts`・boundaries（`checkBoundaries`・`unusedDependencies`）・`scripts/sql-boundaries.ts`・`scripts/domain-docs.ts --check` | 通過 |
| `bun run format:check` | `api/domains/dialogue/test/routed-turn.test.ts`（別セッションが 11:56 に編集中）だけ未整形 |
| `bun test`（`api/application`・`api/domains`・`api/infrastructure`・`packages/coding-runner/test`・`packages/dots-mcp/test`・`scripts`） | 4,310件中4,295件通過。失敗15件: `requirements-toolchain.test.ts` 10件と `research-history.test.ts` 2件（会話履歴の担当 `history.research` が新規DBにない。`conversation-read-tools-design-2026-10-31.md` の R2 の範囲）、`toolchain.test.ts` 3件（TODO が作られない。別セッションの対話の作業中） |
| vitest（web・client） | 1,262件中1,261件通過。`background/models/evaluator.test.ts` は単独実行で通る負荷時の揺れ |
| 移行 | `capabilities/0010-retire-external-work` を利用者DBの複製に適用し、pointer が消えることを確認。全226件の既存マイグレーションの id・SQL・`after` は HEAD と一致 |

### 8.3 既存の問題

| 問題 | 状態 |
| --- | --- |
| verify の boundaries（`NotificationCenter.tsx` の timers→resources） | 解消（§8.1.1） |
| size-budget の予算外（10-27 以前から） | 記録し直して解消（§8.1.1） |

### 8.4 残り

| 項目 | 状態 |
| --- | --- |
| 会話履歴の担当（`history.research`）の退役 | 新規DBの seed からは外れている。既存DBの retire の migration、runtime の history 経路、`requirements-toolchain.test.ts`・`research-history.test.ts` の扱いは R2（別セッション） |
| `toolchain.test.ts` の3件、`routed-turn.test.ts` の format | 別セッションの作業中 |
| `tests/browser/settings-data-driven-p3.spec.ts` | 準備を書き換えた。Playwright がサーバーを起動する構成のため、利用者の許可を得てから実行する |
| `~/.codex/config.toml` の `[mcp_servers.eumenes-dots-mvp]`（407〜409行） | 利用者の手元で削除する |
| 設定ハブの各版の `navigateTo` に残る `external: "settings.external-work"` | 版の定義は変えられないため残した。pointer がなく launcher に出ないので選ばれない |
| `dormantBundleFile` の `@public` | 停止中の task-execution の fixture が使う。停止中の実装を残す決定（`docs/task-execution.md`）に従う |
