# Kanban × Claude Code 実装の分担と固定契約（2026-10-14）

設計の正本は [計画（改訂4）](kanban-claude-code-plan-2026-10-14.md)（以下「計画」）。本書は実装の分担と、担当間で共有する固定契約を定める。契約を変える必要があれば実装を止めて監督者に連絡する。

## 0. 固定契約ファイル（監督者が作成済み）

| ファイル | 内容 |
| --- | --- |
| `api/domains/terminals/contracts.ts`（後半の Work requests 節） | `SessionOwner`・`SessionMode`・`RequestTarget`・`RequestState`・`RequestReason`・`EnqueueRequest`・`TerminalRequestView`・`TerminalRequestFinished`・`ProjectResolver`、error code |
| `api/domains/kanban/contracts.ts` | カード・run・キュー・通知・ボードの型、`KanbanDispatch`、`WORK_ONLY_INSTRUCTION`、error code |
| `api/domains/capabilities/contracts/kanban.ts` | 操作の型付き入力（builtin キー `kanbanAdd`・`kanbanEdit`・`kanbanMove`・`kanbanCardRef`・`kanbanFollowup`・`kanbanList`・`kanbanNoticeRef`、登録済み） |
| `packages/design-system/src/components/KanbanBoard/types.ts` | `KanbanBoardProps` ほか |

## 1. 共通の約束

- 自分の担当範囲の外のファイルを変更しない。共有ファイル（下記）は監督者が編集する。必要な変更は報告に書く。
- 共有ファイル（触らない）: `api/application/{app-modules,server,toolchain,toolchain-adapters,toolchain-host,migrations,error-status}.ts`、`scripts/domains.ts`、`package.json`、`bun.lock`、`docs/domains.md`、`api/domains/capabilities/contracts/index.ts`、他 domain のファイル。別のセッション（memory steward）がこれらを編集中である。
- git の stash・checkout・reset・commit は禁止。
- 試験は自分の範囲の対象試験だけ（`bun test <file>`・`bunx vitest run <path>`・`bun run test:domain -- <name>`）。全体検証は監督者が最後に行う。
- コードのコメントは英語（周囲に合わせる）、利用者向け文言は日本語。既存の作法（`docs/toolchain-extension.md`、`.claude/skills/data-driven-toolchain/SKILL.md`）に従う。使わなくなったコードは残さない。
- 報告: 変更したファイル一覧、実行した試験と結果、監督者に頼む共有ファイルの変更（差分の形で）、未実施・未確認。

## 2. 画面と adapter の間の固定契約

### 2.1 ボードの source

- `adapter:kanban@1`、query `query:kanban.board@1`、source 名 `kanban`、データは `KanbanBoardView`（`api/domains/kanban/contracts.ts`）。
- OpenUI view `kanban-board`（`{view:"kanban-board", source, title}`）、Resource は `{ kind: "kanban-board", revision, board: KanbanBoardView }`。

### 2.2 画面の event（OpenUI `ArtifactEvent.action` と values）

values は `Record<string, string | boolean>`。数値は10進の文字列、`beforeCardId` の「列の末尾」は空文字。

| event action | values | 操作（adapter の operation） |
| --- | --- | --- |
| `kanban-add` | `title`、`prompt` | `kanban.add` |
| `kanban-edit` | `cardId`、`expectedRevision`、`title`?、`prompt`? | `kanban.edit` |
| `kanban-move` | `cardId`、`expectedRevision`、`column`（`todo`・`finished`）、`beforeCardId` | `kanban.move` |
| `kanban-remove` | `cardId`、`expectedRevision` | `kanban.remove` |
| `kanban-run` | 同上 | `kanban.run` |
| `kanban-followup` | 同上 + `note` | `kanban.followup` |
| `kanban-commit-push` | `cardId`、`expectedRevision` | `kanban.commit-push` |
| `kanban-review` | 同上 | `kanban.review` |
| `kanban-cancel` | 同上 | `kanban.cancel` |
| `kanban-stop` | 同上 | `kanban.stop` |
| `kanban-reset` | 同上 | `kanban.reset` |
| `kanban-resume-queue` | なし | `kanban.resume-queue` |
| `kanban-open` | `cardId` | navigate（`terminals.workspace`） |

