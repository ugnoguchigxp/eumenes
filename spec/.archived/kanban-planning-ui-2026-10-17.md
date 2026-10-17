# タスクボードのPlanning・横並び表示（2026-10-17）

利用者の依頼: 未着手を「未着手＋Planning」とし、Planningは処理せずOngoingだけを実行キューに載せる。担当別の状況表示をAnthropic／ChatGPTのSVGロゴ付きボタンにし、カンバンは横に並べる。ドラッグ操作の追加は不要。

## 既存機構と変更範囲

- 共有Kanbanの`todo`は登録・編集のみ、`run`／`add-run`で`running`へ移動してrunを作る。これを再利用し、DB・公開操作・LLMの指示・bundle revisionは変更しない。
- 表示名を「未着手＋Planning」「Ongoing」「Done・Blocker」に揃え、Planningが実行待ちでないこと、Ongoingがキュー待ちと実行中を含むことを説明する。
- DesignSystemの既存`KanbanBoard`内で担当フィルターと担当別キューをロゴ付きボタンへまとめる。クリックは表示の絞り込み。停止中の再開操作は従来の担当別callbackを使う。
- 狭い画面でも3列を維持し、列領域だけを横スクロールする。既存のボタン・移動メニューを使って操作できる。
- ロゴは表示用途だけの対応表とし、未登録ロゴの担当は汎用アイコンで表示する。実行担当の選択やキュー判断へブランド分岐を入れない。

## 作業順・完了条件

1. 列見出し・説明、担当ボタン、横スクロールを既存部品へ反映。
2. 既存の表示試験を更新し、担当フィルターと停止キューの再開を確認。domainの試験でPlanning保存時にrunが無く、明示実行後だけOngoingになることを確認。
3. 部分試験→Web結合→`bun run verify -- --domain kanban --domain artifact`の順に確認。サーバー起動を伴うE2Eは許可されていないため実行しない。静的ブラウザ描画で狭い幅と広い幅の列配置を確認する。
4. 最終差分で対象外変更、意味判断の置換がないことを確認し、検証結果を記録する。取り消す場合は今回の表示部品・試験・文書の差分だけを戻す。

## 実装・検証結果

- 既存KanbanBoardの表示を変更。`ExecutorQueues`に担当別状況・フィルターをまとめ、`ExecutorLogo`に表示用SVGを置いた。実行処理・登録revision・DB変更なし。ライセンスと取得元は部品の`LOGO-LICENSES.txt`に保存。
- 部分: `shared.test.ts` 7件成功。Planning保存後にrunもキュー待ちも無いこと、明示実行後だけ`running`となりrunが一件作られることを確認。
- 表示部品: KanbanBoard 30件成功。ロゴボタンの絞り込み・解除でwrite callbackを呼ばず、停止キューは対象担当だけを再開する。
- Web結合: `view.test.tsx`、`toolchain-adapter.test.tsx`計15件成功。
- 全体: `bun run verify -- --domain kanban --domain artifact`成功。DesignSystemの型・ビルド、関連domainと利用側の検証を通過。KanbanBoardフォルダのlint・format・size-budgetも成功。
- 静的ブラウザ描画: 1280pxでは3列が横並びでスクロールなし、390pxでは各260pxの3列が横並びで列領域だけ横スクロール。どちらもページ全体の横はみ出しなし。[広い画面](../verification/kanban-planning-ui-2026-10-17/board-1280.png)、[狭い画面](../verification/kanban-planning-ui-2026-10-17/board-390.png)、[配置の測定](../verification/kanban-planning-ui-2026-10-17/layout.json)。静的fixtureの描画であり、稼働中の実画面の受入とは区別する。
- 既存ブラウザE2Eは独自のbackend・Viteを起動するため未実行。サーバー操作の許可は今回ない。実LLM・実CLIでの作業実行はUI変更の確認に不要なため未実施。実機器は対象外。
- 最終差分点検: 担当外の既存差分へ変更なし。語句・シナリオで意味判断を置換する処理なし。ブランド対応表はSVGの見た目だけに使用。
- 検証の見直し: 最初の関連domain検証はpass。その後の最終確認は個別チェックが全件passだったものの、実行中の作業ツリー更新により全体結果は`invalidated`。並行して通知領域の担当外ファイルが更新されており、Kanban対象ファイルの更新時刻は検証開始前だった。製品不具合とは扱わず、最新の作業ツリーを入力に再検証する。再び更新が続く場合は無効な全体結果を成功扱いせず、個別試験と静的描画の結果を分けて報告する。

最終結果: 最新の作業ツリーでの再検証は`pass`。domain・Artifactの253件、Webの90件が成功し、全体の入力整合性も通過した。別途KanbanBoard部品30件が成功。

残作業: 今回の実装・固定試験・静的描画確認は完了。稼働中画面のE2E受入は未実施。
