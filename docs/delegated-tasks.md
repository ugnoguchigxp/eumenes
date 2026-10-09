# 委任タスクの基盤

2026-10-09時点で、実装計画01のタスク保存・HTTP API・共通client・CLIを提供する。CLI runner、監督推論、会話からの自動委任・報告、Kanbanモーダルは計画02〜05の後続実装である。

## 保存と状態

`tasks` domainが `work_tasks`、委任の履歴、操作の受付、状態イベント、質問と回答、実行基盤への参照を所有する。内部調査の `agent_tasks` とは別の台帳で、通常会話のrunが終わっても保持する。Queue/Schedulerへの結合は `api/application/delegated-tasks.ts` で公開操作を一つのwriter transactionへ組み合わせる。

登録のみではジョブ・Scheduleを作らない。開始時は実行portの利用可能性を検査し、タスク・最初の処理・毎分のScheduleを同時保存する。Queue側の処理完了はタスク全体の完了ではない。工程・状態・権限の版・実行世代を別に管理し、古い判断と回答を拒否する。

`EUMENES_DELEGATED_TASKS_ENABLED` は既定 `0`。`0/1` 以外は起動エラーになる。現在のproductionには実CLIのportを接続していないため、`1` にしても開始は `task_execution_unavailable`（503）になる。登録のみ・照会・停止・忘却は利用できる。実行portのfixtureが実CLIの代わりに接続されるのは試験内だけである。

## HTTP API

全操作は既存のloopback API認証とOrigin検査を使う。ownerや会話の出所をクライアントが指定することはできない。会話から登録するときは、applicationが保存済みユーザー入力を確認してtrusted contextを注入する入口を利用する（会話側の接続は計画04）。

| 操作 | 内容 |
| --- | --- |
| `POST /api/tasks` | kind=`coding`、version=`1`、requestId、タイトル、依頼、完了条件、startMode、grantで登録 |
| `GET /api/tasks` | state、conversationId、cursor、limitで一覧を取得。既定50件、最大100件 |
| `GET /api/tasks/:id` | タスク、現在の質問、使用可能な操作。実行・監督・報告の投影は現在null |
| `GET /api/tasks/:id/events` | task内の単調sequence以降のイベントとnextCursor。履歴期限切れはhistoryExpiredで明示 |
| `POST /api/tasks/:id/start` | requestIdとexpectedRevisionで開始・再開 |
| `POST /api/tasks/:id/amend` | requestId、expectedRevision、grantで委任を更新。稼働中の更新は先に停止・保留へ進む |
| `POST /api/tasks/:id/answers` | requestId、expectedRevision、questionId、answer。選択式は提示された選択肢だけを受け付ける |
| `POST /api/tasks/:id/stop` | requestId、expectedRevision、intent=`pause/cancel`。停止の受付と確認を区別 |
| `POST /api/tasks/:id/forget` | requestId、expectedRevision。委任を撤回し、依頼・質問・回答・委任の出所履歴を論理削除 |

変更操作は `{taskId,state,revision,authorityEpoch,executionGeneration}` の受付receiptを返す。同じrequestId・同じ入力の再送は元のreceiptを返すため、最新の状態はGETで確認する。同じrequestIdで異なる入力・操作を送ると409になる。別のrequestIdなら同じ文章でも別タスクになり得る。会話上の一つの操作は出所にも一意制約を持つ。

入力上限はタイトル120文字、依頼32 KiB、完了条件20項目（各1 KiB）、回答8 KiB。grantにはworkspaceId、許可操作、branch/remote、network、期限、実行予算、報告間隔を持つ。pushはcommit権限とbranch/remoteの指定を必要とする。workspaceの実在・Gitの安全性・CLIの権限制御は計画02で実行port側に実装する。

## CLI

既存の内部調査の `task` コマンドと区別し、永続タスクは複数形の `tasks` を使う。全操作は共通clientからHTTPを呼び、DBを直接開かない。

```sh
bun run cli tasks create task.json --json
bun run cli tasks list --json
bun run cli tasks show <taskId> --json
bun run cli tasks events <taskId> 0 --json
bun run cli tasks start <taskId> <revision> --request-id <UUID> --json
bun run cli tasks stop <taskId> <revision> cancel --request-id <UUID> --json
bun run cli tasks answer <taskId> <revision> <questionId> "回答" --json
bun run cli tasks amend <taskId> <revision> grant.json --json
bun run cli tasks forget <taskId> <revision> --json
```