- 書込みは bundle の actionBindings（`effect: write`）で受付台帳を通す。生入力の schema は bundle 内の `schema:kanban-*@1`（文字列）とし、型付き入力への変換は adapter の input adapter（`input:kanban.card@1` 等）で行う。
- P1 の bundle に入れる action は `kanban-add`・`kanban-edit`・`kanban-move`・`kanban-remove`・`kanban-open` だけ（他は P2b で adapter に操作を足してから同じ artifact revision に追加する。まだ配布していないので revision 1 のまま更新してよい）。

## 3. 分担（第1波・並行）

### W1 terminals の実行の土台（計画 P2a）

- 目的: 計画 §2.2・§3.3〜§3.5・§3.7・§3.9（起動設定の部分）・§3.11 の terminals 側を実装し、既存の会話からの直接依頼（`claude-code.request`）をその上に載せ替える。
- 最初に実機確認（計画 §5.2 の P2a）: 実 `claude` で `PostToolUse`・`Notification` の payload に `prompt_id` があるか、`SessionStart` の中身、`permissions.deny`（`Bash(git commit *)`・`Bash(git push *)`）で commit・push が止まるか（一時ディレクトリの git リポジトリ。`--settings` で trust 確認を避けられない場合は eumenes の中に一時ディレクトリを作らず、結果を「未確認」として報告）。結果を `spec/verification/claude-code-requests-2026-10-14/README.md` に記録。
- 公開 API（`createTerminals({ store, projects, hookBaseUrl, onChange, command, spawn, … })` の戻り値）:
  - `enqueueInTransaction(tx, req: EnqueueRequest): TerminalRequestView`（追跡不可 → `terminal_tracking_unavailable`、未登録 project → `terminal_project_unknown`、同じ id で中身が違う → `terminal_request_conflict`、同じなら保存済みを返す）
  - `cancelQueuedInTransaction(tx, attemptId): boolean`（`queued` のときだけ `cancelled（cancelled_by_person）`）
  - `requestInTransaction(tx, attemptId): TerminalRequestView | null`
  - `stop(attemptId): Promise<"stopped" | "unconfirmed">`（PTY に SIGTERM、5秒で SIGKILL、10秒以内に終了を確認したら `unknown（stopped_by_person）` を書いて終端の購読者を呼ぶ。確認できなければ何も書かず `unconfirmed`）
  - `onFinishedInTransaction(listener: (tx, event: TerminalRequestFinished) => void): () => void`（終端を書く writer transaction の中で呼ぶ）
  - `onWaitingInTransaction(listener: (tx, event: { attemptId: string; owner: SessionOwner }) => void): () => void`（許可待ちになったとき、request ごとに一度）
  - `activities(): Array<{ terminalSessionId; owner; mode; claudeSessionId?; status; activity }>`（ボードの表示用）
  - `trackable(): boolean`
  - `recover(): Promise<void>`（起動時: `queued` → `cancelled（restarted）`、`sending`・`delivered`・`started` → `unknown（restarted）`、終端の購読者を同じ transaction で呼ぶ）
  - 既存の `list`・`start`・`restart`・`input`・`resize`・`stream`・`verifyHook`・`hook`・`closeAll` は残す。メモリ上の `request()`・task tracker・`onTaskFinished` は削除する。
