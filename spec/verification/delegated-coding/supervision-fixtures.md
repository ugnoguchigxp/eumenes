# 計画03 監督・報告台帳のfixture検証

2026-10-10 JST。参照HEAD: `ff2b237310075bb2eb9e337412fc1205c089b165`。この時点の計画02基盤と今回の計画03は作業ツリーにあり、commit/pushはまだ行っていない。並行作業の変更・ステージングは保持した。

## 対象と結果

| 対象 | 結果 |
| --- | --- |
| coding-supervision | 23件成功。境界・整形・lint・型閉包・source hashを含むdomain verify成功 |
| task-reports | 3件成功。domain verify成功 |
| inference | 27件成功。うち背景captureの新規2件。domain verify成功 |
| tasks | 28件成功。domain verify成功 |
| scheduler | 11件成功。domain verify成功 |
| application監督結合 | 3件成功。毎分監視、共有推論枠の解放、認証HTTP/clientを確認 |
| 関連回帰 | 18ファイル・168件成功、0失敗、920 assertions。監督/報告/inference/tasks/Queue/Schedulerとcoding/delegated/migrationの結合を含む |
| 全体型検査・変更範囲lint・差分検査 | 成功 |
| Queue/domain verify | 別変更の `api/domains/queue/service/runner.ts` の整形違反で停止。Queue試験は関連回帰で成功 |
| dialogue/domain verify | 別変更の `api/domains/dialogue/service/timer-phrase.ts` の整形違反で停止 |
| verify:all | 別変更7ファイルの整形違反で停止。全体ゲート通過とは記録しない |

最終監督domain verifyのsource hash: `951ce3a2343ac15fa49015beeee8219454eb965a9de851d4e83d3dbd936f0a22`。

## 主な受入証拠

- 実行中の無出力を60 tick確認してもLLMを呼ばず、完了・失敗を断定しない。終了済みの同一観測も一度しか判断しない。
- 検証→別sessionのread-only review→許可されたcommit/push→完了報告を模擬ワーカーで通した。最終reportのGit SHA/branch/remoteはhost receiptから構成する。
- コードsnapshot、質問、権限、実行世代、task revisionが変わると古い判断・工程receiptを採用しない。モデル応答後の新しい読取りで外部のsnapshot変更も検出する。
- 子プロセス残存・証拠未完了・CLIの偽の完了文面を完了条件にしない。自己レビュー、チェックの削除、定義digestの変更、push SHAの不一致を拒否する。
- 修正は2回。同じブロッカーは質問IDを変えても自動回答1回。判断回数は保存され、JSON修復の判断も消費する。
- 不正JSONの修復は一度。元の30秒期限を共有する。開始前の判断期限切れでも操作を起動しない。
- tokenizer未接続・入力12,000 token超過でモデルを呼ばない。文字数をtoken数として扱わない。
- 2回の読取り失敗・150秒の途絶を監視遅延とし、CLI失敗と区別する。再観測が成功すれば監視遅延を解消する。
- 前景と同じ物理推論枠を使用し、CLI工程の待機中に前景jobが進む。取消済み・古い判断はモデル応答が届いても後続操作を作らない。
- 元の会話requestが取消・期限切れでも有効なtaskの背景requestは独立期限で動く。現在設定の変更やtask取消は採用を止める。
- 未確定の外部操作は再起動で自動再送しない。保存済みoperation IDと `outcome_unknown` を保持する。
- 不変report、sequence、outboxを同時保存し、rollbackで片側だけ残さない。解決済み質問のreportの再追加も同一receiptを返し、古い通知を再配送しない。
- task忘却で監督文脈・報告を削除する。HTTPは認証・origin検査を通し、CLI本文やprivate sessionをsupervisor DTOへ出さない。削除済みの読取りは410。

モデルはfixture LARM port、操作はfixture WorkflowPortを使用した。固定入力token値は予算分岐を確認するための値で、実モデルの計測結果ではない。プロンプトの信頼境界とhostの拒否は検証したが、実モデルが常に指示に従うことは検証していない。

## 実行した検証

```sh
bun run verify -- --domain coding-supervision
bun run verify -- --domain task-reports
bun run verify -- --domain inference
bun run verify -- --domain tasks
bun run verify -- --domain scheduler
bun run verify -- --domain queue
bun run verify -- --domain dialogue
bun run verify:all
bun x tsc --noEmit --pretty false
bun test api/domains/coding-supervision/test api/application/coding-supervision.test.ts api/domains/task-reports/test api/domains/inference/test api/domains/tasks/test api/domains/queue/test api/domains/scheduler/test api/application/coding-tasks.test.ts api/application/coding-http.test.ts api/application/delegated-tasks.test.ts api/application/migrations.test.ts
```

全体整形違反は `api/application/timer-toolchain.test.ts`、`api/application/toolchain.fixture.ts`、`api/domains/capabilities/builtin/timers.ts`、`api/domains/capabilities/contracts/index.ts`、`api/domains/dialogue/service/timer-phrase.ts`、`api/domains/queue/service/runner.ts`、`tests/browser/timers.spec.ts`。今回の実装開始前からある別作業のファイルなので変更していない。

## 未受入

本番runnerの隔離、計画02 C6の固定check/review/Git操作ワーカー、採用モデルのtokenizerが未接続。本番は無効のまま。実CLIの認証済み実行、実Git remote、実LARMの判断品質・速度・費用は未測定。

計画04の会話受付・配達・既読・音声、計画05のtask menu/モーダルは未実装。独立した文脈と履歴の保存、APIでの報告参照までを今回の検証範囲とする。全体受入A1〜A10や音声MVPの完成は宣言しない。
