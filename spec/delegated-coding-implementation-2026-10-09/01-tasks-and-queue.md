# 永続タスクと Queue 連携の実装計画

作成日: 2026-10-09 JST。状態: タスク基盤を実装済み。fixture検証済み。CLI runner・監督・会話報告・モーダルは後続計画。[全体計画](README.md) の P0〜P3 を中心に担当する。本書がユーザー向けタスクの状態、ID、版、公開操作の正本。

## 1 目的と所有

会話で依頼した仕事を、会話の一回の応答より長く保持する。新規 `tasks` domain が登録情報と業務状態を所有し、既存 Queue は処理の実行、Scheduler は時刻を所有する。Queue の `completed` を業務タスクの完了として表示しない。

`agent-runtime` の内部 `agent_tasks` は短い推論・調査の台帳として残す。新テーブルは `work_tasks` とし、内部 task と混同しない。コード・API では文脈が明確な `WorkTask`、ログでは `workTaskId` を使う。

## 2 ID と状態

| 識別子 | 意味 |
| --- | --- |
| `taskId` | ユーザーの一件の依頼。続行・修正・複数実行を通じて維持 |
| `requestId` | API/ツール操作の冪等キー。同じキーで異なる内容は conflict |
| `executionId` | runner に依頼する一回の実行。CLI session ID とは別 |
| `decisionId` | 監督の一回の判断。参照した観測と採用結果を追跡 |
| `jobId` | Queue 上の一回の処理。task に複数件紐づく |
| `reportId / questionId` | 会話報告・回答待ちの識別子 |
| `originConversationId / originMessageId / originRunId` | 依頼の出所。親 run の取消を自動伝播するための ID ではない |

タスク状態は `registered / queued / active / waiting_user / paused / reconciling / stopping / completed / failed / cancelled`。正常系は登録→待機→実行→完了。登録のみなら `registered`、着手まで依頼された場合は一つの transaction で `queued` にする。

| 状態 | 意味と許可操作 |
| --- | --- |
| registered | 有効な依頼を保存済み。開始・編集・取消が可能 |
| queued | 開始条件・実行枠を待機。取消・委任範囲変更が可能 |
| active | 実行、検証、レビュー、修正、Git 操作の途中 |
| waiting_user | 現在有効な質問への回答が必要。質問 ID と回答 schema を持つ |
| paused | 実行の停止を確認し、再開可能な状態として保持 |
| reconciling | 起動や副作用の結果が不明。照合・停止・人の判断だけを許す |
| stopping | pause/cancel の要求を受け付けたが、実行停止は未確認 |
| completed | 委任された完了条件を全て確認した状態 |
| failed | 範囲・予算内で完遂できないと確定。結果と残った変更を残す |
| cancelled | 実行停止と以後の起動禁止を確認。既に起きた副作用は残る |

工程 `phase` は kind ごとの閉じた enum で定義する。coding の初版は `preparing / implementing / verifying / reviewing / repairing / committing / pushing / finalizing`。工程とタスク状態を一つの enum に混ぜない。

CLI の稼働状態は `coding`、観測時刻・新しさは `coding-supervision` が所有する。API で合成して表示する。観測不能を task failed と直結させない。

## 3 版と権限

`revision` は利用者の変更、工程遷移、質問、結果採用など業務状態の変更で増やす。毎分の生存確認だけでは増やさない。`authorityEpoch` は委任範囲の変更・撤回・期限切れで増やす。`executionGeneration` は新しい実行系列への切替えで増やす。

判断・操作は `{taskId, expectedRevision, authorityEpoch, executionGeneration}` を束縛し、採用直前に再検査する。runner は `executionId` と authority の失効も検査する。観測イベントには独立した `eventSeq` を使う。

委任内容には元の依頼、完了条件、workspace ID、許可操作、branch・remote、ネットワーク範囲、予算、報告方針を保存する。権限の原本は実ユーザーの発話または認証済み UI 操作。モデルが生成する引数で出所や権限を捏造できないよう、application が trusted context を追加する。

利用者が実装・レビュー・push まで明示した場合は、その範囲を一度記録し、工程ごとの承認を追加しない。対象が未特定、既存の許可と矛盾する場合は開始せず確認する。モデル・CLI の出力は委任の拡張根拠にしない。

依頼本文を通常会話から削除する処理との整合も定義する。初版は「作業履歴を保持して会話表示だけを削除」と「依頼の撤回・忘却」を API で区別し、後者は権限失効・取消・未配送報告の抑止へ接続する。曖昧な UI の削除操作で処理を継続させない。

## 4 保存するデータ

すべて backend の主 DB と単一 writer で保存する。新規 migration を application の配列末尾に追加し、適用済み順序を変更しない。