- 作業依頼表は migration `terminals/0001-requests`（`after: ["queue/0001-init"]`）。terminals の repository が `migrations` を export する（登録は監督者）。
- 送信器・PTY の持ち主と mode・`--session-id`／`--resume`・上限と解放・`prompt_id` による結び付け・`SessionStart` の10秒確認・変更ファイルの記録・`exclusiveGroup`・手入力の3秒待ち・保存失敗の一度の再試行は計画どおり。`mode: work` の設定ファイルに `permissions.deny` を入れる。
- 直接依頼の載せ替え: `api/application/terminals-adapter.ts` の `claude-code.request` を `enqueueInTransaction`（`owner: "direct"`、`target: current|new`、`mode: "work"`、`claudeSessionId` は `new` のとき terminals が採番）に変え、受領票を表から読む。**git の禁止（`permissions.deny`）を入れるのは `owner` が `kanban:` で始まり `mode: "work"` の PTY だけ**（直接依頼は利用者がその場で明示した作業なので制限しない）。会話への完了報告（`api/application/claude-code-reports.ts`）は `onFinishedInTransaction` で `origin: conversation` かつ `owner: direct` のものだけを commit 後に notice する（requestId は `terminal-request:{attemptId}:{state}`）。
- 書込み範囲: `api/domains/terminals/**`（contracts.ts の固定節は変えない。追加 export は可）、`api/application/terminals-adapter.ts`・`.test.ts`、`api/application/claude-code-reports.ts`・`.test.ts`、`api/application/claude-code-toolchain.test.ts`、`api/application/toolchain.fixture.ts`（terminals に関わる行だけ）、`scripts/claude-code-fixture-server.ts`、`tests/browser/claude-code.spec.ts`、`tests/browser/fixtures/fake-claude.sh`、`web/src/domains/terminals/**`、`packages/artifact-ui/src/terminal-components.tsx`、`packages/design-system/src/components/TerminalWorkspace/**`（持ち主の見出し）、`docs/terminals.md`、`spec/verification/claude-code-requests-2026-10-14/**`。
- 受入: 計画 §5.1 の「受付」「送信」「追跡」「開始・終了」「会話の復元」「変更ファイル」「commit 制限（起動設定）」の行のうち terminals 単体で検証できるものを domain 試験に、直接依頼の載せ替えを `claude-code-toolchain.test.ts` に、`tests/browser/claude-code.spec.ts` を新しい送信器で通す。`bun run verify -- --domain terminals` が通ること（共有ファイル未登録で落ちる部分は報告）。

### W2 kanban domain と adapter（計画 P1 の backend）

- 目的: kanban domain のカード（追加・編集・移動・削除・並べ替え・列・revision・プロジェクト id）、ボードの source、P1 の操作と bundle の artifact を実装する。
- 公開 API（`createKanban({ store, now?, id? })`）: `addInTransaction`・`editInTransaction`・`moveInTransaction`・`removeInTransaction`・`boardInTransaction(tx): KanbanBoardView`・`cardInTransaction`・受領票の `receiptInTransaction`（replay・再読込み用）。全変更操作は `expectedRevision`（`revision_conflict`）。カードの `actions` は domain が列・ラベルから決める（P1 は `edit`・`remove`・`run`（runnable が真のとき。P1 では表示だけで操作は未実装）・`open`）。
- migration `kanban/0001-cards`（`after: ["queue/0001-init"]`）: `kanban_cards`（計画 §2.1 の列。run 関連の列は P2b の migration で足す）、`kanban_receipts`。repository が `migrations` を export。
- adapter `api/application/kanban-adapter.ts`: `adapter:kanban@1`、query `query:kanban.board@1`、operations `kanban.add`・`kanban.edit`・`kanban.move`・`kanban.remove`（write、inputSchemaRef は builtin `kanbanAdd`・`kanbanEdit`・`kanbanMove`・`kanbanCardRef`）、input adapter（§2.2 の文字列 values → 型付き入力）、projection `projection:kanban.result@1`、結果 schema `domain:kanban.receipt@1`、availability `availability:kanban@1`。`describeKanbanAdapter` を export（監督者が `hostAdapterDescriptions` に登録）。
- bundle `api/domains/capabilities/bundles/kanban.bundle.json`: artifact `kanban.board@1`（title「タスクボード」、launcher「タスクボード」order 60、variant の definition `{view:"kanban-board", source:"kanban", title:"タスクボード"}`、sourceBindings、§2.2 の P1 の actionBindings、`schema:kanban-*@1`）。`bun run toolchain:bundle -- check` は監督者の登録後に通る（それまでは `unregistered_adapter` を報告）。
- 書込み範囲: `api/domains/kanban/**`（contracts.ts の型は変えない。追加は可）、`api/application/kanban-adapter.ts`・`.test.ts`、`api/domains/capabilities/bundles/kanban.bundle.json`。
- 受入: domain 試験（追加・編集・並べ替え `beforeCardId`・列移動・削除・`revision_conflict`・replay・`actions`）、adapter 試験（source・各操作・input adapter・拒否）。`bun run test:domain -- kanban`（domain 登録は監督者。未登録なら `bun test api/domains/kanban` で）。

