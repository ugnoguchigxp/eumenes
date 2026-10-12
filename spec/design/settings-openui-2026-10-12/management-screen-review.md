# 予約・委任作業画面の調査

2026年10月12日。Astraの対象ソース読取と親の確認に基づく。今回の変更は設計文書と画像のみ。

予約画面は今回の設定案から除外する。scheduler一覧は用途を限定せず、画面はactive/pausedの全予定へ停止・取消を表示する。内部タイマーと委任作業監視を所有domain以外から止め得るため、利用者向け管理画面として完成と評価しない。作成再試行が新しいrequestIdになる問題、target_failedでも一回予定がcompletedになり、旧nextDueを「次回」と表示する問題もある。

基盤には単一writer transaction、requestIdの冪等性、revision、遅延のcoalesce/skip、重複発火の抑制、容量不足時の再試行がある。取消は今後の受付を止め、受付済みジョブを止めない。一回と固定時間間隔に対応するが、地域別カレンダー予約ではない。backendは内部用途にも必要なので削除しない。

委任作業はtasks domainの保存・開始・停止・質問回答・忘却とQueue/Schedulerへの接続がある。一方、coding実行にはunavailableCodingWorkflowが接続され、実CLI・live・実機器の受入済み根拠はない。基盤実装の存在と製品機能の完成を区別する。Projectと委任作業の画面は後日検討する。

根拠：api/domains/scheduler/service/index.ts、同repository/index.ts、web/src/domains/settings/sections/schedule.tsx、api/domains/timers/service/index.ts、api/application/delegated-tasks.ts、api/application/server.ts、api/application/coding-supervision.ts、api/domains/tasks/service/index.ts、spec/verification/delegated-coding/README.md、docs/dots.md。

既存scheduler fixtureの確認をbun run verify -- --domain schedulerで試みたが、別の検証が実行中というロックで開始されず終了コード3となった。ロックを解除せず、今回の試験は未実行として記録する。既存試験ソースの読取を試験成功と扱わない。今回は製品変更がないため、結合・実プロセス再起動・実際のジョブ完了を含む通し試験は行っていない。
