# 共通 Kanban と Codex SDK ツールチェーンの実装計画

## 改訂7: macOSでの完了待ちと管理対象の終了（2026-10-15）

利用者はmacOS実行の維持を選び、「プロンプトを渡し、結果を受け取って終了する。適切な終了を見届け、必要ならkillする」構成への変更を承認した。本節は、下記の改訂6以前にある「孤児の完全停止試験を失敗のまま保持する」という現行ゲートの指定を置き換える。過去の失敗記録は変更しない。

- 正常経路は既存SDKのイベント列を最後まで読み、直接CLIの終了と観測済み管理プロセスの停止を確認する。完了イベントだけでは成功にしない。
- `turn.completed` / `turn.failed` の後はCLIの自然終了を2秒待つ。終了しなければSIGTERM、さらに1秒後にSIGKILLを送り、それでも終了未確認なら1秒後に未確認として打ち切る。キャンセルはSDKのAbortSignalから同じ停止経路に接続する。
- CLI終了後は観測済み残存プロセスを停止する。出力口の閉鎖も1秒で打ち切り、待ち続けない。終了猶予はLLM実行時間の制限ではなく、終端イベント後の後処理時間である。実モデルでの猶予の妥当性は未実測。
- CLIの終了コード・signal、終了イベントの確認、停止理由、強制停止の有無をprocess receiptへ記録する。強制停止・終了待ち時間超過・CLI異常終了を正常成功に変換しない。停止が確認できなければ従来どおりunknownとし、guardを保持する。
- 全daemon子孫の不存在は保証しない。`stopConfirmed:false` と `containment:unproven` を維持する。`managedExecutionStopped` はCLI終了と観測済み管理対象の停止だけを表す。管理対象の終了による通常lease解放は改訂6の範囲を維持する。
- `scripts/codex-tasks-p0/orphan.test.ts` は除外せず、分離・即時終了の再現入力を保持したまま「全停止を偽って証明しない」契約を検査する。これは利用者承認による受入範囲の変更であり、全子孫停止の修正成功を意味しない。旧完全停止の診断は`orphan-live.ts`と過去の記録に保持する。P0 transportは製品transportを再利用し、異なる実装を試験しない。

検証は実SDK＋ローカルCLI fixtureの正常終了待ち・終了不能・異常終了・Abort・出力口残存、従来の停止試験、coding/codex-tasks/kanbanのdomain検証、全件検証の順。結果は[終了処理の検証記録](verification/test-environment-migration-2026-10-15/sdk-lifecycle.md)へ記録する。新たなOS権限、Linux、Dockerは導入しない。

以下は改訂6までの計画と履歴。停止契約は冒頭の改訂7を優先する。

作成日: 2026-10-14、更新日: 2026-10-15、改訂6。状態: **P1〜P3のホスト接続・固定/ブラウザ確認済み、P4の隔離SDK commit/push受入済み。Git復旧・共通画面の最終受入とP5は継続中**。対象 SDK は導入済みの `@openai/codex-sdk@0.160.0`。本書の登録名・API・テーブル名は追加予定であり、利用可能な機能を表すものではない。P0の実測と設計変更は[検証記録](verification/codex-tasks-2026-10-15/README.md)に記載する。

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
8. CodexのSDK実行はEumenes backendから独立したCLI runnerが所有する。Eumenesだけが停止しても受理済み実行は継続し、backend再起動後に同じ実行を照会して表示・結果採用を復元する。Dockerは前提にしない。利用者が指定した変更であり、backend消失時の一律終了を要件から外す。
9. 会話の履歴と継続の正本はSDK/CLIが保存するthread。runnerへ会話履歴を二重保存しない。runnerの永続記録は受付・実行ID・attempt・状態・イベントcursor・結果・停止操作・workspace保有の記録に限定する。

初期値は実装判断であり、利用者の追加指定で変更できる。特に SDK の権限制御と停止確認は §12 の事前確認を通すまで実装可能と断定しない。

## 2. 現状と再利用する接続

| 現状の根拠 | 今回の扱い |
| --- | --- |
| [SDK 接続](../api/domains/inference/adapters/codex-sdk.ts)、[調査担当](../api/domains/inference/adapters/codex-research.ts) | 現行は調査用。native tools、プロジェクト指示、履歴等を制限している。制限を緩めて開発に転用しない |
| [調査用 launcher](../api/domains/inference/adapters/codex-launcher.ts) | process group の終了などを参照する。ただし `--ephemeral`、調査用の出力量・再試行規則を開発担当に持ち込まない |
| [登録手順](../docs/toolchain-extension.md)、[検証手順](../docs/toolchain-extension-verification.md) | bundle、DomainAdapter、Web adapter、公開 revision、共通受付台帳を使う |
| [Timer adapter](../api/application/timer-adapter.ts)、[Web adapter](../web/src/domains/timers/toolchain-adapter.tsx) | transaction 内で受け付け、receipt を返し、source を再取得する接続例 |
| [通知センター](../web/src/components/domains/timers/NotificationCenter.tsx)、[Kanban 通知 API](../api/domains/kanban/controller.ts) | タイマーと Kanban の既存接続を再利用。通知センターの API と Claude の通知 kind を維持する（§10） |
| [Claude Code 計画](kanban-claude-code-plan-2026-10-14.md)、[Kanban 契約](../api/domains/kanban/contracts.ts) | 一部実装が進行中。カード・run・通知・既存 KanbanBoard を共有の正本として拡張する。Claude session と Codex thread は統合しない |
| [Queue runner](../api/domains/queue/service/runner.ts) | lease と再実行の仕組みを持つ。副作用を伴う SDK 呼出しをそのまま再試行させない |
| [coding-runner](../packages/coding-runner/src/worker.ts)、[永続保存](../packages/coding-runner/src/storage.ts) | private spool、atomic write、flock、receipt、イベントcursorを再利用候補とする。既存exec workerはfixture専用制約・backend lease失効で停止・`codex/` branch制約があり、今回のSDK・main・独立継続へそのまま転用しない。既存契約・利用側を保持してSDK用の新入口/契約を追加する |

既存の指示だけでは、開発権限、持続する SDK thread、イベント蓄積を満たせないため、新しい `codex-tasks` domain と SDK runner が必要。ただしカード管理は kanban に残す。二つの実行機構を接続する最小の登録 port を application に置き、任意コードを実行する plugin framework や別の Artifact ホストは追加しない。

### CLI runnerとSDK履歴の復元ポイント

Claude Code側は保存済みsessionを、Codex側はSDK/CLIの保存済みthreadを会話の復元ポイントとする。独立runnerはSDKを呼ぶ軽い実行ホストであり、Codexの会話履歴を独自に再実装しない。

| 所有先 | 正本と復元対象 |
| --- | --- |
| kanban / backend | 共通card/run、担当FIFO、受付receipt、UI許可、結果採用、通知。runnerから再取得して単一writer transactionで採用 |
| codex-tasks / backend | 共通runに結び付くattempt index、凍結指示/設定、runner参照、取り込んだseq、report/権限。SDKをbackend内で起動しない |
| 独立CLI runner | executionId/attemptId/epoch、起動前intent、単調seqイベント、SDK終了/報告、制御操作receipt、workspaceの実行lease。backendとの接続の有無を実行権限と混同しない |
| SDK / Codex CLI | threadIdと保存済み会話履歴。`resumeThread`で新しいturnを続行。進行中turnへの再接続APIがあるとは仮定しない |

