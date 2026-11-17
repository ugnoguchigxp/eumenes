# 計画2　保存・権限・専門担当の復旧　検証記録

2026-11-17。基準コミットは `204280c675cc67809ddf1cd1ab623e4243d06a5e`。作業は main。`initial_instructions` はこのセッションのツール一覧に無く、実行していない。`api/domains/dialogue/service/index.ts` には別作業の未コミット差分があるため、この計画では編集していない。サーバーの起動・停止、製品DB、実接続は行っていない。

## 引き継いだ専門担当の終了再試行

終了失敗の停止は、着手時から未コミットの実装と `api/application/collaboration/collaboration-close.test.ts` がある。設計書 `spec/specialist-close-retry-design-2026-11-16.md` の条件と照合し、実装は引き継いだ。期限切れで元発言の紐付けが確定したときだけ `close_blocked_reason = source_session_expired` を保存し、定期処理と起動時復旧はその行を外す。期限内の `work_busy` と、紐付けを確認できない失敗は停止理由を付けず再試行する。停止理由の保存が外側の transaction で戻ると、停止ログは出ない。

## ID

| ID | 状態 | 結果 |
| --- | --- | --- |
| 2-01 | 既存差分を検証 | 期限切れ2件は停止理由付きで `closing` のまま。下書き revision、完了済み子参照、試行回数は停止後の定期処理2回・起動時復旧・新規引渡しで変わらない。停止ログはセッションあたり1件。忘却は対象の作業だけ消す。 |
| 2-02 | 既存差分を検証 | 期限内の `work_busy` は次の試行で終了する。digest が一致しない間は期限切れとせず再試行し、出典を戻したあとに停止する。停止保存前の rollback では試行回数も停止ログも増えない。 |
| 2-03 | 未実装 | 停止後の同じ会話では、既存の `specialist_closing` により新しい専門担当を開かない。再接続・明示終了の公開操作の整理は設計合意の前。 |
| 2-04 | 修正済み | schema 8→9 の試験で、保存した3件の item ID が揃ったときだけ `string` に絞った。`any`、診断無効化、期待値の変更はない。このファイルの TS2769 は型検査の出力に無い。試験は成功。 |
| 2-05 | 一部修正 | `appendJournal` と `readJournal` は既存の `api/domains/memory/test/journal.fixture.ts` から使う。製品の公開入口には出していない。旧 tarball を展開したコピーへの動的 import は残る。条件は下の引渡し。 |
| 2-06 | 既存試験の再実行 | 専用DBで、別世代の WAL/SHM の退避、対応する鍵での credential 読取り、最新 journal による失効の再適用、鍵なし・別鍵・未知 migration の拒否を確認した。破損 journal の追加ケースは未実施。 |
| 2-07 | 未実施 | 途中で破損した journal、欠けた記録、二回再読は今回の追加試験を書いていない。 |
| 2-08 | 未実施 | 訂正の意味の合成会話は未作成。 |
| 2-09 | 未実施 | 発言撤回と派生物の合成データは未作成。 |
| 2-10 | 修正済み | Dialogue の `researchSourceIds` が `web.research` の空でない出典IDを返す。忘却 hook は同じ writer でそのIDを Pursuit に渡す。Pursuit は `dialogue_work` を読まない。TODO本文を消したあとも出典IDは残り、対象の調査だけ失効する。別メッセージの調査、別 toolchain、`web.note`、空の出典は残る。同じ hook の再呼び出しは web の削除と通知撤回を繰り返さない。 |
| 2-11 | 未実装 | SQL検査は Pursuit が `pursuit_pursuit` と `pursuit_operation`（所有者 `pursuit-core`）を更新していると報告する。この UPDATE は変更前からある。公開操作へ寄せる案は合意前。allow への追加は共通設定のため未実施。 |
| 2-12 | 一部確認 | Queue の固定試験で、commit 後・claim 前に落ちた仕事は再起動後に1回実行され、handler 実行中の中断は interrupted になり、生存中の所有者と同じDBを第二プロセスは開けない。外部作用の成否不明を分けた追加ケースは未実施。 |
| 2-13 | 未実施 | 再起動後の中断と手動継続の照合は未着手。 |
| 2-14 | 未実施 | 200件より古い run の直接取得は未照合。 |
| 2-15 | 未実施 | writer 混雑時の lease は未計測。 |
| 2-16 | 未実施 | 実行前後の権限の固定試験は未実行。 |
| 2-17 | 未実施 | Browser・dots・コーディング担当の取消は未照合。 |
| 2-18 | 未実施 | Shell のログイン環境試験は未着手。 |
| 2-19 | 未実施 | 依存の由来と配布条件は未照合。 |
| 2-20 | 再現のみ | `buildServices` は 458 行で、記録済みの 348 行より大きい。HEAD と同じ行数で、今回の差分では増えていない。忘却の実処理は `api/application/pursuit/forget-research.ts` へ出したが、登録呼び出しは `buildServices` に残している。Collaboration から Queue への import は `work.ts`、`work-reviews.ts`、`reviews.test.ts` にあり、HEAD からある。Memory の非公開 import は、現行の境界検査では再現しなかった。依存宣言の変更は下へ渡す。 |

## 実行した固定試験

すべて成功。サーバー待受は作っていない。

```text
bun test ./api/domains/dialogue/test/specialist-lifecycle.test.ts ./api/domains/memory/test/forget-contract.test.ts ./api/domains/queue/test/recovery.test.ts
bun test ./api/application/collaboration/collaboration-close.test.ts ./api/application/backup-restore.test.ts ./api/application/pursuit/upgrade.test.ts
```

`bunx tsc --noEmit --pretty false` は、今回編集したファイルにエラーを出さなかった。リポジトリ全体では `packages/artifact-ui/src/markdown-components.tsx` の TS2322 が1件残る。このファイルは着手時から別作業の未コミット差分であり、今回編集していない。

`bun scripts/sql-boundaries.ts` は、2-11 の2件で終了コード1。`dialogue_work` への越境は報告されない。

`bun scripts/boundaries.ts` は終了コード1。今回の範囲で残るものは、backup-restore の動的 import と、Collaboration から Queue への依存。ほかの失敗は今回の編集対象外。

## 未実行

`bun run verify -- --domain dialogue --domain collaboration` と、memory・conversation・world・queue・pursuit の domain verify は未実行。memory の統合試験には `api/application/memory-host-integration.test.ts` と `api/application/server.test.ts` が含まれ、ローカル待受を作る。起動の許可は取っていない。

`action-safety.test.ts`、`always-on-authority.test.ts`、`resource-access.test.ts` も未実行。稼働中DBの読み取り照合、live、実機器受入は未実施。

## 計画3または決定者へ渡すもの

1. 境界検査の動的 import。対象は `api/application/backup-restore.test.ts` の schema 8 巻戻しだけ。`vendor/eumenes-memory/eumenes-memory-0.0.4-30721f30aa19.tgz` を一時ディレクトリへ展開し、その `package/dist/sqlite.js` を読む。インストール済みの現行パッケージとは別物なので、静的な import パスを付けられない。例外を広げる場合も、この展開コピーに限る。
2. Collaboration の api 依存に Queue が無い。`QueueService` の型 import と、試験の `createQueue` が境界違反になる。宣言を足すか、import を公開ポートへ変えるかは依存関係の共通設定なので、こちらでは変えていない。
3. SQL検査の `pursuit` → `pursuit_pursuit` / `pursuit_operation`。2-11 の設計が決まるまで、allow への追加は保留。