### W3 画面（計画 P1 の front）

- 目的: DesignSystem `KanbanBoard`、OpenUI view `kanban-board`、Web adapter を実装する。
- DesignSystem `packages/design-system/src/components/KanbanBoard/`: `types.ts` の props どおり（変えない）。3列（未着手・実行中・Done・Blocker）、カード、カード詳細（依頼内容・最後の報告・変更ファイル）、追加フォーム、編集、キーボードでの移動（カードにフォーカス → 移動メニューで列と位置）、ドラッグは補助（ドロップ位置を `beforeCardId` に変換）、狭い幅で縦積み、キューの状態（停止中の理由と再開）、`runnable` が偽なら実行系を無効にして `notRunnableText`、commit & push の確認小窓（変更ファイル・最後の報告を表示し、了承で `onAction("commitPush")`）、追加で直すの入力（note）。既存トークンだけを使う。`index.ts`（部品）と `packages/design-system/src/index.ts` に export。Storybook（計画 §3.10 の状態一覧）と操作試験（vitest unit）。
- OpenUI: `packages/artifact-ui/src/kanban-components.tsx`、`contracts.ts` に view `kanban-board` の登録・`KanbanResource`・§2.2 の event action 名、`library.tsx` に renderer。描画 adapter は `KanbanBoardView` を props に写し、状態の文言（キュー待ち（n番目）・作業中・許可待ち・Blocker の理由）を作り、操作を §2.2 の event で送る。
- Web adapter `web/src/domains/kanban/`（`toolchain-adapter.tsx`・`index.ts`）: `adapterRef: "adapter:kanban@1"`、source を `client.toolchainArtifactSource` で読む（query root `kanban`、`web/src/queryKeys.ts` に root を追加し `changeRoots` に入れる）、書込みは共通 host の outbox（`effect: write`）、`settled` で読み直し、`revision_conflict` の文言。`web/src/workspace/toolchain-adapters.ts` に1行。
- 書込み範囲: `packages/design-system/src/components/KanbanBoard/**`（types.ts は変えない）、`packages/design-system/src/index.ts`（export 1行）、`packages/artifact-ui/src/kanban-components.tsx`・`contracts.ts`・`library.tsx`（kanban の部分だけ）、`web/src/domains/kanban/**`、`web/src/queryKeys.ts`（root 1つ）、`web/src/workspace/toolchain-adapters.ts`（1行）。
- 受入: DesignSystem の unit 試験・Storybook の実ブラウザ試験（`bunx vitest run --project storybook src/components/KanbanBoard`）、`bun run build:design-system`、artifact-ui の view を `ArtifactRenderer` で描く試験（fixture の snapshot）、Web adapter の試験。

## 4. 第2波（並行。第1波は統合済み）

第1波の結果（監督者が共有ファイルへ登録済み）:
- terminals: `createTerminals({ store, cwd, hookBaseUrl, onChange })`。`enqueueInTransaction`・`cancelQueuedInTransaction`・`requestInTransaction`・`stop`・`onFinishedInTransaction`・`onFinishedCommitted`・`onWaitingInTransaction`・`activities`・`trackable`・`recover`・`settled`（試験用）。`hook()` は async。migration `terminals/0001-requests` 登録済み。`terminals_recovery` lifecycle 登録済み。
- kanban: `createKanban({ store })`（`api/domains/kanban/service.ts`）、`adapter:kanban@1`（`createKanbanAdapter(kanban, { runnable })`）、migration `kanban/0001-cards`、bundle `kanban.bundle.json`（P1 の action）、画面（`KanbanBoard`・view `kanban-board`・Web adapter）。
- host: `api/application/toolchain-host.ts` が `terminals` と `kanban` を作り、`createToolchain` に渡す（toolchain の戻り値に `terminals`・`kanban`）。