CLIは`serve/start/inspect/events/stop/recover`を同じ型付き実行操作へ接続する。Eumenesの一般CLIがbackend APIを呼ぶだけの方式ではbackend停止中の復元に使えないため、runnerの制御はprivateなローカル接続から直接照会できる。Web/一般CLIが製品DBを直接開く方式にはしない。runnerのprivate spoolには製品DB・設定・秘密を複製しない。

Eumenesの接続断ではrunner epochを更新せず、SDK呼出しも増やさない。runner自身が終了し、SDK起動後の実行状態を証明できなければ`unknown`として保持する。SDK履歴が残っているだけで前のturnの成功・実行停止・未実行を推定しない。再開は照合後の明示操作で新attemptとし、以前の指示を自動再送しない。

### 確認した SDK の契約

- 公式資料は TypeScript SDK の `startThread`、継続実行、`resumeThread` と server-side 利用を説明している。対話的承認等を扱う独自クライアントには App Server が案内されている。[公式 SDK 文書](https://learn.chatgpt.com/docs/codex-sdk)
- 導入済み `node_modules/@openai/codex-sdk/dist/index.d.ts` で、`runStreamed`、`AbortSignal`、`outputSchema`、`thread.started`、`turn.*`、`item.*`、`error` を確認した。`turn.started/completed` に turn ID はなく、承認要求へ応答する callback も型にない。App Server のイベントを SDK の型として扱わない。
- SDK は `approvalPolicy` を指定できるが、それだけで対話的承認の GUI を実装できるとはしない。初期版は `never` と事前に制限された sandbox を組み合わせる。これは権限を無制限にする指定ではない。
- 改訂3の照合時点でも導入済み SDK 0.160.0 の公開型を読み、上記のイベント、turn ID と承認 callback の不在、`resumeThread` と設定上書きの入口を再確認した。型の存在は実動作の証明ではない。`multi_agent: false` と持続する thread・プロジェクト指示の読取りの両立は P0 で別に実証する。
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
| Artifact | 共通 `artifact:kanban.board@3`、title/launcher「タスクボード」。Codex toolchain もこれを参照する。並行する復旧作業が旧Claude画面を`@2`へ更新したため、次版を`@3`とする。既存 revision は書き換えない |
| 共通 source query | `query:kanban.board@2`、`query:kanban.detail@2`、`query:kanban.activity@1`、`query:kanban.executors@1`。application が選択された run の実行担当から取得する |
| 可用性・結果 | `availability:codex-tasks@1`、`domain:codex-tasks.receipt@1`、`projection:codex-tasks.result@1` |

会話用 tool は request/list/inspect/followup/answer/cancel/stop の各 `tool:codex-tasks.<操作>@1`。commit・push、権限の更新、実行不明からの復旧は UI 専用 operation とし、package の tool 一覧に含めない。worker の指示は受付 package の required skill に混ぜず、専用設定の revision 参照から解決する。モデル・reasoning effort は開発担当専用設定を使い、調査担当のモデルを固定流用しない。

### 会話からの受付担当の選択

同じ依頼を `kanban` と `codex_tasks` の両方へ送らない。以下を toolchain/package の `useWhen`・`avoidWhen`、受付 skill、対象選択の情報へ反映する。意味と対象の判断は LLM、対象 ID・保存済み担当・許可された操作の検証はホストが担う。

| 依頼 | 受付と担当の決め方 |
| --- | --- |
| 新規で Codex を指定 | `codex_tasks`。executorId は Codex に固定 |
| 新規で Claude を指定、または担当未指定 | `kanban`。指定担当、未指定なら最後に選んだ利用可能な担当（初回 Claude）を使い、採用した担当を回答する。既定が Codex でも別の受付担当へ重複委任せず、共通受付操作で一件を保存する |
| 既存カードの実行・追加依頼・回答・停止 | 保存済みカード／対象 run の担当を優先。Codex 対象への「これを続けて」も `codex_tasks` へ渡せる。最後に選んだ担当で上書きしない |
| 一覧・ボード整理・担当をまたぐ閲覧 | `kanban`。担当固有の worker は呼ばない |
| 既存カードの担当変更 | 通常の followup とは分け、§4の変更操作へ進む。名前を言い換えただけで既存 run の担当を変えない |

対象や担当が一意に定まらなければ、既存の確認質問を使う。担当の利用不能時は理由を返し、他担当へ自動で引き継がない。新規作成と既存操作の両方を自然言語受入で確認する。

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
| `kanban_runs`（拡張） | runId、cardId、executorId、executor revision、workspaceRef、sessionRef、kind、凍結入力、共通状態・理由、実行終了確認、実行担当側の attemptRef、結果参照、復旧時の照合結果。過去 run の担当は不変 |
| `kanban_queues`（追加/拡張） | scope と executorId ごとの順番・paused/revision・理由・activeRun。初期二行で各 concurrency=1 |
| `codex_task_attempts` | attemptId（共通 runId と1対1）、requestId、ownerRef=runId、cardId、kind、凍結入力・指示revision・設定、状態、runnerEpoch、threadId、開始/終了、期限、結果、停止確認 |
| `codex_task_events` | attemptId、単調増加 seq、SDK itemId、eventType、発生/受信時刻、検証・編集済み payload、切詰め情報 |
| Kanban 通知（拡張） | noticeId、scope、cardId、runId、executorId、kind、未読、音の claim/ack。Codex 用の重複通知表は作らない |
| `codex_task_grants` | UI 受付に結び付いた一回分の Codex git/権限許可。cardId・元runId・executorId・workspaceRef、対象・有効期限・使用先 attempt、失効理由 |

runner の進行とタスク revision を分ける。ログ一行の追加で確認画面の `expectedRevision` が毎回競合しないよう、イベントには seq、タスク操作には revision を用いる。変更操作は共通受付台帳の requestId/eventId と `expectedRevision` で保護する。最初の作成は新規 ID と requestId、一覧の順序等を変える場合は一覧 revision も使う。

### 順序判断と実行接続の責務

- kanban domain は担当別 FIFO、先頭候補、共通 run の遷移、キューを進める条件を所有し、登録担当を指す `KanbanDispatch` を返す。SDK/terminals の具象 service へ依存しない。
- application は登録 port と workspace guard を接続し、kanban の候補を検証して、run の配送状態・workspace の予約・実行担当の `enqueueInTransaction` を単一 writer transaction で確定する。どれかの受付が失敗したら、この配送の予約と保存を一緒に戻す。業務上の順序判断を application に重複実装しない。
- SDK/PTY の起動、git の外部照会、5秒・10秒の停止待ち、PTY の終了待ちは transaction の外で行う。終了・照会結果の保存時に run/epoch/revision と guard 所有者を再検証する。一方の実行待ちで writer を占有しない。

### 受付から結果採用まで

1. 認証済み UI/会話操作を共通台帳で受け、同一 writer transaction で card、共通 run、担当別キュー位置、receipt を保存する。SDK/PTY を transaction 内で呼ばない。
2. kanban が各担当キューの先頭候補を独立に選び、application が空き枠・期限・権限・workspace guard を公開操作で確認する。予約と `enqueueInTransaction` を同じ transaction にまとめ、Codexのattempt/outboxを一件保存する。commit後、同じexecutionIdとinput digestでrunnerへ受付を公開する。runnerは受付receiptとSDK起動intentを永続化してから`runStreamed`を一度呼ぶ。同executionId/digestの再照会は既存receiptであり再実行ではない。不明な送信をSDK再送へ変換しない。
3. iterator は独立runnerが生成時の `{attemptId, runnerEpoch}` を closure に固定して所有し、イベントを永続化する。backendは保存済みcursor以降を取得する。Eumenes再接続を新epoch/新attemptにせず、`thread.started`のIDを保存・継続元と照合する。
4. イベントを検証して seq 順に保存し、実行の表示 projection を更新する。`turn.completed` は最終報告の候補とする。stream の正常終端、実行プロセスの終了、報告 schema を確認するまで Done にしない。
5. SDK attempt の終了・最終報告と、購読先の kanban による run/currentRun の採用・通知を同一 writer transaction で確定する。実行担当の成功だけ保存してボード更新を失わない。commit 後に画面へ変更通知を送り、その担当の次の run を評価する。

同一 requestId の再送は既存 receipt を返す。新しい attempt は明示的な依頼で作る。§9の一度の UI 操作で許可した二工程だけは、その許可の範囲で後半を一件作れるが、失敗した attempt の自動再試行には使わない。「SDK が一度だけ副作用を実行する」保証はしない。送信と DB 保存の境界で結果不明になった場合は自動再送を禁止し、照合・人の確認へ進む。

### 共通 run の状態・表示・進行条件

`kanban_runs.state` は次表の共通状態とする。Claude の `handed` は配送済みを示す旧状態であり、実行開始の証拠にはしない。application の各 adapter が構造化された観測を共通入力へ写し、kanban が状態を採用する。詳細画面に担当固有の状態を併記できるが、カードやキューは次表を正本にする。

| 共通状態 | Claude の観測 | Codex の観測 | カード表示・同担当キュー |
| --- | --- | --- | --- |
| `queued` | 旧 `waiting_turn`、担当へ未配送 | 共通 run の未配送 | 順番待ち。workspace 競合は理由を表示し、同キューの後続は追い越さない |
| `dispatched` | 旧 `handed` かつ request は未実行 | attempt の `queued/starting` | 開始待ち。担当の実行枠を保持 |
| `running` | request の送信・実行を確認 | `running` | 実行中。実行枠を保持 |
| `waiting` | 入力・承認待ちを構造化された状態で確認 | 初期版では使わない。不足は終了後 `blocked` | 対応待ち。Terminal へ案内し、実行枠・guard を保持。idle と扱わない |
| `settling` | request の終端を受け、結果採用を検証中 | `settling` | 結果確認中。確定前に次を配送しない |
| `stopping` | 停止要求受付、終了待ち | `stopping` | 停止確認中。実行枠・guard を保持 |
| `completed` | 正常な request 終端・報告を採用 | `succeeded` と有効な報告 | Done。実行終了確認後に次候補を評価。git グループの中間工程は§9の例外 |
| `blocked` | 中断・失敗・停止の理由と実行終了を確認 | `blocked/failed`、または手動停止後の Blocker | 理由付き Blocker。終了確認済みなら次候補を評価。利用不能なら担当キューを pause |
| `cancelled` | 未送信取消、または取消と実行終了を確認 | `cancelled` | 取消理由付き Blocker。未起動または終了確認後に次候補を評価 |
| `unknown` | request の成否・停止が不明、追跡喪失 | `unknown` | 結果未確認の Blocker。担当キューを pause。停止未確認の guard は保持 |

通常の遷移は `queued → dispatched → running → settling → completed/blocked`、実行中の `running ↔ waiting`、待機中の終端は `waiting → settling`、停止時の `dispatched/running/waiting/settling → stopping → blocked/cancelled/unknown`。起動前失敗・期限切れ・取消は `queued/dispatched` から該当終端へ進める。処理中のどの段階でも成否を確定できなければ `unknown` とする。受理済み取消を遅延した成功イベントで覆さない。

runの実行終了確認と会話履歴は別の事実。CodexはSDK stream、直接管理するCLI、観測済み管理プロセスの終了を確認して実行leaseを解放する。結果採用とbackendのguard解放は単一writer transactionで行い、担当別FIFOの次候補を評価する。追加依頼はleaseを再取得し、保存したthreadIdでresumeThreadする。履歴を保持するために終了後のleaseを保持する必要はない。Claudeのidle PTYは継続に再利用できるが、別の実行へ引き渡す際は管理PTYを終了確認する。管理対象の停止が不明ならguardを保持し、時刻や文面から停止を推定しない。

共通 run の `unknown` は、§8・§9の明示的な照合操作だけで `completed/blocked/cancelled` に解決できる。元 attempt の終端とイベントは書き換えず、照合の根拠と解決結果を別記録に残す。解決しても担当キューは自動再開しない。履歴の旧 run を照合した場合、新しい currentRun の状態を変更しない。

### Codex attempt の状態遷移

次の表は Codex attempt の状態であり、Claude request の既存状態を置き換えない。各実行 adapter が検証済みの結果を共通 run の Done/Blocker と停止確認へ写す。Claude の `Stop` による完了と Codex の構造化最終報告という観測の違いは、詳細に残す。

| 状態 | 遷移と扱い |
| --- | --- |
| `queued` | 受付済み。`starting` または `cancelled`。期限切れは Blocker として終了 |
| `starting` | SDK 起動を試みた。開始を確認すると `running`。起動前失敗を確証できれば `failed`、それ以外は `unknown` |
| `running` | イベント取得中。正常終了候補は `settling`。停止要求は `stopping` |
| `settling` | 終了・報告・保存を確認中。`succeeded` / `blocked` / `failed`。確認不能は `unknown` |
| `stopping` | runnerがAbortと直接管理するCLI/既知のprocess groupの終了を待つ。管理対象の停止確認後は`cancelled/blocked`。未確認は`unknown`かつ排他保持 |
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

SDKのAbortSignalは全子孫の停止証明ではない。独立CLI runnerはSDK呼出し・直接起動したCodex CLI・観測済み管理プロセス・停止receiptを所有する。Eumenes消失時は終了させず、元の期限と権限内で実行を継続する。runner自身の正常終了は実行中attemptを止めてreceiptを保存し、強制終了など停止を照合できない場合は`unknown`とする。保存PIDだけでkillせず、本人が起動したprocess handleまたは開始時刻/nonceを照合した管理対象だけを扱う。

改訂6では復元を保存済みsessionID（CodexではthreadId）による継続に整理する。保証する実行境界はSDK turn・直接管理するCLI・観測済み管理プロセスであり、その終了確認で通常のleaseを解放する。全daemon子孫のOS封じ込めは、このCLI復元設計とは別の未達要件として記録する。独立CLI化がその問題を解決したとも、利用者が全子孫停止の失敗を承認したとも扱わない。過去の孤児再現試験は失敗のまま保持し、`workspaceReleaseConfirmed`や`stopConfirmed`を全子孫停止の証明として公開しない。観測した管理プロセスの残存・制御不能ではguardを保持する。コマンドの語句判定やLLMの自己申告を停止証明にしない。

## 8. 実行環境、再起動と他担当との排他

backendのSDK実行接続は`codex-tasks`のrunner portとし、実際のSDK adapterは独立CLI runner内に置く。認証は承認済みCodex実行環境を利用し、キーをtask/Artifact/ログへ複製しない。実行に必要な環境だけを渡し、プロジェクト指示は読めるようにする。全plugin/MCP/別chat操作を自動継承せず、ephemeral設定を使わずSDK/CLIのthread保存を維持する。

通常作業は `workspace-write`、実行先のネットワークアクセスは初期無効、許可の自動拡大なし。モデルとの通信と作業コマンドのネットワーク権限を区別する。依存取得などの追加権限は GUI で範囲を確認して別 attempt に渡す。非公開設定、LARM credential、Eumenes の製品 DB を子プロセスへ公開しないための deny/read 範囲を P0 で点検する。

### 作業場所の割当と排他

ホストの project 登録に担当ごとの `workspaceRef` を持たせる。初期の両担当は既存 eumenes の作業場所を利用できるが、二本を並行実行する場合は利用者が用意・指定した別の作業コピーへ割り当てる。初期版はこの設定と解決を実装し、自動 clone/branch/worktree 作成や merge は追加しない。別の作業コピーへ、未コミット変更や秘密を自動コピーしない。

run の workspaceRef と実体パスは受付時に固定する。設定変更で過去 run の followup/git の送り先を変えない。割当先が利用不能なら Blocker。別 cwd の worktree が同じ Git common directory を共有する場合は、refs/index 等に作用する git 工程に common directory の排他も追加する。複数ロックは固定順で一括予約し、片方だけ保持して待たない。

application の小さい workspace execution guard を共通化する。key はホストが解決した作業ディレクトリの実体パス。保存するのは所有 domain/attempt、epoch、状態だけであり、担当や prompt は共有しない。

- Codex 起動と Claude Code の起動・自動依頼・手入力受付が guard を参照する。確認と予約は同じ writer transaction で行う。
- 同じ cwd の Claude PTY が生きている間は guard を保持する。Kanban 所有の idle PTY は、後続の他担当が待っていれば自動で閉じ、終了を確認してから解放する（会話は保存済みなので後で resume できる）。idle を確認できない PTY は閉じない。direct 所有の PTY は自動で閉じず、画面で終了を案内する。Codex が guard を持つ間、その cwd の Claude PTY 起動を拒否する。
- guard は終了確認後にのみ解放する。unknown の lease 時間切れだけでは解放しない。別 cwd の実行や通知閲覧を止めない。
- 外部 Terminal やエディタの手作業まで排他できるとはしない。git 操作時には作業状態を再照合する。Claude/Codex の会話・実行機構を統合せず、共有する業務モデルはカード・run・キュー・通知に限る。

#### Kanban 所有の idle PTY を終了する条件

1. terminals の公開操作で、owner が Kanban、activity が確認済み idle、未完了 request・手入力による実行・入力／承認待ちがないこと、保存済み会話を再開できることを確認する。無イベント・経過時間・古い activity 表示は idle の証明にしない。
2. 同じ writer transaction で session/guard の epoch と状態を再確認し、引渡しのための `releasing` を予約する。Kanban の新規配送だけでなく、直接の手入力と session 再利用も、この予約を検査する。先に入力が受け付けられていたら予約せず、先に予約されたら新たな入力を送らず再開可能になるまでの理由を返す。
3. transaction の外で対象 PTY の終了を要求し、管理対象の同一性と終了を確認する。終了確認後の transaction で guard を解放し、待っている両キューの候補を再評価する。終了を確認できない場合は guard を保持して停止未確認を表示し、他担当へ引き渡さない。

この操作は利用者が入力中の session を強制終了する一般機能ではない。direct 所有、手入力の処理中、入力・承認待ち、状態不明では自動終了の対象にしない。予約と入力受付の競合、終了失敗、backend 再起動中の `releasing` を試験する。

### backend の再起動

backend再起動では担当キューを照合待ちにし、未配送runの順序を保持する。Codexは同executionIdで既存runnerへ再接続し、受付receipt・現在状態・保存イベントの続き・最終報告を照合する。生きたrunnerが同epochで実行中なら、その状態を復元し、既存attemptをSDKで再起動しない。完了済みなら最終seqまで取得して一度だけ結果/通知を採用する。接続断だけでattemptを`unknown`や新epochへ変更しない。

runner自身の再起動では、SDK起動intent前の未実行と、起動後/成否不明を区別する。後者は管理対象の照合とSDK保存履歴の参照を行うが、実行中turnへattachできると仮定せず`unknown`を保持する。照合できる永続終端receiptがあればその結果を採用できる。履歴だけを根拠に成功採用・再commit・再pushしない。停止未確認のguardを保持し、明示復旧後の新attemptだけを`resumeThread`で続ける。Claude側は既存recover契約を保持する。

threadId が残っていても、最後の操作が成功したと推定しない。保存済みイベントと git 等の読み取りで状況を表示し、人が確認後に対象 executorId と queueRevision を指定してキューを再開する。再開で古い attempt は送り直さない。git の検証済み工程は§9の記録を維持し、未確認工程だけを照合する。Done の thread は通常どおり resume できる。メモリに残る SDK client 数をセッション数の上限にせず、実行終了後に解放する。

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

### git 工程の保存地点と再起動時の照合

Codex の git attempt には、消費した許可 ID、operationGroupId、元 run、実行前の HEAD・branch・index/working tree の指紋、許可した変更の内容指紋と対象パス、push の remote/ref・送信対象を凍結する。パス名だけの一致を同じ変更の証拠にしない。内容の比較はホスト内で行い、GUI に Diff を追加しない。

- commit の実行終了と結果をホストが検証したら、`commit_verified` と SHA・親 HEAD・tree・許可範囲の照合結果・検証時の状態指紋を保存する。この記録と共通 run の完了、operationGroup の工程更新は同じ writer transaction にする。
- push の許可が引き続き有効なら、その transaction で後半の run/attempt の受付まで保存する。後半は `(operationGroupId, stage=push)` で一意にし、起動は commit 後とする。許可が失効していれば commit 成功の記録を残し、グループは Blocker にして確認画面へ戻す。commit をやり直さない。
- `commit_verified` を持つ工程は backend 再起動で未確認へ戻さない。push が未起動の `queued` なら同じ受付を保持し、回復と明示的なキュー再開の後に、期限・指紋・元 run を再検証して一度だけ起動する。`starting` 以降の push は自動再送しない。

部分成功の Blocker でグループを終える場合、実行終了を確認して枠・guardを解放する。後日のpush再依頼は、検証済みcommitを参照する新しいUI許可と新しい操作グループで受け付ける。旧グループの一意制約を解除して再実行しない。停止未確認なら枠・guardを保持する。

`kanban.reconcile` は UI の要求を application の担当別 port へ渡す。管理プロセスの停止と workspace の排他を確認し、外部の git 読取りを transaction 外で行い、保存時に run/epoch・guard・許可記録を再確認する。

| 落ちた地点／残る状態 | 照合と採用 |
| --- | --- |
| commit の副作用後、`commit_verified` 保存前 | 保存済みの許可と実行前状態から候補 commit を照合。親 HEAD、branch、tree/変更内容、対象パス、task・attempt への帰属を確認する。HEAD に commit がある、メッセージが似ている、SHA が報告にある、だけでは認定しない。条件を証明できなければ `unknown` のまま |
| `commit_verified` 保存後、push 起動前 | 記録済み SHA を保持。後半受付を重複作成せず、再commitしない。未起動pushの許可失効・状態変更は確認をやり直す |
| push 起動後、応答または保存前 | 許可された remote/ref と対象 SHA を読取り照合。ref が対象 SHA を指すこと、または取得した履歴で対象 SHA を含むことを証明できた場合だけ反映を確認する。照会不能・履歴不足・帰属不明は `unknown`。不一致だけで「副作用なし」として再pushしない |
| 外部変更・余分なcommit・許可範囲との不一致 | 成功に変更せず根拠を表示する。整理または新たな許可を必要とし、同じ許可で新しい commit attempt を作らない |

照合は元 attempt を再実行せず、その不明終端に結び付く回復結果を保存する。検証済み成功と通知は同じ transaction で一度だけ採用する。成功と認定できても担当キューの再開は別の明示操作とし、push の新しい権限を暗黙に付与しない。結果不明のまま利用者が停止を確認しただけの場合も、git 成功には昇格しない。

Git の readonly 検査はホストの契約検証、作業対象の意味理解・commit メッセージ作成は LLM の役割。コマンド文字列を正規表現で判別することを権限制御の代替にしない。承認した git mode 内のあらゆる shell 操作を細粒度に制限できるとは仮定せず、P0 で権限の実効範囲と残る制約を記録する。

## 10. 通知と公開操作

通知は共通 Kanban が既存の `done`、`blocker`、`waiting`、`commit_push`、`queue_paused` を維持し、`stopped`、`git_completed` を追加する。Claude の既存 `commit_push` は「commit & push の報告」であり、過去の通知を検証済み成功へ変更しない。Codex の `git_completed` はホストが検証した工程だけに使い、mode と検証済み SHA を持たせる。二工程グループでは全工程成功時に一件だけ通知し、commit 成功/push 失敗は部分成功の SHA を添えた Blocker とする。

担当名を添え、クリックで同じボードの対象カード/run を開く。SDK/terminals が別の完了通知も出す二重経路を作らない。途中の全イベントやカード移動は通知しない。`executorId + runId（グループなら operationGroupId）+ kind` の安定キーで照合後の再通知も防ぐ。手動停止を `stopped` で通知した場合は同じ終端の `blocker` を重ねない。Done と検証済み git 成功を混同しない。

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

board/detail/activity/executors は共通 artifact source API と登録 query で提供する。ボードの read は source 取得、write は `POST /api/toolchain-actions` に揃える。read の runId/cursor も scope と card の所属を検査する。通知センターは既存の `GET /api/kanban/notices` と既読化 `POST /api/kanban/notices/:id/read` を維持し、ボードの source API へ置き換えない。同じ kanban 通知を参照し、別の通知正本を作らない。UI が DB を開いたり SDK/PTY を直接起動したりしない。

## 11. 実装順序、移行と変更先

| 段階 | 作業 | 完了条件 |
| --- | --- | --- |
| P0 接続の事前確認 | 既存SDK/権限/git実測を保持。独立CLIの永続受付/イベント/状態、Eumenes切断と再接続、runner自身の終了/unknown、SDK履歴resumeを隔離fixtureで確認 | backend消失でSDKを再実行せず復元できる。管理対象の停止と保証範囲を記録し、制御不能はunknown/排他保持 |
| P1 共通 Kanban 契約 | 完成した Claude 契約の保存形と移行判断を記録。その後、executor 登録 port、共通 run 状態表、二本のキュー、workspace 割当/排他、migration | 既存 Claude カードを保持し、旧画面の扱いを確定。fake 二担当で状態対応・終了待ち・writer rollback が通る |
| P2 Codex runner と専用担当 | SDK attempt/events/復旧、専用 profile/skill/package/binding/DomainAdapter、共通 run への結果採用 | Codex 指定で専用担当へ到達し、ボードの同じカードが更新される |
| P3 共通 GUI | KanbanBoard、二本のキュー表示、担当選択、ActivityTimeline、OpenUI、既存 Web adapter 拡張 | 入口一件。両担当の表示・操作・Blocker 対応が通る。IDE 機能なし |
| P4 通知・git | 共通 Kanban 通知と既存 API、登録機能に応じた git 確認と実行、工程保存・再起動照合 | 二重通知なし、担当取り違えなし。commit成功を保持し、不明な工程を自動再実行しない |
| P5 段階検証・live | 両担当の試験と限定した実 SDK 受入、第三担当 fixture | fixture と live を分けて記録し、移行と拡張の契約を確認 |

追加先: `api/domains/codex-tasks/`（contracts/repository/service/adapters/test）、`api/application/codex-tasks-adapter.ts`、`api/domains/capabilities/bundles/codex-tasks.bundle.json`、型付き実行担当登録 port、`ActivityTimeline` と OpenUI 登録。

拡張先: `api/domains/kanban/`、`api/application/kanban-adapter.ts`、既存 kanban bundle、capabilities の新規入力 schema、`packages/design-system/src/components/KanbanBoard/`、`web/src/domains/kanban/`。Codex 用の別 Web board adapter は作らない。必要な SDK イベントのデータ変換は共通 adapter から呼ぶ独立 module とする。

組立て・登録の変更先: `api/application/app-modules.ts`、`server.ts`、`migrations.ts`、`toolchain.ts`、`toolchain-adapters.ts`、`web/src/workspace/toolchain-adapters.ts`、client/query keys、domain 索引と `scripts/domains.ts`。既存 inference の権限・調査 prompt・Claude Code の native 実行指示を Codex 向けに変更しない。

### 既存 Kanban からの移行

**基本方針は新revision（共通Artifactは既存`@2`の次の`@3`）への更新と既存データの移行。旧UIの変更操作を継続する互換層は原則作らず、再読込みで新版へ移す。** seed済み定義の本文を同じrevisionへ上書きしない。データ保持、定義の版管理、古い画面の継続利用は別の判断として扱う。

P1 の最初に、Claude 実装完了時のコミットと契約、保存済みカード/run/receipt、登録済み定義と参照、保存された Artifact・旧クライアントの継続要件を確認し、この節へ結果と採用経路を記録する。製品データは公開された読み取り操作で確認し、移行試験は隔離DBで行う。DBの削除や設定の初期化で互換問題を回避しない。

| 確認結果 | 採用する経路 |
| --- | --- |
| 既存データまたはseed済み定義がある／利用状況を確認できない | 新revisionを追加しデータを移行。旧変更操作は新規受付せず `client_update_required` で新版へ案内。旧queryに `queues[]` を無理に返さず、新版のsourceへ再取得を求める |
| 旧UI・保存済みArtifactの継続利用が具体的に必要 | その根拠・対象revision・終了条件を記録したうえで限定互換を追加。旧queryはClaudeカードとClaudeキューだけ。旧変更操作も同範囲に限定し、担当なしのキュー再開を全担当に広げない。Codexカードへの旧操作は拒否 |
| 未配布で、保持対象のデータ・定義・参照もないことを確認済み | 互換層もデータ移行も不要。公開版は本書の新revisionへ揃える。同一revisionへの上書きを目的に追加の分岐を作らない |

- `executorId` のない既存カード/run/通知は `claude-code` に backfill。既存のキュー順序・停止理由・receipt・session を保持し、Codex キューは空で追加する。
- `claudeSessionId` は Claude 用 sessionRef へ対応付ける。列の即時削除や既存 thread の付け替えはせず、履歴読取を保つ。新しい Codex run に Claude session を渡さない。
- board の単一 `queue` を `queues[]` にする新 query/schema/artifact revision を作る。既存入力 schema/revision を書き換えず、新しい公開 revision へ切り替える。新しい担当は新 schema からしか受け付けない。
- 旧 run の `waiting_turn` は共通 `queued` に、`completed/blocked/cancelled` は同名の状態と既存理由を保持して移す。`handed` は terminals の request を照合して§5の状態へ写し、観測できなければ `unknown` として担当キューを止める。`handed` を無条件に `running` にしない。
- 旧操作の受付停止後も、既に受理した requestId の replay は既存 receipt を返し、副作用を再実行しない。限定互換を選ぶ場合だけ、旧並べ替えの参照先を含むClaude限定の範囲を検証する。
- 実行中 run は開始時の登録 revision で終端まで追う。migration のために再送しない。起動時に運転中の未知状態があれば担当別 recover へ回す。
- 初版の `codex_tasks` / 独立 Artifact は計画のみなので作成しない。もし実装着手時点で別作業が作成済みなら、データの有無を確認して移行計画を追加し、二つのカード正本を併存させない。

[Claude Code 実装分担](kanban-implementation-assignments-2026-10-14.md) は改訂4の固定契約を前提としている。本書はその次の拡張計画であり、同じ契約を変更する Claude の実装作業と P1 以降を並行させない。他の実行中タスクへ指示を送らず、製品実装時に最新の完成状態を確認し、固定契約の版更新と担当範囲を確定する。改訂3の編集対象は本書のみで、製品コード・分担指示・Claude計画は変更しない。

公開停止は executor 単位の受付・dispatch 停止設定とし、Codex 停止でも Claude Code と共通ボードを利用できる。履歴・停止操作は残す。第三担当を削除/無効化しても過去 run は表示できるようラベル・登録 revision を保存し、未完了 run がある登録は破棄しない。切戻しで実行済みのコード変更・commit・台帳を巻き戻さない。

## 12. 検証と受入条件

### P0 で先に解消する事項

1. 導入済み SDK/実際の CLI で、start → 複数 item → final schema → 終端を観測する。起動・resume のイベント順、失敗時、非対応 event を記録する。
2. 開発用 runner の設定で `multi_agent: false` を明示したまま、プロジェクト指示を読み、同じ thread を別プロセス・backend 再起動後に再開できること。調査用の `--ephemeral`、プロジェクト指示無効化、履歴制限をコピーしない。実際のCLI版・有効な設定・公開されたツール・再開の観測を記録し、サブエージェント起動が無効であることも確認する。実行を5件以上繰り返しても SDK client/プロセスが溜まらないこと。
3. 通常 mode で編集・テストを実行でき、`.git` 更新・未許可ネットワーク・秘密領域へのアクセスが拒否されること。git mode の必要権限だけを設定できること。
4. backend正常停止/強制終了で独立runnerと受理済みSDK turnが継続し、再接続で同executionId/epoch/seqを復元できること。手動Abortはrunnerへ保存した制御操作を届け、管理対象CLIの終了を確認する。runner強制終了・起動境界crashは自動再送せずunknown/guard保持とする。管理対象の停止未確認なら次タスクを起動しないこと。過去の分離daemon再現は全子孫停止の失敗として保持し、管理対象の終了確認による通常FIFOと区別して記録する。
5. 長いコマンド出力・SDK の巨大行でメモリが無制限にならず、切詰めか停止を追跡できること。イベント出力がターミナル同様に一文字ずつ流れる保証はせず、SDK が提供する更新粒度を記録する。
6. git 用 granular policy が実装できない、承認を要する操作が SDK で進められない等の制約は隠さない。P0 不合格のまま full access や App Server へ自動変更しない。

### 部分・結合の回帰試験

#### P0実測による留保（2026-10-15）

SDK 0.160.0 / CLI 0.162.1 / Bun 1.4.3 / macOS 26.6.2で、編集・検証・AGENTS読取り・別プロセスresume・制限されたfilesystem/network・別attemptのcommit/local bare pushを観測した。権限は公開`configOverrides`からinline TOMLを渡し、`default_permissions`で選ぶ。filesystemのpath/globキーはSDKのdotted-path展開では正しく伝送できなかった。旧`sandboxMode/networkAccessEnabled`を併用しない。`features.multi_agent=false`を保ち、ephemeral・履歴無効化・調査用launcherは使っていない。

改訂4の全子孫停止保証は**未達のまま**。process group/子孫ポーリングが分離・即時reparent化した子を見落とすことをfixtureと実SDKで再現した。この記録や試験期待値は変更しない。改訂5では利用者の指定で復元ポイントを独立CLI＋SDK保存threadに置き、backend消失時の一律終了を外す。全daemon封じ込めは別の未達事項として保持する。改訂6では管理対象の終了確認で通常のworkspaceを引き渡す。Docker検討は製品実装へ採用しない。

現行macOSのkqueue自動子孫追跡は非対応で、fork通知の子PIDも公開keventへ渡らないことを現行SDKヘッダーと[Apple公開ソース](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/event.h)で確認した。独立CLI化はこのOS制約を解消するものではなく、backendの寿命と実行の寿命を分ける設計変更である。full accessやApp Serverへ切り替えない。

改訂5の独立CLI/復元受入は隔離fixtureで成立した。改訂6の管理対象終了とsessionID継続の契約で、共通契約・移行・実SDKのボード接続を進める。並行作業で`kanban.bundle.json`、`terminals-screen.bundle.json`、tool-runtimeの受付とseed/upgrade試験が変わったため、その完成状態と公開参照を再確認する。復旧された`artifact:kanban.board@2`を共通担当対応の実装と扱わない。

| ケース | 観測可能な合格条件 |
| --- | --- |
| transaction rollback・同 requestId 再送・起動直後 crash | rollback 時に SDK 未呼出し、再送で attempt が増えない、成否不明を自動再実行しない |
| 共通 run の状態対応 | Claude の未送信／実行／承認待ち／終了と Codex の各状態が§5の同じ表示・進行条件へ写る。`handed`だけでは実行中にしない。終了済みrunとidle PTYのguard保持を区別する |
| application の配送と停止待ち | workspace予約・共通run更新・担当受付の途中失敗が一緒にrollback。5秒・10秒の待機中も別workspaceのキュー受付・起動がwriterを使える |
| A 終了後 B 実行中に A の遅延/重複イベント | B の状態・結果・通知が変わらない |
| 中止と完了の競合・停止未確認 | 受理済み取消後の結果を成功採用しない。停止未確認の次 task は起動しない |
| DB 保存失敗・イベント上限・接続断 | 欠落/切詰めを明示し、cursor で復旧。保存不能を成功として進めない |
| 同一 item の更新、複数ページ、同時イベント | 出力二重追記なし、seq に重複欠落なし、UI メモリが上限内 |
| SDK 正常終了だが質問/不正 report | 質問は Blocker、不正 report も Blocker。終了だけで Done にしない。管理対象CLIの終了とworkspace所有runnerの解放は別に扱う |
| 回答・追加依頼・resume 不能 | 正しい thread/質問へ渡り、古い回答を拒否。復元不能を新規実行へすり替えない |
| Eumenesのみ終了・再接続 | 同じCLI runner・executionId・epochで実行継続。保存cursorからイベント再取得し、結果/通知は一件。SDKへの依頼回数は増えない |
| CLI runner自身の終了・復元 | SDK起動前と起動後を区別。永続済み終端receiptは復元し、起動後不明はunknown/guard保持。SDK thread履歴だけで成功や停止を確定せず、指示を自動再送しない |
| 通常依頼に commit/push 指示、UI 偽装 | git 操作が許可されず、会話 origin が git operation を開始できない |
| commit 成功/push 失敗、push 応答不明 | SHA と工程別結果を保持、再commit・自動再pushなし、remote 照合を実施 |
| git 工程の境界ごとの crash | commit副作用後／検証済み保存後／push受付後／push起動後で停止。検証済みSHAを失わず、後半runは一件だけ。許可失効ならpushを開始しない。不明な工程は照合し、同じ許可で再commitしない |
| git 照合の不一致・確認不能 | 同じパスの異なる内容、異なる親HEAD、他者commit、remote照会失敗を成功としない。照合成功の再送でも結果・通知は一件、キューは自動再開しない |
| 元から dirty・変更混在・確認後の更新 | git 許可が成立しないか失効する。無関係変更を含めない |
| Claude PTY と Codex の同時起動 | 同じ cwd では片方だけが guard を取得。停止未確認で引き継がない |
| 二本のキュー・別 workspace | Claude Code 一件と Codex 一件が同時に動き、各担当の二件目は待つ。両キューの FIFO を維持 |
| 一方の Blocker/unknown/利用不能 | 通常の Blocker は停止確認後に同担当の次へ進める。unknown/利用不能は該当担当だけを止め、別 workspace の他担当は進む。再開の executor/revision を取り違えない |
| 同じ workspace の競合・idle Claude PTY | 使用中の理由を表示。確認済みidleのKanban PTYだけがreleasingへ進み、終了確認後に解放。承認待ち・手入力処理中・状態不明・directは自動終了しない。予約と手入力の両方の順序、終了失敗・再起動でも二担当が同じcwdに入らない |
| 担当変更と旧イベント | 実行中は変更拒否、完了後の変更は新 session。旧担当の終端・回答・git 許可を新 run に適用しない |
| 既存カード・旧 UI の移行 | Claudeのカード・順序・履歴・receiptを保持、Codexキューは空、seed済みrevisionを上書きしない。原則は旧操作を再読込みへ案内し、受付済みreplayは副作用なし。限定互換を採る場合は旧query/操作をClaudeだけに限定し、旧キュー再開が他担当へ及ばない |
| テスト用第三担当 | 登録と capability 宣言だけで選択肢・三本目のキュー・通知が現れる。未対応の git/承認操作を表示・実行しない |
| 独立担当の自然言語評価 | 新規Codex指定、Claude指定、未指定・既定Codex、既存Codexカードへの「続けて」、担当変更、曖昧な対象を確認。受付は一件、既存runの担当を既定で上書きせず、調査・別taskのthread/toolを使用しない |
| 通知と再読込み・複数タブ | 終端保存と通知が原子的、通知音は一度、詳細への遷移先が正しい。既存notices APIと既読化を維持。Claudeのcommit_push報告を検証済みと表示せず、Codexのgit_completedは検証済み工程だけ。二工程・停止・照合で重複通知なし |
| bundle と UI | fresh/既存DBで登録・再seed、入口一件、競合時再取得、他の OpenUI view と組合せ可能 |

部分から結合へ進め、影響がある `kanban`、`codex-tasks`、`capabilities`、`tool-runtime`、`dialogue`、`artifact` と、実際に接続を変えた `terminals`/通知の利用側を `bun run verify -- --domain <name>` で確認する。application の結合試験は `api/application/codex-tasks-*.test.ts` と担当別 dispatch/回復の試験ファイルを明示して実行する。ブラウザは既存 Kanban の試験を拡張し、新設 `tests/browser/kanban-executors.spec.ts` を個別指定する。bundle の check と自然言語受入ケースも追加する。`verify:all` を一律必須にはしない。

### 実 SDK の通し受入

隔離したテスト repository とテスト用 bare remote を使い、(1) 共通ボードで Codex 選択・依頼・編集・検証・GUI イベント・Done 通知、(2) 不足情報で Blocker・回答・続行、(3) 作業中停止・停止確認・次タスク、(4) UI の commit/push・remote SHA 確認、(5) backend 再起動・同 thread 続行を確認する。さらに Claude Code と Codex を別のテスト作業場所で並行実行し、片方の停止が他方を止めないことを確認する。同じ作業場所では排他待機を確認する。実 LLM による担当選択は固定モデル試験と分ける。通常運用の remote への push、実製品 DB/秘密の複製は受入に含めない。Grok の実接続は今回の受入対象外。

実装完了は、登録、固定試験、ブラウザ、実SDKの結果を区別して報告する。現在は既存P0の接続・権限・SDK履歴・git実測を保持し、改訂5の独立CLI/復元受入を隔離fixtureで確認済み。P1〜P3の共通契約/移行・独立runner・画面部品を実装中。ホスト登録、P4〜P5は残作業。独立runnerの受付/永続イベント/接続復元/unknown/管理対象停止を確認してから製品へ接続する。

## 14. 改訂5の設計変更（2026-10-15）

利用者の「CLIを復元ポイントにする」「SDK単体でもsession履歴を持つ」という指定を反映した。会話履歴は既存SDKの保存threadを使い、独立CLIには実行制御と復元照合に必要な記録だけを置く。Eumenes停止時の一律終了から、独立実行と再接続へ変更した。Dockerを製品の前提にせず、過去の孤児停止失敗を成功扱いしない。管理対象の停止と全daemon子孫封じ込めの保証範囲を明記し、unknownの自動再送禁止・workspace排他・UI限定git権限は維持した。

残作業はP0独立CLI受入→P1共通状態/移行/guard→P2SDK担当の登録と採用→P3共通GUI→P4通知/git→P5全体受入。既存exec runnerのfixture専用実行・backend lease・branch制約は変更せず、永続保存等の共通機構を使うSDK入口を追加する。

## 13. 改訂3で反映したレビュー

| 論点 | 採用した内容 |
| --- | --- |
| 未配布契約の互換 | §11。新revisionとデータ移行を基本にし、旧UIの操作互換は具体的な継続要件がある場合だけ |
| 共通runの状態 | §5。担当の観測、共通状態、表示、キュー進行、実行終了とguard解放を対応付け |
| commit後の復旧 | §9。検証済み工程の保存、未確認工程の照合、許可失効、後半受付の一意性を定義 |
| domainの責務 | §5。順序と状態判断はkanban、複数domainの接続はapplication、外部実行・待機はtransaction外 |
| 会話の入口 | §3。新規依頼と既存対象を分け、保存済み担当を優先して二重受付を防止 |
| idle PTY | §8。入力・承認待ちの除外、releasing予約と手入力受付の競合、終了確認を定義 |
| 通知 | §10。既存APIとcommit_push報告を維持し、検証済みgit成功と区別 |
| 開発runnerの事前確認 | §2・§12。導入済み公開型の再確認と、サブエージェント無効化・持続thread・プロジェクト指示の実動作確認を区別 |

改訂3では計画書だけを変更し、差分・節間の整合・ローカル参照を点検する。製品コード、fixture、ブラウザ、実SDKの検証は未実施であり、P0〜P5の完了を意味しない。

### 改訂5の実装進捗

独立CLIは保存受付/起動intent/単調seq/最終report/制御receiptを保持する。接続元clientのSIGTERM/SIGKILL後の実SDK完了・同epoch/同thread再接続・同ID再送による重複起動防止、runner再起動後の完了結果復元を隔離repoで確認した。これは実Eumenes server/GUIの通し試験とは区別する。runner自身のSIGKILL後はunknownとして元指示を再送せず、manual Abortは管理CLI終了を確認した。実SDKのdaemon再現でもworkspaceReleaseConfirmed=falseを保持し、引渡しを拒否した。

P1の保存形はkanban/0003-executorsへ追加し、既存migration/receipt bytesは保持する。stateは共通語彙、旧query@1は旧語彙へ投影する。旧handedはdispatchedとして移し、実開始は起動時の担当port照合で確定する。executor登録・FIFO・workspace guardはprovider名による分岐を持たない。部分試験で第三のfixture担当、移行、transaction rollback、unknown時の自担当queue停止とguard保持を確認。P1の実行port接続・PTY手入力排他とP2〜P5は残作業。

### 2026-10-15の継続進捗

- P1: 担当別FIFO、共通状態、旧Claudeカード/run/receiptを保持するmigration、workspace guardの予約/releasing/unknown、構造化観測の採用、担当選択と最後の選択の保存。旧query@1はClaudeカードを表示し、shared query@2は登録担当全体を表示する。実PTYの起動・入力・終了とguardを結ぶ接続は未完了。
- P2: codex-tasks domainに凍結spec/起動outbox/seqイベント/結果/設定revisionを保存。coding domainの公開protocolを介して独立CLIを照会するapplication portを実装。起動要求前に出版intentを保存し、backend再接続は既存実行の照会から復元する。起動済みが不明な場合に同じSDK依頼を再送しない。domain6件、application4件のfixtureが成功。製品ホスト・bundle・設定画面への登録は未完了。
- P3: KanbanBoardの担当選択/表示フィルター/担当別キューと、汎用ActivityTimelineの追従停止/折畳み/空/切断状態を実装。部品32件の固定試験成功。OpenUI登録を追加したが、共有source/detail/activityとWeb adapter・artifact@3の接続、ブラウザ受入は残作業。
- 独立CLIにはlistを加え、backend停止中も実行IDとthreadIdを取得できる。会話履歴はSDKに残し、同じカードの明示的な継続はresumeThread、明示的な新規実行は新threadでworkspace保有だけを引き継ぐ。
- 改訂6: 管理対象の終了確認でworkspaceを解放し次カードを進める。追加依頼は保存したthreadIdで再開する。分離daemonを見落とす制約と過去の失敗は保持し、workspaceReleaseConfirmedを全子孫停止の証明として立てない。

残作業の依存順: P1の実PTY/入力とguardの接続→P2のホスト登録・専用設定・SDK worker/受付bundle→P3のsource/詳細/activity接続とbrowser→P4のUI git許可/工程/照合/通知音→P5の固定/自然言語/実SDK・Claude通し。共有workspace引渡し方式の判断に依存する部分は有効化しない。

### 改訂6: sessionIDによる継続（2026-10-15）

利用者の「sessionIDで引き継げばいい」という指摘に合わせ、追加の実行環境選択は求めない。実行中は独立runnerのexecutionId/epoch/cursorを再取得し、終了後の続行は保存したthreadIdで新turnを実行する。SDK履歴を独自保存せず、通常の終了で実行leaseを解放する。runner自身の起動後crashだけはunknownとして自動再送を止める。全daemon封じ込めの旧受入失敗はこの変更で成功へ置き換えない。

共有Artifactの画面操作は、登録済みsourceBindingsのadapterを正本として実行する。会話受付bindingのadapterと一致することは要求しない。既存機構の一致制約では、Codex受付担当から共通Kanban画面を使う操作がartifact_unavailableになることをブラウザ経路で再現した。source・query・operation・effect・scope・revision・input・receiptの既存検証は維持する。同じArtifact revisionを参照する複数toolchainはメニューで一件にまとめる。旧Kanban bundleは復旧済みの内容を保全し、新しい共通登録はkanban.shared.bundle.json、Codex登録はkanban.worker-codex-tasks.bundle.jsonへ分離する。

### P4の実行境界の具体化

SDKのnative shellへ.git書込みや外部通信を広く開く方式では、UIで確認したファイル・送信先・SHAへの制限をホストで強制できない。既存coding-runnerのsnapshot、gitBytes、Git検証、MCP stdio登録を再利用する。git工程だけ、privateな凍結許可を読むMCPツールをSDKへ渡す。通常のnative toolsはgit工程もread-only・通信禁止とし、MCPのホスト操作が対象ファイルのhash、元HEAD、branch、remote URL、期限、操作IDを検証して固定のGit操作を実行する。秘密やProvider環境変数はモデル・製品ログへ渡さない。

一件のUI受付をoperation groupとして保持し、commitとpushは別のSDK turn・privateなphase intent/receiptで記録する。両turnは保存した同じthreadを使い、verified commit SHAを永続化してからpush工程を開く。MCP操作は同IDのreceiptをreplayし、副作用不明のintentを自動再実行しない。共通カード・通知はgroupの終端を一度だけ採用し、codex-tasksはphaseの検証結果を保存する。管理対象が止まっていてもgit副作用不明ならunknown/guard保持とする。これはLLMの意味判断を移す実装ではなく、明示UI許可とGit外部仕様の制約を強制する実行境界である。


### 現在の登録と検証（2026-10-15）

共通画面の次版はartifact:kanban.board@4、Kanban受付はbinding/toolchain:kanban.manage@4、Codex受付はbinding/toolchain:codex-tasks.manage@2とする。旧kanban.bundle.jsonと登録済みrevisionは上書きせず、新bundleと次版で接続する。Kanban/0001〜0003は適用済みSQLとして保持し、Git保存形は0004-gitで追加する。Codexのnative履歴はrunnerに複製しない。

P4のprivate MCPツールは、画面で一回確認した許可に結び付くcommitかpushの一方だけを公開する。required/enabled_toolsと、その一つのtools.<tool>.approval_mode=approveをホストconfigに固定する。通常作業はMCPを登録しない。任意のMCPやshellを包括承認する機構は追加しない。根拠は[公式MCP設定](https://learn.chatgpt.com/docs/extend/mcp)と、一回目の実SDKで未指定ツールの承認要求が拒否された再現結果。二回目は同threadのwork/commit/push、内容・親・remote SHA・再送一回性が成功した。

現在の標準検証はcodex-tasks 8件とkanban 45件＋Web18件が成功。runner75件、DS32件、登録/upgrade4件、SDK/card結合4件、旧adapter13件も成功。ブラウザGit操作、unknownの照合、過去の活動、実Eumenes APIの復元・通し受入が残る。旧孤児停止試験の失敗は保持し、管理対象終了を全daemon不存在の証明と混同しない。

画面反映の追加検証では、同じactive receiptの再採用を省略し、終端・停止要求の採用は維持した。結合5件とブラウザ連続3回が成功した。Gitの既存制約は、phaseの共通検証で接続する。既存hooks・署名設定を迂回する必要がある場合はBlockerとし、設定を変更しない。認証用Git設定を含めた実際のfetch/push URLも登録先と照合する。push対象の親がremoteの確認済みHEADと異なれば、他commitをまとめて送ることになるため拒否する。既に対象SHAがremoteにある場合は読取り確認だけを返す。根拠は[Git hooks仕様](https://git-scm.com/docs/githooks)と[Git設定のURL書換え仕様](https://git-scm.com/docs/git-config)。これらは語句や依頼内容による分岐ではなく、UIで許可した送信先・変更範囲を守るためのGit契約検証である。
