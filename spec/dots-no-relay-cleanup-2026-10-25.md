# dots連携：追加サーバー前提の撤回と準備コードの削除

2026-10-25。利用者は追加のクラウドサービスを用意しない。PC起動中にdotsへ仕事を渡し、受領済みの仕事はdots側で進め、結果をChatGPTで確認できればよい。先の常設relay・受取箱の配備計画は撤回する。結果をEumenesへ再取得する方式は未確定であり、この削除作業で自動同期や遅延採用を新設しない。

対象は未使用のrelay wire契約と試験、未接続の起動時同期設定、relay可用性コールバックと固定状態、relayを前提にした画面文言・実行用Skill・計画。実行で参照しない固定一択の受付package設定も除き、担当の版は既存のtoolchain登録を正本にする。既存の認証、Events、メッセージと要約、委任のタスク・権限・期限・停止・結果保存と画面は維持する。native作業先のlocal/cloud区分は追加サーバーの有無とは別なので維持する。

SQLiteは新migrationで不要な2フィールドだけ除く。既存公開済みの登録内容とhashは上書きせず、受付Skill/package、外部Skill/package、toolchain、設定artifactを新版へ進める。旧版の全bundleを複製した試験fixtureは廃止し、設定画面の旧版保持は必要な文書だけの小さいfixtureで確認する。意味判断の語句分岐は追加しない。

完了条件は不要コードの参照ゼロ、旧設定からの移行と既存設定保持、委任と回答・停止・通知表示の対象試験、bundle dry-run、対象domain gate、画面保存の通し試験、差分点検。共有コードの既存失敗は修正せず区別して記録する。サーバー配備・課金・実dotsへの送信は行わない。

実装・反映済み。検証結果は[記録](verification/dots-no-relay-cleanup-2026-10-25/README.md)を参照する。追加のクラウド配備は行わない。

削除したものは `api/domains/dots/contracts/relay-v1.ts`、対応する `relay-contract.test.ts`、旧bundleを全体複製した `dots-delegation-v1.fixture.json`、未実装の起動時同期と固定受付packageの設定、relay可用性のコールバックと固定状態、それらを前提にする指示・画面文言。

通常の移行確認は旧設定画面の文書だけを用意する試験へ置き換えた。公開済み版の上書きを避けて、現行登録は受付Skill/package@2、外部Skill/package@4、toolchain@5、binding@3、仕事artifact@3、設定artifact@5、UI schema@3。保存済みの担当の選択は自動変更しない。

実ローカル反映時には設定画面の保存済み定義と衝突した。登録失敗ログに対象IDと検証位置を出す最小限の補足を加えて原因を絞り、旧定義を保持したまま設定画面の新版を登録した。契約の検査やhashの照合は緩めていない。
