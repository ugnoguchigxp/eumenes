# 計画01のコードレビューと修正

2026-10-09 JST。対象は `tasks` domain、applicationのQueue/Scheduler結合、HTTP/client/CLIと、計画01で追加した公開操作。実CLI、監督推論、会話配送、Kanbanは計画02以降の対象。並行作業中のWorld・Research Routesなどの変更は修正対象に含めない。

レビュー前は関連31件が成功していた。最初の再現試験では既存31件が成功し、新規8件が失敗した。修正後に停止・復旧・容量・入力契約を再レビューし、追加の回帰試験を含めた49件（tasks 28件、application 21件）が成功した。

## 修正した指摘

| 優先度 | 問題と影響 | 修正・検証 |
| --- | --- | --- |
| P1 | 停止jobが失敗すると同じ冪等受付の終端jobが返り続け、stoppingから進まない | 同じ外部commandIdで停止配送だけを最短60秒後に再試行。復旧後・二重保守でも配送を重複させず、確認後のみcancelledへ |
| P1 | maxRuntimeMsの明示変更が実際の期限に反映されない | 初回開始時刻からの予算として期限を更新。経過時間未満へ縮小したら取消。pause/resumeでは延長しない |
| P1 | 開始直前の接続喪失、準備失敗、汎用Queueでのdispatch取消がジョブのないqueuedを残す | reconcilingへ移し監視を無効化。実装を自動再送しない |
| P2 | 停止確認済みpausedの期限切れにも外部停止確認を要求する。停止待ちpauseの期限切れ後もpausedを確定できる | 確認済み停止は同じtransaction内でcancelledへ。停止待ち中の失効はcancelへ引き上げ、遅い確認でも再開可能な状態にしない |
| P2 | 汎用Schedulerから監視を重複登録でき、元のSchedule取消後は置換もできる | タスク着手中の同期登録だけを許可。正常な開始・再開は既存の同時保存試験で確認 |
| P2 | HTTP本文を全て読み終わってから64 KiBを確認する | 共通のreadBoundedで読み込み途中に拒否し、streamをcancel。送信完了前の413と登録0件を確認 |
| P2 | 新規登録にしか容量上限がなく、既存タスクのgrant・質問・受付履歴が上限を超える | 保存後の容量検査をtransaction内で行い、質問と状態を一緒にrollback。権限縮小・取消・忘却・終端・照合は容量時も許可 |
| P2 | 実行時の不正なanswerTypeが保存され、clientで読めない質問になる | 質問入力をstrict schemaで検証。trim後の選択肢・重複も同じ契約で確認 |
| P2 | portのtruthyな不正値を停止成功と誤認できる | accepted/stoppedはbooleanのtrueだけを採用。不正な停止receiptはfailed/stoppingを維持 |
| P2 | Promise-likeなtransaction callbackを拒否できない | native Promise以外も検査し、task・grant・受付のrollbackを確認 |
| P3 | 公開listがHTTPでは拒否する指数表記などのcursorを受け付ける | 十進整数の契約に統一 |
| P3 | 使用可能操作が未提供の回答能力や失効した実行予算と一致しない。client入力で既定値の省略を型で許さない | 操作表示を業務条件に合わせ、clientは入力schemaの型を使用。既定値を省略したHTTP登録を確認 |

rollback後の別transactionで、却下された委任変更が実行中dispatchをabortしないことも確認した。DBの取消記録をcommit後に再検査する既存のQueue契約を維持している。

## 再レビュー

修正後に、状態遷移、revision/authorityEpoch/実行世代、明示的な予算変更、停止再配送の外部ID、同時保存とrollback、入力・容量、保持・忘却、認証、CLIの再送IDを再確認した。対象範囲で未修正の具体的な指摘は残っていない。fixtureの成功は実CLI・Provider・実機器の受入を意味しない。

最終ゲートの結果は [fixtures.md](fixtures.md) に記録する。全体検証に並行作業の失敗や検証中のソース変更が含まれる場合は、関連試験の成功とは分けて扱う。