### 4.1 通知 API の固定契約（W4 が実装、W5 が使う）

- `GET /api/kanban/notices?limit=<1..50>` → `{ notices: KanbanNoticeView[]; unread: number }`（新しい順）。
- `POST /api/kanban/notices/:id/read` → 204（既読化。存在しなければ `kanban_notice_not_found` 404）。
- 通知の文言は kanban domain が作る（`KanbanNoticeView.text`、計画 §3.12）。保存されると store の commit で変更通知が出る。
- Web の query root は `kanban`（`queryRoots.kanban`、変更通知で読み直す）。

### W4 ボードの実行（計画 P2b）

- 目的: 計画 §3.3・§3.6・§3.8・§3.9（起点の検証・本文）・§3.11 の kanban 側と、terminals との接続を実装する。
- kanban domain（`api/domains/kanban/**`）: migration `kanban/0002-runs`（`after: ["kanban/0001-cards"]`）で `kanban_runs`・キューの状態・カードの run 関連の列（`reason`・`claude_session_id`・`current_run_id`・`last_report`・`files`・`reviewed`・`commit_push_reported`）・`kanban_notices`。公開操作: `runInTransaction`（task。新しい `claude_session_id`）・`followupInTransaction`・`commitPushInTransaction`（origin が UI のときだけ。会話は `commit_push_requires_board`）・`reviewInTransaction`・`cancelInTransaction`・`resetInTransaction`・`resumeQueueInTransaction`・`finishRunInTransaction(tx, finished)`（`current_run_id` 一致のときだけ反映、通知を保存、キューを進める）・`markStopRequestedInTransaction`／止めた結果の反映・`pauseQueueInTransaction`・`noticesInTransaction`・`readNoticeInTransaction`・`recover`。各操作は「次に terminals へ渡す run」があれば `KanbanDispatch` を返す。本文の組み立て（`WORK_ONLY_INSTRUCTION` の付加、followup・commit_push の本文）、カードの `actions`、`followedByOtherRun` も domain。通知 API の controller（`registerKanban(app, kanban)`、§4.1）。
- application:
  - `api/application/kanban-adapter.ts`: operations `kanban.run`・`kanban.followup`・`kanban.commit-push`・`kanban.review`・`kanban.cancel`・`kanban.stop`・`kanban.reset`・`kanban.resume-queue`（input adapter も）。transaction の中で kanban の操作 → `KanbanDispatch` を `terminals.enqueueInTransaction`（`owner: "kanban:<cardId>"`、`exclusiveGroup: "kanban"`、`mode`、`target`、`claudeSessionId`、`projectId`）へ写す。`kanban.stop` は `terminals.stop(attemptId)` を待って結果を書く（`unconfirmed` → キュー `paused（stop_unconfirmed）`）。ボードの source に run と request の状態・PTY の activity・`runnable` を合成する。
  - 新規 `api/application/kanban-runs.ts`: `connectKanbanRuns(kanban, terminals)` — `terminals.onFinishedInTransaction` で `kanban.finishRunInTransaction` を呼び、返った次の `KanbanDispatch` を同じ transaction で `enqueueInTransaction`。`onWaitingInTransaction` で「許可待ち」の通知。`reason: tracking_lost` ではキューを `paused`。kanban の起動時回復（`recover`）。監督者が `toolchain-host.ts` で呼ぶ（呼出しの差分を報告）。
  - bundle `kanban.bundle.json`: §2.2 の残りの actionBindings（write）を `artifact:kanban.board@1` に追加（未配布なので revision 1 のまま）、必要な `schema:kanban-*@1`。
  - 試験用: `api/application/toolchain.fixture.ts` の kanban に関わる行（`kanban` を作って `createToolchain` に渡す、`connectKanbanRuns`）、`scripts/kanban-fixture-server.ts`（偽 `claude`。`tests/browser/fixtures/fake-claude.sh` を使ってよいが、変更は W1 の Claude Code 試験を壊さない範囲で）、`tests/browser/kanban.spec.ts`。
