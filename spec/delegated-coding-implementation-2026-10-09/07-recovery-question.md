# 監督打切り後の復旧質問と回答の実装計画

作成日: 2026-10-10 JST。状態: 設計案・実装前。[計画06](06-agent-observation-contract.md)の旧7.3後半・7.4・A24から分離した。計画06が実装済みであることを前提とし、計画06の受入はこの計画に依存しない。fixture/live受入は未実施。

## 1 目的と範囲

計画06は、正式失敗/矛盾終端、process終了後のturn未確認、回復不能な整合性障害、legacy continue拒否で進めない場合に、hold・blocker報告で止まる。本書はそこから、ユーザーが「中止」または「新しい世代でやり直す」を選べるようにする。

- 追加するもの: 固定選択肢の復旧質問、回答の分類、tasks所有の中止・新世代再開の遷移。
- 追加しないもの: 失敗後の自動修復worker、成果物参照を渡す新しいprepare契約、旧CLI sessionの継続。

## 2 現行の前提

- 承認ゲート（SEC-11）: `approval.ts`がquestionIdを`Supervisor.pendingApproval`へ保存し、applicationの`prepareInTransaction`/`dispatch`が`isApprovalAnswer(InTransaction)`で照合して回答をCLIへ流さない。回答はtasks.answerの通常経路を通る。
- `tasks.answerInTransaction`（`api/domains/tasks/service/progress.ts`）は、revision・currentGrant・open questionの検査後に`kind.available()`を要求し、世代を増やさずstateをqueuedにしてanswer hookを同期で呼ぶ。answer hookは同じtransaction内でdispatchとprepareを行う。coding-tasksは、answerQuestionIdがあると回答文章をcontinue命令へ変換する。
- 既存`escalate`（`holds.ts`）は停止確認後に自由入力の質問を出す。この回答はcontinueになる。
- 既存`startTask`はregistered/paused専用で、authorityEpochを増やさない。

承認と同じapplication層の分岐だけでは足りない。中止はavailable=falseでも受け付け、再開はepoch/generationを進める必要があるため、`kind.available()`検査より前にtasksが分類を知る必要がある。

## 3 質問の契機と内容

計画06の打切り条件で、**process停止確認済み かつ（診断上限到達 または 回復不能/続行非対応の確定）**をhost側の質問契機とする。taskが有効・未取消であることを再検査し、blocker報告と既存tasks質問を一回だけ作る。

- 選択肢の文字列は本節を正本として「中止」「作業領域の現状から、新しい世代で実装・検証をやり直す」に固定し、定数としてcontractsに置く。他の経路も同じ定数を使う。
- 現状には未検証の変更も含まれること、確認済み範囲・未検証範囲・権限・残予算を質問へ添える。
- task/execution/generation/authorityと阻害状態をdedupe keyに保存する。異常codeが交互に変わっても、同じ阻害状態では再質問しない。
- 既に未回答の質問（承認質問を含む）がある場合は重ねない。取消・期限切れ時は新しい質問を作らず、最終の確認範囲を報告する。
- 停止未確認の間は、計画06どおり不足報告と停止監視を続ける。

## 4 監督質問の記録を承認と共通化する

承認と復旧で別々の照合機構を作らない。`Supervisor.pendingApproval`を一般化した監督質問記録へ、questionId・`purpose: "approval" | "recovery"`・対象execution/generation/authorityを保存する。recoveryの場合は、阻害状態と停止証拠参照も保存する。既存の承認のdecision・意味digest・resolutionはapprovalの場合だけ持つ。

- 文言からpurposeを判定しない。
- 既存の承認データはnamed migrationでpurpose=approvalへ読み替え、承認の挙動・`approvalView`の公開形式を変えない。
- `isApprovalAnswer(InTransaction)`は、purpose=approvalの照合として維持する。

## 5 回答分類port

applicationが登録する同期の回答分類portをTasksの公開契約へ追加する。tasks.answerInTransactionは、requestIdによるonce、revision、open question、task/epoch/generation一致、choiceの検査を先に行う。そのうえで、`kind.available()`とcurrentGrant検査・answer hookより前にこのportを呼ぶ。

- 返却は`ordinary / cancel / restart`の閉じた契約とする。下位tasksはsupervisionをimportせず、portは外部I/Oをtransactionに入れない。
- applicationは監督質問記録をsupervisionの公開読取りで照合する。purpose=approvalと記録のない質問はordinary（既存経路のまま）。
- purpose=recoveryなのに照合できない場合は、固定codeで拒否する。ordinaryへfallbackしない。

