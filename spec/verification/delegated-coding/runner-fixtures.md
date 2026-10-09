# 計画02のCLI/MCP基盤検証

2026-10-10 JST。macOS、Bun 1.4.2、MCP SDK 1.31.0。一時Git worktree・DB・Python fixture CLI・bare remoteを使用。製品DB、製品workspaceへのCLI編集、実Provider、実Git remoteへのrunner pushは使わない。

- runner/domain: 24件成功。stdio tools/list、strict schema/version、RPC取消、起動intent・再送・予約、分割UTF-8・部分行・巨大出力、lease失効、背景process group停止、不明PIDへの非介入、明示session継続、取消後の継続拒否、envのtoken非継承、レビュー中の変更、snapshot/commit/push/応答欠落を確認。
- application/client: 27件成功。計画01の22件とcodingタスク結合4件・HTTP/client 1件。backlogのQueue継続、task/Queue/coding intentの同時保存、開始前取消、遅い結果の拒否、HTTP認証・非公開field除外を確認。
- Queue/Scheduler/tasks込み回帰: 96件成功（coding HTTP追加前の実行）。上の件数と単純に足さない。
- 最終結合回帰: runner/coding・application/client・tasks・Queue・Schedulerを同時実行し121件成功、0失敗、670 assertions。HTTP fixtureの依存組立てとreceipt対応検査の最終修正を含む。
- 最終の全体型検査: `bun x tsc --noEmit` 成功。今回の対象のlintと `git diff --check` も成功。
- coding domain verify: 境界・整形・lint・型・24試験は成功。最後の全project source hash照合で並行作業のsource変更を検出し未通過。22件時点ではgate全体が成功したが、最終追加分の全体成功には数えない。
- verify:all: 全体整形で未通過。今回のcoding applicationの整形を修正後も、並行作業の他領域の整形・型検査の未解決分を分けて記録する。

Git応答欠落の試験はGit効果の実行後にreceiptをin_progressへ戻して照合する。すべてのfsync/spawn境界で実processをcrashさせるfault suiteを完了したとは扱わない。fixtureのprocess group確認は、隔離環境で逃避した子processも含めた全process封じ込めの実証ではない。

live: 課金しないinstalled Codexのversion/helpだけを確認（0.155.1）。実CLIの実装→検証→レビュー→修正→commit→pushは未実施。本番runnerは隔離未検証によりavailable=falseを維持する。

実機器/Tauri: 未実施。計画02全体と委任タスク全体の完成は宣言しない。実装状況・残る工程は [運用契約](../../../docs/coding-runner.md) に記録する。

## 2026-10-10 コードレビュー後

[レビュー記録](runner-review.md)の指摘修正を含む最終試験はrunner/domain 37件、application/client 30件、tasks/Queue/Scheduler 70件。まとめた結合実行で137件成功、0失敗、1730 assertions。以前の121件から16件を追加し、既存のsession・Git試験も強化した。

最終coding domain verifyは境界・整形・lint・型・37試験・source hash照合まで成功。全体型検査、対象applicationのlint、diff検査も成功。verify:allは別領域の整形7 filesで停止したため、全体成功には数えない。liveと実機器の未実施状態は同じ。