- 書込み範囲: `api/domains/kanban/**`、`api/application/kanban-adapter.ts`・`.test.ts`、`api/application/kanban-runs.ts`・`.test.ts`、`api/domains/capabilities/bundles/kanban.bundle.json`、`api/application/toolchain.fixture.ts`（kanban の行だけ）、`scripts/kanban-fixture-server.ts`、`tests/browser/kanban.spec.ts`、`tests/browser/fixtures/fake-claude.sh`（後方互換で）、`packages/artifact-ui/src/kanban-components.tsx`（状態の文言を合わせる必要がある場合だけ）、`spec/verification/kanban-board-2026-10-14/**`。
- 触らない: W5 の範囲（`client/**`、`web/src/components/domains/timers/**`、通知センター、`web/src/workspace/**`、`web/src/domains/terminals/**`）、terminals domain（変更が必要なら報告）、共有ファイル。
- 受入: 計画 §5.1 の「キュー」「カード」「commit 制限」「通知（保存）」「会話の復元（kanban 側）」の行を domain・adapter・`kanban-runs` の試験に。ブラウザ E2E（偽 `claude`）で 登録 → 実行 → キュー待ち → 作業中 → Done → 追加で直す → Done → commit & push（確認小窓）→ 報告あり、5件の連続実行、止めて Blocker にする、取消。`bun run verify -- --domain kanban`。

### W5 通知センター（計画 P2c）

- 目的: 計画 §3.12 の Web 側。通知センターをタイマーと Kanban の複数発信元に対応させ、Kanban 通知で SE を鳴らし、Kanban の PTY では activity の SE を鳴らさない。
- 作るもの:
  - `client/kanban.ts`（新規）: §4.1 の API。`client/index.ts` への登録は監督者（差分を報告）。
  - 通知センター: 現行の `web/src/components/domains/timers/TimerNotificationCenter.tsx` を複数発信元の通知センターへ作り替える（タイマーの通知と Kanban 通知を時刻順に一つのドロワーへ。タイマーは鳴動停止などの既存の操作を保つ、Kanban は「タスクボードを開く」「既読にする」）。部品の置き場所は既存の作法に合わせる（汎用の見た目は DesignSystem の `NotificationCard` を使う）。未読数をボタンに出す。
  - `web/src/domains/kanban/useKanbanNotices.ts`（新規）: 通知の取得（query root `kanban`）、新しい通知（読込み時点の既存は除く）で SE（`timerAudio.play`）を一度、ボードを開く（`openById("kanban.board")`）。
  - `web/src/domains/terminals/useClaudeCodeArtifacts.ts`: `owner` が `kanban:` の PTY では activity の SE を鳴らさない（`TerminalSessionView.owner` を使う）。
  - `web/src/workspace/useWorkspace.ts`（とそれが組み立てる通知センターの配線）: 上記の配線。
- 書込み範囲: `client/kanban.ts`、`web/src/components/domains/timers/**`（通知センターの部分）、`web/src/domains/kanban/useKanbanNotices.ts`・`.test.tsx`、`web/src/domains/terminals/useClaudeCodeArtifacts.ts`・`.test.tsx`、`web/src/workspace/**`（通知センターと上記の配線）、関連する Web の試験、`tests/browser/timers.spec.ts`（通知センターの表示が変わる場合の追従だけ）。
- 触らない: kanban・terminals の backend、`packages/**`、bundle、共有ファイル（`client/index.ts` は監督者）。
- 受入: 通知センターの試験（タイマーと Kanban が並ぶ、既読化、未読数、SE は新しい通知で一度、読込み時点では鳴らない、Kanban の PTY の activity では鳴らない）、`bunx vitest run` の対象、既存の `tests/browser/timers.spec.ts` が通ること。API は §4.1 どおりで、backend 未完成の間はモックで試験する。

## 5. 第3波以降

- W6 会話（P3）: profile・SKILL・tools・package・toolchain `kanban`・binding。W4 の後。
- 監督者: 共有ファイルの登録、全体検証、ブラウザ E2E、実機・自然言語受入（P4）、レビュー。