### 5.1 cancel

- tasksは既存の取消操作へ分岐する。実行available・通常回答用のcurrentGrantを要求せず、既存取消と同じ停止照合・権限epoch失効を使う。
- 質問をanswered（answer/answeredFromを含む）として先に保存してから、既存stopTaskを呼ぶ。取消intentは同じwriter transactionへ保存する。
- openQuestionをsupersededにする既存取消処理で、回答済みの記録を上書きしない。
- CLIのprepare/continue/startは0回。

### 5.2 restart

- application portは、旧実行のprocess停止を公開証拠で再確認する。Tasksはgrant期限・残予算・実行availableを検査する。
- tasks所有の復旧遷移の入口条件は、waiting_user・recovery分類・停止確認済みとする。
- 質問をanswered（answer/answeredFromを含む、元の質問fenceは保持）として保存し、authorityEpochを一度だけ+1にする。
- そのうえで、startTaskと共通化した開始本体（generation+1、deadline維持、queued、start hook）を使う。通常startのregistered/paused検査とphase維持規則は変更しない。
- 復旧restartではtask.phaseをpreparingへ戻し、旧工程の成功判定を使わず、新世代の実装・検証を開始する。task期限とtask全体の消費予算はリセットしない。
- start hookにanswerQuestionIdを渡さず、新しいimplementをprepareする。prepare入力はinstruction=t.request、kind=implement、previousExecutionIdなし。
- 「作業領域の現状から」は、同じgrantのworkspace現状を新しい実行でも使い、task-reportsのevidenceRefsで確認済み範囲を示すことに限る。旧CLI sessionや成功判定は引き継がず、現状の読取りと検証をやり直す。
- 停止receiptの採用で既存reservationが解放された後に新しい予約を取得し、workspace reservation・隔離・権限の既存gateを通す。

### 5.3 失敗と競合

- restartのgate/prepareが失敗したら、transaction全体をrollbackする。質問は未回答のまま、不足理由を別の既存報告経路へ渡す。
- available=falseでもcancel回答は受け付ける。
- 二重回答・取消競合・古いquestion/fenceは、新しいdispatchを作らない。取消済みtaskへの回答は、通常の状態競合として拒否する。
- 新しい世代の操作workerが未配備なら、restartは拒否したままとする。回答の受付を、本番実行可否の解除にしない。

担当: 復旧遷移・質問状態・世代管理の実装と試験はtasks domain。質問purposeの記録と停止証拠の照合はsupervision/codingの公開操作。port結合とprepareへの分岐はapplication。

## 6 受入試験

| ID・ケース | assert |
| --- | --- |
| R1 打切り後の質問 | 停止確認と上限/回復不能の確定を根拠に、blockerと質問を一件。choicesは3節の定数と完全一致し、未検証の変更を含むことと確認範囲を添える。同じ阻害状態や交互の異常codeで再質問せず、未停止/取消/期限切れでは質問を作らない。承認質問が未回答なら重ねない |
| R2 cancel | v1/v2とも、prepare/start/continueは0回。質問はstate=answered、answer=「中止」、answeredFromを保持。taskはstoppingから既存の停止照合でcancelledへ進む。available=falseでも受け付ける |
| R3 restart | authorityEpochとexecutionGenerationは各+1ちょうど。executionDeadlineAtとtask全体の消費予算は維持。質問はanswered/answer/answeredFromを保持し、task.phase=preparing。prepare入力はkind=implement、instruction=t.request、previousExecutionId/answerQuestionIdなし。continueは0回。同じworkspaceを再予約し、予約競合・未解放ならrollbackし、質問は未回答のまま |
| R4 再送・競合 | 同じrequestIdの再送・取消競合・古い質問で、追加dispatchは0回。purpose=recoveryで照合できない回答は固定codeで拒否し、ordinaryにしない |
| R5 回帰 | 承認回答（承認/却下）・通常の自由入力回答・通常start/resumeのregistered/paused制約とphase維持が従来どおり。既存の承認データがmigration後もpurpose=approvalとして解決できる |

試験の置き場所は、tasksの遷移が`api/domains/tasks/test/tasks.test.ts`、結合が`api/application/delegated-tasks.test.ts`・`coding-tasks.test.ts`・`coding-supervision.test.ts`。

```sh
bun run verify -- --domain tasks
bun run verify -- --domain coding-supervision
bun run verify:all
```

実装開始前に、計画06と同じ条件（重大・中の未処置指摘0件、軽微も採否記録済み）でレビューする。