| テーブル案 | 内容と制約 |
| --- | --- |
| `work_tasks` | ID、kind/version、タイトル、依頼、完了条件、出所、state/phase、revision、authorityEpoch、executionGeneration、日時 |
| `work_task_grants` | 委任の版、許可操作、対象、上限、根拠。過去版を参照可能にする |
| `work_task_commands` | requestId、入力 digest、操作種別、受付結果。scope と requestId を UNIQUE |
| `work_task_events` | 状態遷移、採用した理由コード、関連 ID。task 内の sequence を UNIQUE |
| `work_task_questions` | 質問、選択肢、回答 schema、対応する実行・版、解決状態、実回答の出所 |

時刻は UTC で保存し表示を利用者の timezone にする。依頼は最大32 KiB、タイトル120文字、回答8 KiB、完了条件20項目を初期上限案とする。上限超過は黙って切り捨てず受付エラーにする。

公開操作は `createInTransaction / requestStartInTransaction / applyTransitionInTransaction / amendGrantInTransaction / answerInTransaction / requestStopInTransaction / settleStopInTransaction` など、型付きで意味を限定する。UI が任意の `state` を PATCH する API は作らない。

## 5 登録と照会 API

`/api/tasks` は認証済みローカル利用者のタスクを返す。初版は現在の単一利用者 scope。モデルやブラウザーが owner を指定しない。

| 操作案 | 必須契約 |
| --- | --- |
| `POST /api/tasks` | requestId、kind/version、依頼、対象、完了条件、`startMode: register_only / start`、委任。出所は backend が束縛 |
| `GET /api/tasks` | state、元の会話、cursor、limit。完了済みの大量読取りを有界にする |
| `GET /api/tasks/:id` | タスク、監督 snapshot、実行要約、最新報告、使用可能な操作 |
| `GET /api/tasks/:id/events` | cursor による差分と継続 cursor |
| `POST /api/tasks/:id/start` | requestId、expectedRevision。registered/paused の必要条件を検査 |
| `POST /api/tasks/:id/amend` | requestId、expectedRevision、変更内容。実行中の範囲縮小は即時失効へ |
| `POST /api/tasks/:id/answers` | requestId、questionId、expectedRevision、answer。解決済み・別 task・古い質問は拒否 |
| `POST /api/tasks/:id/stop` | requestId、expectedRevision、`intent: pause / cancel`。まず stopping を返す |

HTTP 受付は保存済み ID と revision を返す。GET は副作用を持たず、接続確認や CLI 起動を誘発しない。競合は409、無効な入力は400系、結果不明は明示状態として扱う。API の具体的エラーコードは P0 で fixture とともに固定する。

同一 requestId の再送は元の結果を返す。別の requestId なら同文の依頼でも別タスクになり得るため、文字列類似度で勝手に統合しない。会話の同一入力から重複登録された場合は出所＋操作位置にも一意性を持たせる。

## 6 汎用 Queue と Scheduler の使い方

kind registry は静的に登録した型付き定義だけを扱う。初版は `coding.v1`。ユーザー入力に handler 名や任意コードを含めない。`api/application/delegated-tasks.ts` が、着手依頼ではタスク作成、監督登録、最初の Queue job と Schedule の作成を単一 transaction で組み立てる。登録のみでは実行・観測 job と有効な Schedule を作らず、後の開始操作で初めて作る。再開時は世代と既存 Schedule を照合し、監視を重複登録しない。

| Queue kind 案 | 所有者 | 役割と資源 |
| --- | --- | --- |
| `coding.dispatch` | coding | 保存済み実行意図を runner へ渡す。LLM 枠不要 |
| `coding.observe` | coding | 状態・新規イベントを読む。LLM 枠不要 |
| `coding.stop` | coding | 停止要求を配送・照合。新規開始の枠不足でも実行可能 |
| `coding-supervision.decide` | coding-supervision | 有界の判断一回。背景の inference 枠を使用 |
| `coding.git-operation` | coding | 委任済みの commit/push と照合。実行ごとの副作用 ID |
| `task-reports.deliver` | task-reports と application | 保存済み報告の会話配送。生成は dialogue の公開 port |

監視 target `coding-supervision.observe.v1` は60秒、coalesce、overlap skip とする。payload は taskId と世代だけで、大きい文章を持たせない。tick、CLI event、UI の最新確認は同じ pending 観測を共有する。

Queue の `concurrencyKey` はジョブ実行中だけの排他である。CLI の実行期間全体の workspace 排他は 02 の永続 reservation が所有する。観測 job に workspace 書込みのキーを付けて、実行中の観測が永久に待たされる構成にしない。

dispatch は受付結果を得たら終了し、CLI 完了まで Queue の推論枠を保持しない。別プロセス runner と永続実行参照で追跡する。stop は毎分 tick を待たず投入し、runner の期限機構も併用する。

