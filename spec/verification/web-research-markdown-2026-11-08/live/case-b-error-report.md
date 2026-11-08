# Eumenes エラーレポート
これは失敗した会話処理の診断です。会話本文・設定・認証情報は含みません。
原因の推定と、確認すべきコード・ログを示してください。

## 概要
- 発生: 2026-11-08 11:10:36 JST  boot: ac4b05bd-35ce-44e9-a43e-7acb4a4683eb
- 結果: completed / 調査失敗の固定返答 / deadline_exceeded
- 失敗した段階: 推論（inference.attempt_failed）
- タスク: coordinator[853ca448] completed / deadline_exceeded ; worker[bd8f8423] failed / deadline_exceeded

## 経過（正常系は集約）
| 経過 | 段階 | 結果 |
| --- | --- | --- |
| 0.0s | 受付 | queued |
| 7.3s | 回答生成 | 開始 |
| 7.8s | 候補検索 | 10件（hybrid） |
| 7.9s | 選定 | toolchain web.search |
| 7.9s | 担当へ引継ぎ | handed |
| 7.9s | ジョブ | 完了 |
| 7.9s | サブエージェント worker [bd8f8423] | 状態遷移 ×2 |
| 52.9s | inference.attempt_failed | deadline_exceeded（purpose=llm） |
| 52.9s | queue.execution_failed | （kind=agent.step） |
| 52.9s | queue.settled | deadline_exceeded（status=expired） |
| 52.9s | toolchain.selection_settled | （outcome=failed） |
| 53.0s | agent.state_changed [bd8f8423] | deadline_exceeded（kind=worker status=failed） |
（その他の正常系 14 行は集約・省略）

## 最初の失敗
- component: inference  event: inference.attempt_failed
- reason: deadline_exceeded

## 追跡用
- runId: ab2b8c3c-2826-4e5e-a2c3-8f72c300f6e6 / requestId: f9c452ea-9abe-4528-a91f-e8027029dd76 / jobId: 142868bb-f11c-45db-bdc1-fa7c804f8cd6 / taskId: bd8f8423-9183-4e4b-8b86-a49bd8cd94c4
- bun run logs -- --id ab2b8c3c-2826-4e5e-a2c3-8f72c300f6e6 --json
- bun run logs -- --id bd8f8423-9183-4e4b-8b86-a49bd8cd94c4 --level warn --json
