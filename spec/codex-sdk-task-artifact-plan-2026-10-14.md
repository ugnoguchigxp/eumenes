# 共通 Kanban と Codex SDK ツールチェーンの実装計画

作成日・更新日: 2026-10-14、改訂2。状態: **計画・未実装**。対象 SDK は導入済みの `@openai/codex-sdk@0.160.0`。本書の登録名・API・テーブル名は追加予定であり、利用可能な機能を表すものではない。

一つの Kanban「タスクボード」で、カードごとに Claude Code または Codex を選んで開発作業を依頼する。キューは実行担当ごとに独立した二本とし、GUI で進行状況、活動イベント、結果と Blocker を確認する。画面とカード管理は共有し、サブエージェント・指示・会話・実行機構は分離する。将来の Grok は登録された実行担当を増やす形で接続できるようにする。

本改訂は、初版の「Codex 専用の一覧・Artifact・カード表」と Claude Code 計画の「ボード全体で一本のキュー」を置き換える。共通ボード・担当選択・キュー・移行の正本は本書、Claude Code の PTY・フックの詳細は [Claude Code 計画](kanban-claude-code-plan-2026-10-14.md) とする。SDK のイベント・停止・git 工程の要件は引き継ぐ。

## 1. 要件と設計上の前提

### 利用者から指定された範囲

- 実作業は Codex SDK へ依頼する。GUI から新規依頼、進捗確認、追加依頼を行える。
- Terminal と同様に、何が起きているか分かるアクティビティトレースを画面に出す。
- 通知、Blocker、git commit・push を扱う。
- Kanban UI は Claude Code と共有し、カードで実行担当を選べる。キューは Claude Code と Codex で別にする。
- サブエージェントは Claude Code 側と完全に分ける。将来の Grok も同じ分離で追加できるようにする。
- ファイルツリー、ファイル閲覧・編集、Diff ビューなどの IDE 機能は作らない。

### 本計画で採用する初期値

1. 入口は既存の「タスクボード」一件。3列（未着手／実行中／Done・Blocker）とカード詳細を共有し、実行担当の選択と担当別キューを追加する。「Codex タスク」という別のボードは作らない。
2. タスクごとに新しい Codex thread を作る。追加依頼はそのタスクの thread に限定する。SDK 内部の多重サブエージェント起動は初期版では無効とし、Eumenes 内の専門担当の分離とは区別する。
3. 対象は当初、ホストに登録された `eumenes` プロジェクト。任意のパスをモデルや画面から受け取らない。新しい branch/worktree は自動で作らない。
4. `claude-code` と `codex` のキューは各一件ずつ実行できる。一方の Blocker・停止で他方のキューを停止しない。ただし同一作業ディレクトリは別の排他制御で守り、競合時は「作業場所が使用中」と表示する。別の作業ディレクトリなら両担当を同時実行できる。
5. commit・push は共有カード詳細から、変更を作った実行担当へ依頼する別工程とする。共通の「commit して push」に加え、単独の commit/push はその担当が対応する場合だけ表示する。会話や通常の依頼文だけでは開始できない。
6. 通知センターと短い通知音を使う。タスク発の通知を会話へ自動挿入しない。会話から状態を尋ねた場合は保存済みの状態を答える。
7. Codex は TypeScript SDK のまま進める。実行中の対話的承認 UI は初期版に含めず、不足情報・権限不足は Blocker として終了し、回答や許可の更新後に新しい attempt で続ける。Claude Code の許可待ちは既存 Terminal へ案内する。

初期値は実装判断であり、利用者の追加指定で変更できる。特に SDK の権限制御と停止確認は §12 の事前確認を通すまで実装可能と断定しない。

## 2. 現状と再利用する接続

| 現状の根拠 | 今回の扱い |
| --- | --- |
| [SDK 接続](../api/domains/inference/adapters/codex-sdk.ts)、[調査担当](../api/domains/inference/adapters/codex-research.ts) | 現行は調査用。native tools、プロジェクト指示、履歴等を制限している。制限を緩めて開発に転用しない |
| [調査用 launcher](../api/domains/inference/adapters/codex-launcher.ts) | process group の終了などを参照する。ただし `--ephemeral`、調査用の出力量・再試行規則を開発担当に持ち込まない |
| [登録手順](../docs/toolchain-extension.md)、[検証手順](../docs/toolchain-extension-verification.md) | bundle、DomainAdapter、Web adapter、公開 revision、共通受付台帳を使う |
| [Timer adapter](../api/application/timer-adapter.ts)、[Web adapter](../web/src/domains/timers/toolchain-adapter.tsx) | transaction 内で受け付け、receipt を返し、source を再取得する接続例 |
| [通知センター](../web/src/components/domains/timers/TimerNotificationCenter.tsx) | 現状はタイマー専用。Claude Code 計画の複数発信元対応と一つの変更として調整する |
| [Claude Code 計画](kanban-claude-code-plan-2026-10-14.md)、[Kanban 契約](../api/domains/kanban/contracts.ts) | 一部実装が進行中。カード・run・通知・既存 KanbanBoard を共有の正本として拡張する。Claude session と Codex thread は統合しない |
| [Queue runner](../api/domains/queue/service/runner.ts) | lease と再実行の仕組みを持つ。副作用を伴う SDK 呼出しをそのまま再試行させない |

既存の指示だけでは、開発権限、持続する SDK thread、イベント蓄積を満たせないため、新しい `codex-tasks` domain と SDK runner が必要。ただしカード管理は kanban に残す。二つの実行機構を接続する最小の登録 port を application に置き、任意コードを実行する plugin framework や別の Artifact ホストは追加しない。

### 確認した SDK の契約