観測の読取りは `replay_safe`、外部実行は `interrupt` を基本とする。Queue の retry を実装や push の自動やり直しに流用しない。副作用の再送可否は coding が receipt を照合して決める。

## 7 復旧と保持

起動時は新規 dispatch を止めたまま、migration、Queue lease の回収、runner receipt の照合、タスク状態の調整、未配送報告、Schedule の順に復旧する。複数 domain の復旧順は全体試験で固定し、完了後に worker を開始する。

過去の tick をすべて再実行せず、現在の一回へまとめる。停止要求・結果不明を残したまま新しい execution を起動しない。正常終了時も「停止要求」と「停止確認」を区別する。

初版は本文・証拠を含む作業資料の既定保持を終端後7日、本文を含まない実行 metadata を30日とする。task のタイトル・最終結果・commit 参照は利用者が整理するまで残し、資料の期限切れを DTO へ明示する。保留中・照合中の receipt は回収せず、容量上限時は新規受付を止める。期限値は実装前に設定契約へ固定する。

## 8 変更対象と実装順

- 新規 `api/domains/tasks/{contracts,repository,service,controller,test}/`、`index.ts`。
- 新規 `client/tasks.ts`、`client/index.ts`、製品 CLI の tasks/list/show/start/answer/stop 操作。
- `api/application/{delegated-tasks,app,server,migrations}.ts`、domain graph、ログ項目、docs。
- 既存 Queue/Scheduler は具体的な不足が証明された箇所だけ変更する。task 状態や coding の SQL を移さない。

T1: schema と状態遷移。T2: 冪等登録・公開操作・API。T3: fixture kind と Queue/Scheduler 結合。T4: 取消と復旧。T5: 保持・照会・client と UI 接続。

## 9 検証と完了条件

実装後に `bun run verify -- --domain tasks`、`--domain queue`、`--domain scheduler` を実行し、利用側追加後にその domain と `bun run verify:all` を通す。

- 同一受付100回でも task・初期 job・schedule が各一件。異なる内容の同じ requestId は conflict。
- register_only は CLI 起動0回。会話の応答終了・音声割込みで task が消えない。
- fake clock で60秒ごとの観測、長い処理の重複 skip、スリープ相当の coalesce を確認。
- 生存確認で業務 revision を増やさず、重要な状態変更では古い判断を棄却する。
- tick と回答と取消を競合させ、停止後に次工程を起動しない。
- Queue job 完了・失敗をそのまま Kanban の完了・失敗へ投影しない。
- 他 domain の SQL、Web/CLI の DB 直読、循環 import を境界試験で拒否する。

fixture が通った段階で「タスク基盤の検証済み」と記録する。実 CLI と推論の成功は 02・03 の受入結果を別記録にする。

## 10 2026-10-09の実装記録

実装: `api/domains/tasks` の保存・状態遷移・委任・質問回答・受付冪等性、`api/application/delegated-tasks.ts` のQueue/Scheduler結合、HTTP API、共通client、製品CLIを追加した。tasksは他domainをimportせず、結合は公開操作で単一writer transactionへ組み立てる。Schedulerにtransaction内の作成・照会・取消を追加し、既存の時刻・重複制御を維持した。

実行portのfixtureで開始・毎分観測・停止・復旧を確認した。現在のproductionはCLI port未接続のため、着手は503で拒否し、登録のみ・閲覧・停止・忘却を提供する。後続計画02で実CLIとGitの検証を、03で監督と観測の投影を、04で会話との委任・報告を、05でモーダルを接続する。T5のUIへの入口は共通clientとして用意した。

計画との差分として、先行する汎用結合のQueue kindを `tasks.dispatch.v1 / tasks.observe.v1 / tasks.stop.v1` とした。CLI固有の副作用・証拠は後続のcoding domainで所有し、このportを介して接続する。`POST /api/tasks/:id/forget` を追加し、会話表示の削除と委任撤回・本文忘却を混同しない。小さい冪等receiptは30日を超えても残し、再送で消した仕事を復活させない。

[利用方法](../../docs/delegated-tasks.md)、[fixture記録](../verification/delegated-coding/fixtures.md)を参照する。包括ゲートの結果は検証記録を正本とし、live・実機器は未実施。

同日のコードレビューで停止再配送、予算変更・停止待ち中の失効、開始処理の中断・取消、監視登録の所有、入力と容量の上限を修正した。関連49件とQueue/Scheduler込み91件が成功し、tasksのdomain検証も成功した。[レビュー記録](../verification/delegated-coding/review.md)に指摘・修正・再レビューを残す。並行作業中の別領域の整形・型エラーにより全体ゲートは未通過。