createのファイルには次の形式を使う。expiresAtは未来の時刻に設定する。requestIdをファイルまたは `--request-id` で固定すると、同じ操作を安全に再送できる。操作時のrevisionはshowで確認する。更新APIの失敗時は、CLIが使用したrequestIdを標準エラーへ出力する。通信が途切れた場合は保存済み状態を確認し、再送するなら同じrequestIdと入力を使う。

```json
{
  "requestId": "00000000-0000-4000-8000-000000000001",
  "kind": "coding",
  "version": 1,
  "title": "一覧画面を修正",
  "request": "指定した一覧画面の表示を修正する",
  "completionConditions": ["指定した検証が成功する"],
  "startMode": "register_only",
  "grant": {
    "workspaceId": "workspace-id",
    "operations": ["read", "edit", "check", "review"],
    "network": "none",
    "expiresAt": "2026-12-01T00:00:00Z"
  }
}
```

`--wait`はtasksでは受け付けない。終了・通信切断・別の会話の取消をタスクの取消へ変換しない。`--json`のstdoutは結果JSONのみで、APIエラーと `X-Request-Id` はstderrに出す。

## 停止・復旧・保持

初回開始時に実行期限を固定する（既定2時間、上限2時間）。pause/resumeで期限は延長しない。利用者がamendで実行予算を明示変更した場合だけ、最初の開始時刻を基準に期限を変更する。変更後の予算が既に経過していれば取消を要求する。委任期限と実行期限のどちらかに達すると、新しい判断・操作を即時拒否し、毎分の保守で停止を要求する。pauseの停止確認を待つ間に期限切れになった場合も、最終状態はcancelledになる。

取消・委任変更はepochを更新して古い処理を失効させ、停止を確認するまでstoppingを保つ。実行を開始していない登録・停止確認済みのpausedタスクは外部プロセスがないため、同じtransaction内で停止確認できる。この場合も停止の受付receiptはstoppingで、GETには確認済みの状態が返る。Queue満杯時も停止の意図を保存する。停止配送が失敗・中断・取消になった場合も、最短60秒後に保守が再配送する。配送jobが変わってもstopのcommandIdは維持するため、実行portは同じ停止操作として照合する。開始・実装・pushの自動再送にはこの仕組みを使わない。

起動時はQueue復旧の後、tasksを照合する。runner receiptがまだない現段階では、開始済みのqueued/active/waiting_userをreconcilingへ移し、古いdispatchとScheduleを無効化する。実装・pushを自動再送しない。実CLIとの照合は計画02で接続する。

開始直前に実行portが利用不能になった場合、dispatchの準備に失敗した場合、汎用Queueからdispatchを取り消した場合もreconcilingへ移し、監視を無効化する。ジョブが消えたqueuedを残さない。タスクの監視Scheduleは着手transactionだけで登録し、汎用Scheduler APIから重複・置換を作らせない。

終端から7日で依頼本文・完了条件・質問回答・過去の委任履歴を回収し、bodyExpiredを表示する。30日で実行基盤への参照と古い状態履歴を回収し、metadataExpiredを表示する。タイトル、最終結果、既に起きた副作用の参照、最終イベントは残す。重複防止に必要な入力digestと小さいreceiptも残し、期限後の再送で処理を復活させない。

forgetはこれを待たずに本文・タイトル・質問回答・会話との対応を削除する。forgottenAtを記録し、後続の報告配送はこれを抑止条件に使う。取消でファイル変更やpushを巻き戻さず、既に行われた副作用の識別と停止照合に必要なmetadataは保持する。論理削除であり、SQLite/WALやバックアップからの物理消去を保証するものではない。

既定の受付容量はlive256件、総数4096件、作業台帳32 MiB。新規登録だけでなく、開始、権限の拡張、質問回答などで台帳の上限を超える場合もtransactionごとrollbackし、429で拒否する。対象を変えずに許可操作・ネットワーク・期限・予算を縮小する変更、停止・忘却・終端・照合記録は、作業を安全に止めるため上限時も保存する。保留・照合中の記録を勝手に消さない。通常ログには本文を渡さず、workTaskIdと受付状態を記録する。

## 検証

タスク単体は `bun run verify -- --domain tasks`、Scheduler公開操作の変更は `--domain scheduler`、利用するQueueは `--domain queue` を確認する。結合試験は `bun test api/application/delegated-tasks.test.ts`。横断の最終確認は `bun run verify:all`。

[検証記録](../spec/verification/delegated-coding/README.md)でfixture、live、実機器を分ける。現在のfixture成功を、CLI実行・監督・音声の製品受入とは扱わない。