- 公式資料は TypeScript SDK の `startThread`、継続実行、`resumeThread` と server-side 利用を説明している。対話的承認等を扱う独自クライアントには App Server が案内されている。[公式 SDK 文書](https://learn.chatgpt.com/docs/codex-sdk)
- 導入済み `node_modules/@openai/codex-sdk/dist/index.d.ts` で、`runStreamed`、`AbortSignal`、`outputSchema`、`thread.started`、`turn.*`、`item.*`、`error` を確認した。`turn.started/completed` に turn ID はなく、承認要求へ応答する callback も型にない。App Server のイベントを SDK の型として扱わない。
- SDK は `approvalPolicy` を指定できるが、それだけで対話的承認の GUI を実装できるとはしない。初期版は `never` と事前に制限された sandbox を組み合わせる。これは権限を無制限にする指定ではない。
- 標準の `workspace-write` は `.git` と、pointer が指す Git directory も read-only とする。通常の作業と commit の権限を分ける根拠とする。[公式の保護パス仕様](https://learn.chatgpt.com/docs/agent-approvals-security#protected-paths-in-writable-roots)

資料の仕様とローカル CLI の動作は別に確認する。SDK・CLI の組合せ、Bun での実行、sandbox の実効権限は P0 の受入対象。

## 3. サブエージェントの分離と登録

### 担当を二つの役割に分ける

**依頼受付担当**は Eumenes の command 経路で動き、依頼の意味、対象カード、必要な確認を判断する。Codex 用の専用 profile/skill/package を登録し、その操作は共通 Kanban に Codex カード/run を作る。Claude Code の実行 tool・調査 tool は渡さない。ボードの整理・閲覧は既存 kanban 担当が行えるが、実行用指示や session は共有しない。受付成功を作業完了と答えない。

**開発実行担当**は受付済みの一件を Codex SDK で実行する。タスクごとの thread と凍結した実行指示を持つ。受付担当の会話全体や別タスクの報告を流し込まず、必要な元依頼・回答・作業条件だけを渡す。既存 `lockedCodex`、調査の空応答リトライ、調査用 report schema を使わない。

| 登録対象 | 追加予定の ID |
| --- | --- |
| bundle | `codex-tasks.bundle.json` / `bundleId: codex-tasks` |
| 受付担当 | `profile:codex-tasks.manage@1`、`skill:codex-tasks.manage@1` |
| 受付 package・toolchain | `package:codex-tasks.manage@1`、`toolchain:codex-tasks.manage@1`、公開関数 `codex_tasks` |
| binding・adapter | `binding:codex-tasks.manage@1`、`adapter:codex-tasks@1`。会話用 adapter は application で kanban の公開操作へ接続し、executorId を Codex に固定する |
| 開発担当の指示 | `profile:codex-tasks.worker@1`、`skill:codex-tasks.worker@1`。runner が正確な revision 本文を読み、attempt に凍結する |
| Artifact | 共通 `artifact:kanban.board@2`、title/launcher「タスクボード」。Codex toolchain もこれを参照する。既存 revision は書き換えない |
| 共通 source query | `query:kanban.board@2`、`query:kanban.detail@2`、`query:kanban.activity@1`、`query:kanban.executors@1`。application が選択された run の実行担当から取得する |
| 可用性・結果 | `availability:codex-tasks@1`、`domain:codex-tasks.receipt@1`、`projection:codex-tasks.result@1` |

会話用 tool は request/list/inspect/followup/answer/cancel/stop の各 `tool:codex-tasks.<操作>@1`。commit・push、権限の更新、実行不明からの復旧は UI 専用 operation とし、package の tool 一覧に含めない。worker の指示は受付 package の required skill に混ぜず、専用設定の revision 参照から解決する。モデル・reasoning effort は開発担当専用設定を使い、調査担当のモデルを固定流用しない。

既存の bundle と同じく package は command 実行契約を使う。開発作業を research backend に登録しない。共通 Artifact は kanban bundle が一度だけ定義し、Codex bundle はその revision を pin 参照する。可用性は担当ごとに返し、Codex 不在でも共通ボード・Claude Code・保存済み履歴は使える。利用不能な担当へ自動で切り替えない。

### 実行担当の登録と Grok の追加境界

application の登録表で `executorId` → 実行 port を結ぶ。初期登録は `claude-code` と `codex`。`executorId` は登録済み ID を検証する文字列で、DB・共通 UI を二値 enum に固定しない。任意の ID/URL/実行コードを入力できる意味ではない。

| 登録する内容 | 契約 |
| --- | --- |
| 識別・表示 | executorId、表示名、adapter revision、担当専用 package/worker 指示 revision、availability と理由 |
| 機能 | task/followup/answer/stop、commit/push/commit-push、activity、Terminal への移動の対応可否。登録された機能だけを UI と schema に公開 |
| 受付・照会 | `enqueueInTransaction`、`cancelQueuedInTransaction`、`readInTransaction`。共通 runId を ownerRef として固定し、同 run の再受付は replay |
| 実行制御 | commit 後の起動、stop、recover、停止確認、sessionRef の新規作成/再開。具体的な SDK・PTY 操作は各 domain |
| 結果・活動 | runId、executorId、attemptId、epoch、outcome、停止確認、reportRef、activity cursor。実行担当を含めて採用先を検証 |

sessionRef は実行担当が所有する不透明な参照。共通側は Claude sessionId / Codex threadId を相互変換しない。登録 port は既存の DomainAdapter と同じものではなく、application 内の型付き接続であり、モデルに任意の runner 起動権を渡さない。

Grok を追加するときは、その時点の公式仕様で実行方式・イベント・取消・認証・継続を確認し、専用担当、実行 domain/adapter、登録一件、bundle を追加する。初期版に架空の Grok SDK や動かない選択肢は入れない。契約を満たすテスト用第三担当で、UI に Grok 専用分岐を足さずキュー・状態を表示できることを先に確認する。

### 指示の最小契約

| 層 | 配置する内容 |
| --- | --- |
| 受付 profile/skill | Codex への依頼受付という責任、対象の確認、元依頼の保存、公開操作を一度選んで受付結果を返すこと |
| worker profile/skill | 依頼範囲の実装と検証、プロジェクト指示の確認、外部資料・コマンド出力を権限付与として扱わないこと、完了・Blocker の根拠を報告すること |
| task context | cardId/runId/attemptId、executorId、元依頼、今回の追加依頼、対象 project/workspace、明示的な回答、実行 mode、許可された範囲 |
| tool/schema | 対象 ID、revision、各操作の前提、結果 schema |
| host | origin、scope、冪等性、sandbox、実行排他、取消、期限、commit/push の許可、イベント容量 |

worker の共通指示案:

> 渡されたタスクと今回の追加依頼を、登録された作業ディレクトリで実行する。最初にプロジェクトの作業指示と既存状態を確認し、範囲外の変更を含めない。通常作業では commit と push を行わず、別工程として利用者へ返す。必要な情報や権限が不足したら、何が必要かを示して blocked で終了する。失敗した操作を成功として報告しない。実装内容、実行した検証と結果、未確認事項を最終 schema に従って返す。追加の専門担当や別の Claude/Codex 会話を起動・操作しない。

実行 mode の権限は指示文で付与せず、ホストで確定する。語句を正規表現で分類して担当や Blocker を選ばない。

## 4. GUI と操作

画面は既存の3列 Kanban を使う。上部に Claude Code / Codex のキュー状況を並べ、カードを選ぶと共通の詳細を開く。担当フィルターは表示だけを絞り、列や保存先を分けない。狭い画面では列を縦に積み、詳細へ切り替える。

- カード: タイトル、実行担当のラベル、未着手／順番待ち／実行中／停止確認中／Done／Blocker、更新時刻、未読の印。Done は「作業報告あり・人の確認前」であり、commit 済みとは区別する。
- 追加・編集: 実行担当を選択する。新規カードの既定は利用者が最後に選んだ利用可能な担当（初回は Claude Code）、既存カードは保存済み担当。現在の選択を常に表示し、担当が利用不能なら変更を促す。会話で明示された担当は LLM がそのまま選び、未指定なら既定を使ったことを返す。失敗時の自動 fallback はしない。
- 詳細上部: 依頼内容、対象プロジェクト、現在の作業、開始からの時間、最終イベント受信時刻、接続状態。未取得の進捗率・残り時間は作らない。
- アクティビティ: 共通の実行履歴から担当と run を選ぶ。Codex は SDK イベント、Claude Code は既存フックで確実に取得できる状態・活動を表示し、詳細な対話・出力は「Terminal を開く」へ接続する。PTY の文字列を SDK イベントに見立てて解析しない。どちらも開始・取消・停止・復旧は共通形式で表示する。
- 結果: 要約、検証、未確認事項、Blocker の理由・質問。変更ファイルは件数とパスのテキストだけで、ファイルを開く操作や Diff 表示は持たない。
- 操作: 追加、編集、並べ替え、列移動、実行、担当変更、追加依頼、Blocker への回答、取消、止めて Blocker にする、確認済み、対応する git 操作、削除。カードは未着手で保存でき、「追加して実行」では作成と run 受付を一つの transaction にする。別のアーカイブ機構は足さない。
- 実行中の追加入力は、その場で SDK に割り込ませない。画面の下書きに保ち、完了後に送るか、停止確認後に新しい attempt として送る。
- Blocker は原因ごとの次の操作を示す。自由文で回答できる場合は入力欄を出し、権限や認証の問題は設定先を案内する。押しても進まない「再試行」だけの画面にしない。

### DesignSystem と OpenUI

既存のリスト、フォーム、Drawer、状態表示を組み合わせる。継続イベントの折畳み・追従停止・更新中の同一項目表示には再利用可能な `ActivityTimeline` を追加し、OpenUI の `activity-timeline` として登録する。タスク固有の API を部品に持たせない。

既存 `KanbanBoard` の props/events を `executors[]`、カードの `executorId`、`queues[]`、担当選択、機能に応じた操作で拡張する。専用 `TaskWorkspace` は作らない。Artifact は `kanban-board` と `activity-timeline` 等を `layout` で組み合わせた JSON を保存する。source は共通 Kanban adapter がホストの登録表を使って解決し、UI に `if Claude / else Codex` の実行分岐を散らさない。新しい Artifact kind、専用 render callback、任意 API URL は追加しない。

### 担当変更と会話継続

- 実行履歴のない未着手カードは `expectedRevision` 付きで担当を変更できる。
- queued/実行中/停止未確認の担当は変更できない。queued は取消を確定してから変更し、実行中は停止確認が必要。
- 実行済みカードは「担当を変えて新しく実行」で新しい run と新しい session を作る。渡すものは元依頼と利用者が確認した引継ぎ要約だけ。別担当の全会話、ツール状態、秘密、git 許可は移さない。既存ファイルの変更は残るので、作業場所と変更混在の注意を確認画面に示す。
- followup/answer/git は選択中の担当ではなく、対象の元 run に保存された executorId/sessionRef/workspaceRef を使う。担当変更後は古い run の報告を履歴として残し、新しい currentRun を古いイベントで上書きしない。旧 run の git 操作を現在のカードから誤って開始できないよう、元 run と最新状態を検証する。
- 同じカードでは担当が違っても同時に一つの run だけを有効にする。二つのキューへ同じカードを同時投入しない。

Storybook とブラウザ受入では空・待ち・実行・長い出力・Blocker・停止未確認・再接続・競合・commit 成功/push 失敗を確認する。キーボード、狭幅、色に依存しない状態表示、イベント追加で読み位置を奪わない動作を含める。

## 5. 永続状態と実行契約

`kanban` がカード、共通 run、担当別キュー、結果採用、通知を所有する。`codex-tasks` は SDK attempt/thread/event と権限の実行を所有し、`terminals` は Claude の request/session を所有する。下位 domain は kanban/dialogue や他の実行担当を import せず、kanban も SDK/PTY を直接扱わない。application が公開操作と注入 port で組み立て、複数 domain の保存を同一 writer transaction で行う。

| 保存対象 | 主な内容 |
| --- | --- |
| `kanban_cards`（拡張） | カードの唯一の正本。scope、cardId、projectId、executorId、title、依頼、revision、currentRunId、列、確認済み。Codex 専用カード表は作らない |
| `kanban_runs`（拡張） | runId、cardId、executorId、executor revision、workspaceRef、sessionRef、kind、凍結入力、状態、実行担当側の attemptRef、結果参照。過去 run の担当は不変 |
| `kanban_queues`（追加/拡張） | scope と executorId ごとの順番・paused/revision・理由・activeRun。初期二行で各 concurrency=1 |
| `codex_task_attempts` | attemptId（共通 runId と1対1）、requestId、ownerRef=cardId、kind、凍結入力・指示revision・設定、状態、runnerEpoch、threadId、開始/終了、期限、結果、停止確認 |
| `codex_task_events` | attemptId、単調増加 seq、SDK itemId、eventType、発生/受信時刻、検証・編集済み payload、切詰め情報 |
| Kanban 通知（拡張） | noticeId、scope、cardId、runId、executorId、kind、未読、音の claim/ack。Codex 用の重複通知表は作らない |
| `codex_task_grants` | UI 受付に結び付いた一回分の Codex git/権限許可。cardId・元runId・executorId・workspaceRef、対象・有効期限・使用先 attempt、失効理由 |

runner の進行とタスク revision を分ける。ログ一行の追加で確認画面の `expectedRevision` が毎回競合しないよう、イベントには seq、タスク操作には revision を用いる。変更操作は共通受付台帳の requestId/eventId と `expectedRevision` で保護する。最初の作成は新規 ID と requestId、一覧の順序等を変える場合は一覧 revision も使う。

### 受付から結果採用まで

1. 認証済み UI/会話操作を共通台帳で受け、同一 writer transaction で card、共通 run、担当別キュー位置、receipt を保存する。SDK/PTY を transaction 内で呼ばない。
2. Kanban scheduler が各担当キューの先頭を独立に選び、空き枠・期限・権限・workspace guard を確認する。予約と実行担当の `enqueueInTransaction` を同じ transaction で行う。Codex は対応する attempt を一件だけ保存する。`store.onCommit` が各送信器を起こし、Codex は `queued → starting` と runnerEpoch を保存してから `runStreamed` を一度呼ぶ。
3. iterator は生成時の `{attemptId, runnerEpoch}` を closure に固定する。受信時の「現在の task」では対応付けない。`thread.started` の ID を保存し、継続時には保存済み ID と照合する。
4. イベントを検証して seq 順に保存し、実行の表示 projection を更新する。`turn.completed` は最終報告の候補とする。stream の正常終端、実行プロセスの終了、報告 schema を確認するまで Done にしない。
5. SDK attempt の終了・最終報告と、購読先の kanban による run/currentRun の採用・通知を同一 writer transaction で確定する。実行担当の成功だけ保存してボード更新を失わない。commit 後に画面へ変更通知を送り、その担当の次の run を評価する。

同一 requestId の再送は既存 receipt を返す。新しい attempt は明示的な再依頼だけで作る。「SDK が一度だけ副作用を実行する」保証はしない。送信と DB 保存の境界で結果不明になった場合は自動再送を禁止し、照合・人の確認へ進む。

### 状態遷移

次の表は Codex attempt の状態であり、Claude request の既存状態を置き換えない。各実行 adapter が検証済みの結果を共通 run の Done/Blocker と停止確認へ写す。Claude の `Stop` による完了と Codex の構造化最終報告という観測の違いは、詳細に残す。

| 状態 | 遷移と扱い |
| --- | --- |
| `queued` | 受付済み。`starting` または `cancelled`。期限切れは Blocker として終了 |
| `starting` | SDK 起動を試みた。開始を確認すると `running`。起動前失敗を確証できれば `failed`、それ以外は `unknown` |
| `running` | イベント取得中。正常終了候補は `settling`。停止要求は `stopping` |
| `settling` | 終了・報告・保存を確認中。`succeeded` / `blocked` / `failed`。確認不能は `unknown` |
| `stopping` | abort と process group の終了を待つ。停止確認後は `cancelled` または `blocked`。未確認なら `unknown` かつ排他保持 |
| 終端 | `succeeded` / `blocked` / `failed` / `cancelled` / `unknown`。同 attempt を再実行しない |

タスク表示は succeeded を Done、それ以外の終端を理由付き Blocker にする。終端済み attempt の遅延イベントは現行タスクを変更しない。重複終端は expectedState と attemptId/epoch の検査で無害化する。

`unknown` は原因を問わず該当 executor のキューを停止する。停止確認済みかどうかを別に保持し、人が結果を照合して再開するまでその担当の次の起動を行わない。終端イベントを受けても生存プロセスが残る場合は排他を解放しない。他担当のキューは停止せず、同じ workspace が必要なら待機、別 workspace なら進める。

### 担当別キューと再試行の境界

- 共通 Kanban が順序を持つ。キューキーは `(scope, executorId)`。初期は Claude Code 一本と Codex 一本で各一件実行、将来の登録担当にも同じ形で一本を追加する。プロジェクトごとに暗黙に実行枠を増やさない。
- 受付時に executorId と workspaceRef を run に凍結する。未送信 run の順序変更は対象キューの revision を検証する。担当間で待機中 run を自動移送しない。
- 一方が waiting/paused/利用不能でも他方を評価する。一方の dispatcher の処理待ちで他方の起動を塞がない。各キュー内は FIFO とし、先頭が workspace 待ちならその理由を表示する。
- 異なるキューが同じ workspace を待つ場合は、利用可能なキューの先頭同士で受付順に予約する。一方の完了時に自分の次 run を無条件に先取りせず、飢餓を防ぐ。paused のキューは予約候補にしない。
- 二本のキューと同時書込みの許可は別物。当初両方が同じ eumenes cwd に解決される場合、受付・順序・停止は独立だが実行は排他となる。実際に二件を並行して動かすには、ホスト設定で別の作業コピーを割り当てる（§8）。

SDK 起動は `codex_task_attempts` を outbox とする専用の小さい dispatcher が担う。これは Kanban から渡された一件の配送台帳であり、カードの優先順位を持つ第三のキューではない。共通 Queue の lease 回復で SDK 起動を再実行させない。専用部分の根拠は、SDK のタスク起動にホスト requestId による冪等性・起動成否照会の契約がなく、編集や git 操作の二重実行を取り消せないこと。

SDK 呼出しの再試行はゼロ。DB 保存の一時失敗だけは、同じイベント seq/終端キーを固定して有限回再試行できる。メモリの未保存バッファ上限到達時はプロセスを止め、状態不明とキュー停止を表示する。黙ってイベントを捨てて実行を継続しない。

## 6. 活動イベントの表示と保存

次の表は Codex adapter の SDK イベント変換を定義する。共有 UI の envelope は `{executorId, runId, attemptId, seq, occurredAt, kind, status, summary, detailsRef?}` とし、Claude Code や将来の担当は取得できた活動だけを同じ形へ写す。入力・許可の回答はこの表示 envelope から任意 API を呼ばず、登録済み action へ戻す。共通 cursor は対象 executor/run を固定して検証し、担当をまたいだ seq の衝突を防ぐ。

| SDK/host イベント | 表示 |
| --- | --- |
| `thread.started`、`turn.started` | 作業開始・続きの開始 |
| `agent_message` | 作業の説明・最終報告。schema 出力は結果欄へ整形 |
| `reasoning` | SDK が公開した要約だけを折り畳み表示。非公開の内部思考を要求・推定しない |
| `command_execution` | コマンド、状態、出力、終了コード。任意コマンドを入力・実行する UI にはしない |
| `file_change` | 変更したパス、追加/更新/削除、適用結果。Diff 本文やファイル内容を取得しない |
| `todo_list` | SDK が報告した手順と完了状態。タスク自体の成功判定には使わない |
| `web_search`、`mcp_tool_call` | 許可した機能だけ。検索・ツール名・成功/失敗と安全な要約。引数・戻り値を無条件に公開しない |
| item の error、`turn.failed`、`error` | 警告・失敗。途中の一コマンド失敗だけでタスク全体を失敗にしない |
| host | 受付、順番待ち、停止要求、停止確認、権限変更、再起動、切詰め、接続断 |

`item.started/updated/completed` は `(attemptId,itemId)` の同じ活動行を更新する。`aggregated_output` は差分とみなして追記せず、snapshot として置換する。裏側のイベント seq は履歴・再接続用に残す。未知 event は「未対応イベント」として種類を記録し、未知 payload をそのままブラウザに出さない。終端契約が解釈できない場合は成功判定せず Blocker。

配信は既存 changes 通知で更新を知らせ、認証済み events source を `afterSeq`/cursor で取得する。初回 snapshot と highWaterSeq を同じ read transaction で返し、その後のイベントを取得する。再接続・通知欠落時も cursor で補完できる。UI が閉じても実行と保存は続く。通知音は画面のイベント再生とは連動させない。

暫定容量: 1イベントの表示本文 16 KiB、1 attempt の保存イベント 10 MiB、1ページ100件、取得応答256 KiB、表示中は直近500項目まで。上限では出力本文の間引き・切詰めを明示し、開始・終端・Blocker・git 結果は別枠で残す。SDK 入力の異常な1行を含む parser 上限は P0 で確認し、必要な transport guard を launcher 側に置く。完了 attempt の詳細イベントは30日、要約・通知・receipt は90日を初期値とし、非終端・未解決 unknown は自動削除しない。

活動本文は通常の JSONL ログではなく、所有 scope 付き業務データとして保存する。既知の認証値・環境変数値を除去し、HTML/ANSI はテキストとして安全に表示する。秘密検出の完全性は保証できないため、秘密ファイルや credential を最初から実行権限・出力対象に含めない。通常ログには相関 ID、eventType、サイズ、結果 code だけを記録する。

## 7. Done、Blocker、回答と停止

最終結果は SDK の `outputSchema` で、`outcome: done | blocked`、`summary`、`changes[]`、`checks[]`（実施内容・結果・根拠）、`remaining[]`、`blocker`（理由と必要な回答）、`gitResult`（必要な mode のみ）を要求する。厳密な schema と実データの容量上限は domain に置く。実行開始前に schema の対応を検証する。

意味上の完了・質問・不足は LLM がこの構造で返す。ホストは transport 完了、schema、有効な attempt、停止・権限・期限の状態を検査する。報告不正・途中終了は Blocker とし、同じ作業を「JSON 修復」のために再実行しない。`turn.completed` だけで Done にしない。

Blocker の機械的理由には `auth_required`、`permission_required`、`sdk_failed`、`invalid_report`、`event_persistence_failed`、`timeout`、`stopped_by_person`、`resume_failed`、`outcome_unknown` を持つ。SDK が構造的な理由を出さないエラーを、文言の推測で認証・権限に分類しない。未分類の安全な説明を表示する。

- 情報不足: cardId/runId/attemptId/revision と回答を保存し、同 thread の新 attempt を作る。古い質問への回答は拒否する。
- 権限不足: 必要範囲を表示し、設定・許可の UI 操作後に実行。自由文の回答を権限付与に変換しない。
- 手動停止: まず `stopping` を保存し AbortSignal を送る。5秒後も生存なら管理対象 process group を終了させる。10秒で停止確認できなければ `unknown` としてキューを停止し、排他を保持する。
- 長時間無イベント: 最終受信時刻と「更新がありません」を表示する。経過時間だけで成功・Blocker・再実行にしない。attempt の総期限は初期60分、到達時は同じ停止手順に入る。
- 追加依頼: 同じ threadId を `resumeThread` で使う。thread の復元不能時は Blocker とし、勝手に別 thread で続きを実行しない。「新しいタスクとして依頼し直す」で、要約と元依頼を確認して新規作成できる。

SDK の AbortSignal は process tree 全体の停止証明ではない。専用 launcher は attempt/epoch、process group、終了通知をホストへ返し、backend 消失時にも子プロセスを終了できる監視を持つ。PID 単独で復旧時に kill しない。OS 上の実行主体・生成時刻・nonce 等との照合を P0 で確立する。停止を確認できない構成ではリリースしない。

## 8. 実行環境、再起動と他担当との排他

新しい開発用 SDK adapter は `codex-tasks` 内に置く。認証は backend の承認済み Codex 実行環境を利用し、キーを task、Artifact、ログへ複製しない。実行に必要な環境だけを渡し、プロジェクト指示は読めるようにする。ユーザーの全 plugin/MCP/別 chat 操作を自動継承しない。既存の調査用 launcher の ephemeral 設定は使わず、thread の再開に必要な保存を保持する。

通常作業は `workspace-write`、実行先のネットワークアクセスは初期無効、許可の自動拡大なし。モデルとの通信と作業コマンドのネットワーク権限を区別する。依存取得などの追加権限は GUI で範囲を確認して別 attempt に渡す。非公開設定、LARM credential、Eumenes の製品 DB を子プロセスへ公開しないための deny/read 範囲を P0 で点検する。

### 作業場所の割当と排他

ホストの project 登録に担当ごとの `workspaceRef` を持たせる。初期の両担当は既存 eumenes の作業場所を利用できるが、二本を並行実行する場合は利用者が用意・指定した別の作業コピーへ割り当てる。初期版はこの設定と解決を実装し、自動 clone/branch/worktree 作成や merge は追加しない。別の作業コピーへ、未コミット変更や秘密を自動コピーしない。

run の workspaceRef と実体パスは受付時に固定する。設定変更で過去 run の followup/git の送り先を変えない。割当先が利用不能なら Blocker。別 cwd の worktree が同じ Git common directory を共有する場合は、refs/index 等に作用する git 工程に common directory の排他も追加する。複数ロックは固定順で一括予約し、片方だけ保持して待たない。

application の小さい workspace execution guard を共通化する。key はホストが解決した作業ディレクトリの実体パス。保存するのは所有 domain/attempt、epoch、状態だけであり、担当や prompt は共有しない。

- Codex 起動と Claude Code の起動・自動依頼・手入力受付が guard を参照する。確認と予約は同じ writer transaction で行う。
- 同じ cwd の Claude PTY が生きている間は guard を保持する。Kanban 所有の idle PTY は、後続の他担当が待っていれば自動で閉じ、終了を確認してから解放する（会話は保存済みなので後で resume できる）。idle を確認できない PTY は閉じない。direct 所有の PTY は自動で閉じず、画面で終了を案内する。Codex が guard を持つ間、その cwd の Claude PTY 起動を拒否する。
- guard は終了確認後にのみ解放する。unknown の lease 時間切れだけでは解放しない。別 cwd の実行や通知閲覧を止めない。
- 外部 Terminal やエディタの手作業まで排他できるとはしない。git 操作時には作業状態を再照合する。Claude/Codex の会話・実行機構を統合せず、共有する業務モデルはカード・run・キュー・通知に限る。

### backend の再起動

backend 全体の再起動では各担当キューを回復待ちにし、それぞれの回復結果を保存する。一方の runner だけの再起動・障害はその担当だけを止める。Kanban から未配送の run は順序を保持し、期限切れだけ終端にする。Codex の未起動 queued は保持し、starting/running/settling/stopping は結果不明として記録して管理プロセスの生存・停止を照合する。Claude の配送済み request は Claude 計画の recover 契約を使う。前 epoch のイベントを新 attempt に採用せず、停止未確認の guard は保持する。

threadId が残っていても、最後の操作が成功したと推定しない。保存済みイベントと git 等の読み取りで状況を表示し、人が確認後に対象 executorId と queueRevision を指定してキューを再開する。再開で古い attempt は送り直さない。Done の thread は通常どおり resume できる。メモリに残る SDK client 数をセッション数の上限にせず、実行終了後に解放する。

## 9. commit と push

確認と依頼の入口は共通 Kanban。対象は currentRun の実行担当と作業場所へ固定する。以下の SDK 実行・二工程の詳細は Codex に適用し、Claude Code は既存の mode/PTY 契約を維持する。初期の対応機能は Codex が commit/push/commit-push、Claude Code が commit-push。機能差は登録表で表し、Claude の単独 commit/push を未実装のままボタン表示しない。各担当の git 報告と検証済み結果は区別して表示する。

### UI と受付の契約

commit/push の確認画面には対象タスク、branch、HEAD、対象ファイル名と件数、commit メッセージ案、push 先 remote/branch、送信対象 commit を表示する。ファイル内容・Diff は表示しない。これらの値は backend の読み取りで取得し、モデルの自己申告を正本にしない。

確定操作は `origin.kind === ui`、共通 `kanban.board` の登録 actionBinding、scope、card revision、元 run、最新の git 状態指紋を検査する。一回の許可は `{cardId, sourceRunId, executorId, workspaceRef, mode, head, paths, remote?, branch?, expiresAt}` と状態指紋に結び付け、attempt へ消費する。担当変更・確認から実行までの状態変更で失効させる。会話から同じ operation を直接呼んでも拒否する。

### 通常作業と git 工程の分離

- 通常作業は保護された `.git` とネットワーク制限により commit/push の権限を持たせない。依頼文に「そのまま push」等が含まれても変更と報告までとする。
- commit は専用 mode の SDK attempt。対象 Git metadata への書込みを必要最小限だけ許す。push は別の mode と許可された remote を対象とする。モデルの意味判断と作業は SDK が担う。
- git 工程も対象 task の thread を再開するが、mode と実効権限は毎回ホストが明示する。git 工程後の followup は必ず通常作業の制限へ戻し、前回の許可を継承しない。
- `danger-full-access` へ暗黙に切り替えて解決しない。選択した SDK/CLI で必要な Git metadata の許可と他パスの保護を両立できるか P0 で実証する。実証不能ならこの工程は未完了として止め、明示的な設計変更を行う。
- Git hooks、credential helper、署名の対話要求で止まった場合も Blocker。GUI の自由入力を隠れた端末へ送信しない。hooks の無効化、force push、reset、clean、自動 branch 作成は行わない。

### 変更の帰属と部分成功

task 開始時と終了時に HEAD、index、working tree の状態を読み取り、差分の指紋を保存する。`file_change` は参考記録であり、shell 経由の変更を網羅する台帳とはしない。元から dirty、別タスクの変更が混在、作業後に他者の変更があった、同一ファイル内で帰属が不明な場合は自動選別して commit しない。Blocker とし、外部で整理してから確認をやり直す。初期版は無関係な staged 変更がある場合も拒否する。

SDK の git 報告は、ホストの読み取りによる commit SHA、親 HEAD、対象パス、branch と照合する。push は指定 remote/ref を照会し、対象 SHA の反映を確認して初めて「push 済み」と表示する。ネットワーク断等で照会不能なら「結果未確認」で、push を自動再送しない。

「commit して push」は commit と push の二つの attempt として進め、UI 許可をその順序・対象に限定する。commit が検証できた時だけ push を開始する。commit 成功/push 失敗では SHA と成功した工程を保存し、再依頼は push だけにする。追加修正が入れば既存 git 許可は失効する。

この二工程は一つの操作グループとして当該担当のキュー枠と workspace guard を維持する。共通 Kanban には親 operationGroupId と前後二つの run を保存し、前半終了時はカードを Done にせず、後半の run を同じカードの currentRun にする。commit 後の HEAD/指紋と検証済み SHA を後半の許可に結び付け、間に別タスクを挟まない。他担当は別 workspace なら進める。push だけを頼む場合も、送信される commit の集合がこの task の確認済み範囲を超えれば Blocker にする。

Git の readonly 検査はホストの契約検証、作業対象の意味理解・commit メッセージ作成は LLM の役割。コマンド文字列を正規表現で判別することを権限制御の代替にしない。承認した git mode 内のあらゆる shell 操作を細粒度に制限できるとは仮定せず、P0 で権限の実効範囲と残る制約を記録する。

## 10. 通知と公開操作

通知は共通 Kanban が `done`、`blocker`、`waiting`、`stopped`、`git_completed`、`queue_paused` を保存する。担当名を添え、クリックで同じボードの対象カード/run を開く。SDK/terminals が別の完了通知も出す二重経路を作らない。途中の全イベントやカード移動は通知しない。`executorId + runId + kind` 等の安定キーで重複を防ぎ、Done と検証済み git 成功を混同しない。

現行タイマー通知の claim/ack と鮮度制御の考え方を再利用する。Kanban 通知へ executorId を追加し、通知センターの発信元統合は一度だけ行う。タイマー表に開発タスクを保存しない。複数タブでも同じ音を重複再生せず、ブラウザに音を拒否されても未読通知は残す。Claude Code の direct 依頼の会話通知は別経路として維持する。

| 共通 operation | 入口と前提 |
| --- | --- |
| `kanban.add/edit/move/remove` | 既存操作を拡張。add/edit は executorId、変更時は card revision。順序変更の beforeCardId と既存の列制約を維持 |
| `kanban.run` / 追加して実行 | GUI/会話。cardId、expectedRevision。保存済み executor へ投入。追加して実行は同 transaction でカードを作る |
| `kanban.change-executor-and-run` | 明示的な担当変更。実行停止確認済み、対象 executorId と確認した引継ぎ要約。新しい run/session |
| `kanban.list/inspect` | scope 内の対象だけ。担当・二本のキューも返す。モデルの snapshot は ID/revision/状態を中心にする |
| `kanban.followup/answer` | cardId、expectedRevision、sourceRunId、note/answer。元 run の担当/session へ送る |
| `kanban.cancel/stop` | 待機中の取消と実行済みの停止を区別。受付成功を停止確認と答えない |
| `kanban.review/reset` | 既存操作。未着手へ戻しても実行履歴や旧担当を消さない |
| `kanban.prepare-git` | GUI の read。確認材料を返し、権限付与・実行は行わない |
| `kanban.commit/push/commit-push` | GUI write。登録機能・元 run の担当・§9 の許可を検証 |
| `kanban.grant/reconcile` | GUI write。cardId/runId/executorId/expectedRevision を検証し、登録された実行 port に渡す |
| `kanban.resume-queue` | GUI write。executorId と expectedQueueRevision を必須化。別担当のキューを再開しない |

Codex 専用の会話 tool `codex-tasks.request/list/inspect/followup/answer/cancel/stop` は application adapter で上記の共通操作に接続する。request は executorId=codex を固定し、既存カード操作はその対象 run が Codex であることを検証する。別担当のカードを黙って引き取らない。既存 kanban 担当には担当選択・キュー参照の新しい schema/skill revision を追加するが、Claude/Codex worker の指示・tool を一つの package に混在させない。

board/detail/activity/executors は共通 artifact source API と登録 query で提供する。read は source 取得、write は `POST /api/toolchain-actions` に揃える。read の runId/cursor も scope と card の所属を検査する。UI が DB を開いたり SDK/PTY を直接起動したりしない。

## 11. 実装順序、移行と変更先

| 段階 | 作業 | 完了条件 |
| --- | --- | --- |
| P0 接続の事前確認 | SDK/CLI、イベント、schema、resume、Bun、権限、停止・再起動、git mode を隔離 fixture で確認 | §12 の技術的不確実性を解消。必要な launcher/設定だけ確定 |
| P1 共通 Kanban 契約 | executor 登録 port、カード/run の担当、二本のキュー、workspace 割当/排他、migration | 既存 Claude カードを保持し、fake 二担当が独立して動く |
| P2 Codex runner と専用担当 | SDK attempt/events/復旧、専用 profile/skill/package/binding/DomainAdapter、共通 run への結果採用 | Codex 指定で専用担当へ到達し、ボードの同じカードが更新される |
| P3 共通 GUI | KanbanBoard、二本のキュー表示、担当選択、ActivityTimeline、OpenUI、既存 Web adapter 拡張 | 入口一件。両担当の表示・操作・Blocker 対応が通る。IDE 機能なし |
| P4 通知・git | 共通 Kanban 通知、既存センター、登録機能に応じた git 確認と実行 | 二重通知なし、担当取り違えなし、部分成功・結果不明を保持 |
| P5 段階検証・live | 両担当の試験と限定した実 SDK 受入、第三担当 fixture | fixture と live を分けて記録し、移行と拡張の契約を確認 |

追加先: `api/domains/codex-tasks/`（contracts/repository/service/adapters/test）、`api/application/codex-tasks-adapter.ts`、`api/domains/capabilities/bundles/codex-tasks.bundle.json`、型付き実行担当登録 port、`ActivityTimeline` と OpenUI 登録。

拡張先: `api/domains/kanban/`、`api/application/kanban-adapter.ts`、既存 kanban bundle、capabilities の新規入力 schema、`packages/design-system/src/components/KanbanBoard/`、`web/src/domains/kanban/`。Codex 用の別 Web board adapter は作らない。必要な SDK イベントのデータ変換は共通 adapter から呼ぶ独立 module とする。

組立て・登録の変更先: `api/application/app-modules.ts`、`server.ts`、`migrations.ts`、`toolchain.ts`、`toolchain-adapters.ts`、`web/src/workspace/toolchain-adapters.ts`、client/query keys、domain 索引と `scripts/domains.ts`。既存 inference の権限・調査 prompt・Claude Code の native 実行指示を Codex 向けに変更しない。

### 既存 Kanban からの移行

- `executorId` のない既存カード/run/通知は `claude-code` に backfill。既存のキュー順序・停止理由・receipt・session を保持し、Codex キューは空で追加する。
- `claudeSessionId` は Claude 用 sessionRef へ対応付ける。列の即時削除や既存 thread の付け替えはせず、履歴読取を保つ。新しい Codex run に Claude session を渡さない。
- board の単一 `queue` を `queues[]` にする新 query/schema/artifact revision を作る。既存入力 schema/revision を書き換えず、新しい公開 revision へ切り替える。新しい担当は新 schema からしか受け付けない。
- 旧 UI/旧 artifact revision の変更操作は、旧来の Claude カード・Claude キューにだけ適用する互換規則を host に置く。特に executorId のない旧「キュー再開」を全担当へ広げない。Codex カードへの旧操作は `client_update_required` として読み直しを促す。
- 旧 board query は旧 schema のまま Claude カードと Claude キューだけを返す。古い画面に新しい担当のカードや `queues[]` を混ぜない。旧並べ替えの参照先もこの範囲に検証する。
- 実行中 run は開始時の登録 revision で終端まで追う。migration のために再送しない。起動時に運転中の未知状態があれば担当別 recover へ回す。
- 初版の `codex_tasks` / 独立 Artifact は計画のみなので作成しない。もし実装着手時点で別作業が作成済みなら、データの有無を確認して移行計画を追加し、二つのカード正本を併存させない。

現在進行中の [Claude Code 実装分担](kanban-implementation-assignments-2026-10-14.md) は改訂4の固定契約を前提としている。本書はその次の拡張計画であり、他の実行中タスクへ指示を送らない。製品実装時に最新の完成状態を確認し、固定契約の版更新と担当範囲を確定する。今回の編集対象は本書と Claude Code 計画の参照・適用範囲だけで、製品コード・分担指示は変更しない。

公開停止は executor 単位の受付・dispatch 停止設定とし、Codex 停止でも Claude Code と共通ボードを利用できる。履歴・停止操作は残す。第三担当を削除/無効化しても過去 run は表示できるようラベル・登録 revision を保存し、未完了 run がある登録は破棄しない。切戻しで実行済みのコード変更・commit・台帳を巻き戻さない。

## 12. 検証と受入条件

### P0 で先に解消する事項

1. 導入済み SDK/実際の CLI で、start → 複数 item → final schema → 終端を観測する。起動・resume のイベント順、失敗時、非対応 event を記録する。
2. 同じ thread を別プロセス・backend 再起動後に再開できること。実行を5件以上繰り返しても SDK client/プロセスが溜まらないこと。
3. 通常 mode で編集・テストを実行でき、`.git` 更新・未許可ネットワーク・秘密領域へのアクセスが拒否されること。git mode の必要権限だけを設定できること。
4. Abort、子コマンド実行中、backend 正常停止・強制終了で process tree を終了確認できること。不明なら guard を残して後続を拒否すること。
5. 長いコマンド出力・SDK の巨大行でメモリが無制限にならず、切詰めか停止を追跡できること。イベント出力がターミナル同様に一文字ずつ流れる保証はせず、SDK が提供する更新粒度を記録する。
6. git 用 granular policy が実装できない、承認を要する操作が SDK で進められない等の制約は隠さない。P0 不合格のまま full access や App Server へ自動変更しない。

### 部分・結合の回帰試験

| ケース | 観測可能な合格条件 |
| --- | --- |
| transaction rollback・同 requestId 再送・起動直後 crash | rollback 時に SDK 未呼出し、再送で attempt が増えない、成否不明を自動再実行しない |
| A 終了後 B 実行中に A の遅延/重複イベント | B の状態・結果・通知が変わらない |
| 中止と完了の競合・停止未確認 | 受理済み取消後の結果を成功採用しない。停止未確認の次 task は起動しない |
| DB 保存失敗・イベント上限・接続断 | 欠落/切詰めを明示し、cursor で復旧。保存不能を成功として進めない |
| 同一 item の更新、複数ページ、同時イベント | 出力二重追記なし、seq に重複欠落なし、UI メモリが上限内 |
| SDK 正常終了だが質問/不正 report | 質問は Blocker、不正 report も Blocker。終了だけで Done にしない |
| 回答・追加依頼・resume 不能 | 正しい thread/質問へ渡り、古い回答を拒否。復元不能を新規実行へすり替えない |
| 通常依頼に commit/push 指示、UI 偽装 | git 操作が許可されず、会話 origin が git operation を開始できない |
| commit 成功/push 失敗、push 応答不明 | SHA と工程別結果を保持、再commit・自動再pushなし、remote 照合を実施 |
| 元から dirty・変更混在・確認後の更新 | git 許可が成立しないか失効する。無関係変更を含めない |
| Claude PTY と Codex の同時起動 | 同じ cwd では片方だけが guard を取得。停止未確認で引き継がない |
| 二本のキュー・別 workspace | Claude Code 一件と Codex 一件が同時に動き、各担当の二件目は待つ。両キューの FIFO を維持 |
| 一方の Blocker/unknown/利用不能 | 通常の Blocker は停止確認後に同担当の次へ進める。unknown/利用不能は該当担当だけを止め、別 workspace の他担当は進む。再開の executor/revision を取り違えない |
| 同じ workspace の競合・idle Claude PTY | 使用中の理由を表示。Kanban 所有の idle PTY は終了確認後に解放し、待機が永久に残らない。direct PTY は自動終了しない |
| 担当変更と旧イベント | 実行中は変更拒否、完了後の変更は新 session。旧担当の終端・回答・git 許可を新 run に適用しない |
| 既存カード・旧 UI の移行 | Claude のカード・順序・履歴を保持、Codex キューは空。旧キュー再開は Claude だけ、旧 UI は Codex カードを変更できない |
| テスト用第三担当 | 登録と capability 宣言だけで選択肢・三本目のキュー・通知が現れる。未対応の git/承認操作を表示・実行しない |
| 独立担当の自然言語評価 | Codex 指定で codex_tasks、Claude 指定で既存担当。Codex 調査・他 task の thread/tool を使用しない |
| 通知と再読込み・複数タブ | 終端保存と通知が原子的、通知音は一度、詳細への遷移先が正しい |
| bundle と UI | fresh/既存DBで登録・再seed、入口一件、競合時再取得、他の OpenUI view と組合せ可能 |

部分から結合へ進め、影響がある `kanban`、`codex-tasks`、`capabilities`、`tool-runtime`、`dialogue`、`artifact` と、実際に接続を変えた `terminals`/通知の利用側を `bun run verify -- --domain <name>` で確認する。application の結合試験は `api/application/codex-tasks-*.test.ts` と担当別 dispatch/回復の試験ファイルを明示して実行する。ブラウザは既存 Kanban の試験を拡張し、新設 `tests/browser/kanban-executors.spec.ts` を個別指定する。bundle の check と自然言語受入ケースも追加する。`verify:all` を一律必須にはしない。

### 実 SDK の通し受入

隔離したテスト repository とテスト用 bare remote を使い、(1) 共通ボードで Codex 選択・依頼・編集・検証・GUI イベント・Done 通知、(2) 不足情報で Blocker・回答・続行、(3) 作業中停止・停止確認・次タスク、(4) UI の commit/push・remote SHA 確認、(5) backend 再起動・同 thread 続行を確認する。さらに Claude Code と Codex を別のテスト作業場所で並行実行し、片方の停止が他方を止めないことを確認する。同じ作業場所では排他待機を確認する。実 LLM による担当選択は固定モデル試験と分ける。通常運用の remote への push、実製品 DB/秘密の複製は受入に含めない。Grok の実接続は今回の受入対象外。

実装完了は、登録、固定試験、ブラウザ、実 SDK の結果を区別して報告する。計画作成段階ではこれらを実行しない。現在の残作業は P0〜P5 の全段階。まず P0 の観測で SDK/CLI の制約を確定し、その結果を本書へ反映してから製品実装へ進む。
