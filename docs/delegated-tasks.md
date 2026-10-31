# 委任タスクの基盤

タスク保存・HTTP API・共通client・CLIを提供する。実行を持つ種別は dots 連携の `orchestration` だけで、Codex は [Codex SDK runner](coding-runner.md)（Kanbanの実行者 `codex`）、Claude Code は [terminals](terminals.md) と [Kanban](kanban.md) が扱い、この基盤の外にある。Codex CLI を直接起動する旧ランナーと監督推論は2026-10-31に削除した。

## 保存と状態

`tasks` domainが `work_tasks`、委任の履歴、操作の受付、状態イベント、質問と回答、実行基盤への参照を所有する。内部調査の `agent_tasks` とは別の台帳で、通常会話のrunが終わっても保持する。種別（kind）の実行は種別ごとの定義が持ち、`api/application/server-tasks.ts` が dots の種別を渡して `createTasks` を構成する。

開始時は種別の利用可能性を検査する。利用できない種別では開始が `task_execution_unavailable`（503）になるが、登録のみ・照会・停止・忘却は使える。工程・状態・権限の版・実行世代を別に管理し、古い判断と回答を拒否する。

## HTTP API

全操作は既存のloopback API認証とOrigin検査を使う。ownerや会話の出所をクライアントが指定することはできない。会話から登録するときは、applicationが保存済みユーザー入力を確認してtrusted contextを注入する入口を利用する。

| 操作 | 内容 |
| --- | --- |
| `POST /api/tasks` | kind=`orchestration`、version=`1`、requestId、タイトル、依頼、完了条件、startMode、grantで登録 |
| `GET /api/tasks` | state、conversationId、cursor、limitで一覧を取得。既定50件、最大100件 |
| `GET /api/tasks/:id` | タスク、現在の質問、使用可能な操作。実行・監督・報告の投影は常にnull |
| `GET /api/tasks/:id/events` | task内の単調sequence以降のイベントとnextCursor。履歴期限切れはhistoryExpiredで明示 |
| `POST /api/tasks/:id/start` | requestIdとexpectedRevisionで開始・再開 |
| `POST /api/tasks/:id/amend` | requestId、expectedRevision、grantで委任を更新。稼働中の更新は先に停止・保留へ進む |
| `POST /api/tasks/:id/answers` | requestId、expectedRevision、questionId、answer。選択式は提示された選択肢だけを受け付ける |
| `POST /api/tasks/:id/stop` | requestId、expectedRevision、intent=`pause/cancel`。停止の受付と確認を区別 |
| `POST /api/tasks/:id/forget` | requestId、expectedRevision。委任を撤回し、依頼・質問・回答・委任の出所履歴を論理削除 |

変更操作は `{taskId,state,revision,authorityEpoch,executionGeneration}` の受付receiptを返す。同じrequestId・同じ入力の再送は元のreceiptを返すため、最新の状態はGETで確認する。同じrequestIdで異なる入力・操作を送ると409になる。別のrequestIdなら同じ文章でも別タスクになり得る。会話上の一つの操作は出所にも一意制約を持つ。

入力上限はタイトル120文字、依頼32 KiB、完了条件20項目（各1 KiB）、回答8 KiB。grantにはconnectionRef、projectRef、sessionRefs、maxSessions、許可操作、期限、実行予算、報告間隔を持つ。amendでconnectionRefとprojectRefは変更できない。

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
  "kind": "orchestration",
  "version": 1,
  "title": "一覧画面を修正",
  "request": "指定した一覧画面の表示を修正する",
  "completionConditions": ["指定した検証が成功する"],
  "startMode": "register_only",
  "grant": {
    "connectionRef": "connection-id",
    "projectRef": "project-id",
    "operations": ["read", "edit", "check"],
    "expiresAt": "2026-12-01T00:00:00Z"
  }
}
```

`--wait`はtasksでは受け付けない。終了・通信切断・別の会話の取消をタスクの取消へ変換しない。`--json`のstdoutは結果JSONのみで、APIエラーと `X-Request-Id` はstderrに出す。

## 停止・復旧・保持

初回開始時に実行期限を固定する（既定2時間、上限2時間）。pause/resumeで期限は延長しない。利用者がamendで実行予算を明示変更した場合だけ、最初の開始時刻を基準に期限を変更する。変更後の予算が既に経過していれば取消を要求する。委任期限と実行期限のどちらかに達すると、新しい判断・操作を即時拒否し、保守で停止を要求する。pauseの停止確認を待つ間に期限切れになった場合も、最終状態はcancelledになる。

取消・委任変更はepochを更新して古い処理を失効させ、停止を確認するまでstoppingを保つ。実行を開始していない登録・停止確認済みのpausedタスクは外部プロセスがないため、同じtransaction内で停止確認できる。この場合も停止の受付receiptはstoppingで、GETには確認済みの状態が返る。

起動時はtasksを照合する。実行の受領記録がないため、開始済みのqueued/active（dotsの回答待ちを除くwaiting_user）をreconcilingへ移し、実装・pushを自動再送しない。

終端から7日で依頼本文・完了条件・質問回答・過去の委任履歴を回収し、bodyExpiredを表示する。30日で実行基盤への参照と古い状態履歴を回収し、metadataExpiredを表示する。タイトル、最終結果、既に起きた副作用の参照、最終イベントは残す。重複防止に必要な入力digestと小さいreceiptも残し、期限後の再送で処理を復活させない。

forgetはこれを待たずに本文・タイトル・質問回答・会話との対応を削除する。forgottenAtを記録し、後続の報告配送はこれを抑止条件に使う。取消でファイル変更やpushを巻き戻さず、既に行われた副作用の識別と停止照合に必要なmetadataは保持する。論理削除であり、SQLite/WALやバックアップからの物理消去を保証するものではない。

既定の受付容量はlive256件、総数4096件、作業台帳32 MiB。新規登録だけでなく、開始、権限の拡張、質問回答などで台帳の上限を超える場合もtransactionごとrollbackし、429で拒否する。停止・忘却・終端・照合記録は、作業を安全に止めるため上限時も保存する。保留・照合中の記録を勝手に消さない。通常ログには本文を渡さず、workTaskIdと受付状態を記録する。

## 検証

タスク単体は `bun run verify -- --domain tasks`、Scheduler公開操作の変更は `--domain scheduler`、利用するQueueは `--domain queue` を確認する。HTTP・共通client・CLIの結合試験は `bun test api/application/work/tasks-http.test.ts`。横断変更は影響のある利用側domainも選んでverifyする。

[検証記録](../spec/verification/delegated-coding/README.md)でfixture、live、実機器を分ける。fixtureの成功を、実機器の受入とは扱わない。
