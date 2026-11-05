# 共同作業サブエージェントの本流導入

2026-11-05着手、2026-11-06更新。利用者の本流導入依頼と、[新Pipeline・interact接続案](collaboration-followup-design-2026-11-05.md)への「新方式への共同編集とinteract接続を進める」という承認に基づく。開始時の本流は `e917e920f7b252c6f70a07dda1a119b0a2516bfc`。main作業ツリーに実装済み。稼働サーバーでの受入と、並行導入を含む全体gateは未完了である。

## 採用した接続

共同作業は、会話の窓口を引き継ぎ、利用者と成果物を反復して作るサブエージェントである。独立版0.2.0の公開入口から4 action・共通指示・文脈構築を使い、既存specialistの重複コードと固定指示を置き換えた。既存のwriter、Queue、inference、receipt、session epoch、Artifact/OpenUIを継続利用する。別のモデルループ・DB・ブラウザーrunnerは追加していない。

| 用途 | 登録と実行経路 |
| --- | --- |
| UI自由生成 | 既存 `ui.compose` / `ui_create` → 既存sessionとUI workspace → 共通core → doc.write/edit → 既存保存操作・復帰 |
| 今回の手順 | `collaboration.pipeline@1` / `collaborate_pipeline` → `package:collaboration.pipeline@1` → `binding:collaboration.pipeline@1` → `adapter:collaboration.pipeline@1` → collaborationの下書き → 新Pipelineの親実行 → `artifact:collaboration.pipeline@1` |
| ブラウザー共同作業 | `collaboration.interact@1` / `collaborate_interact` → 同名package/binding → `adapter:collaboration.interact@1` → browser domainのinteract公開lifecycle → `artifact:collaboration.interact@1` |

新規二担当は `profile:collaboration@1` を共用し、役割別のskill/toolsをbindingから渡す。担当の選択・依頼の解釈・回答の意味はLLMに委ねる。発話の語句による振分けや固定返答は追加していない。`agent.sharedTools` の一般化は今回も行っていない。合意した二用途の非同期連携を、所有workと既存公開portで接続した。

interactは下位の `availability:browser.interact@1` に追従する。初期無効の通常会話候補を、この導入の都合で有効にしていない。Pipelineは旧studio・ひな形公開を復活させず、新形式p0-3の `request/steps/output` を共同編集する。

## 状態・権限・保存

- `collaboration/0001-works` が下書き、版、所有session、寄与した実際の利用者発言の参照、子実行、受付receiptを保持する。`dialogue/0035-specialist-observations` がホスト観測を保持する。製品DBへの直接適用はしていない。
- 元依頼は実際の利用者入力を正本とし、編集した本文での上書きを拒否する。下書きの作成だけでは実行できず、別の利用者入力・現在版・同一session/epochが必要である。同じ発言による二重開始と自己承認も拒否する。
- 確認した下書きは、既存親実行の同じ検査・catalogを通して直接実行する。確認後にcomposerで作り直さない。子の実行・結果採用・承認・取消は元の実行domainが所有する。
- 通常の記憶からの `specialist_dialogue` 除外と、忘却による権限失効を区別する。同じsessionの実入力だけを実行の出所として使い、忘却・未適用の忘却journal・他session・古いepochは拒否する。既存の通常会話の記憶除外は緩めていない。
- `collaboration.followup` は既存Queueで質問待ちも含めて所有権を監視する。待機中に推論slotを保持しない。保存された質問/結果から同じ担当を再開し、利用者発言を新造しない。モデルへの末尾メッセージはHOST_EVENT_NOTICEと明記し、元の利用者発言を現在の依頼として再掲しない。ホスト観測のターンはreplyのみで、道具の実行・承認・破棄はできない。
- 取消、保留、期限、忘却後の遅い結果を採用しない。古いwatcherが新しい子を再開しないようchild IDも固定する。寄与した発言の忘却は下書き・receipt・子データ/撮影・観測本文を消去する。未確定の送出は再送しない。
- モデル接続は本流の保存済みLARM設定を継続利用する。独立側のAPIキー・モデル固定値・example storeは製品へ移していない。音声の二文・300字制約も維持している。

## 検証結果

[機械可読記録](verification/collaboration-integration-2026-11-06/summary.json)に対象snapshot、出所hash、段階別結果、制限を保存した。原ログと失敗した試行は無視対象の `verification-reports/collaboration-integration-2026-11-05/` に保持する。重複する試験数を合算して総数とはしていない。

| 段階 | 結果 |
| --- | --- |
| 配布物 | 実tgz SHA-256と配布21 resourceを照合。source commit `b407ecd8372b2718f05c23a2340e0483833a0296`、core契約1、state schema1 |
| 広い回帰 | r4: backend 1,229件中1,228成功。1失敗は並行interact導入によるbrowser DriverのreadText追加に、既存試験の期待値が未追随の箇所 |
| 関連回帰 | r5: dialogue/capabilities/collaboration/ui-compositionsと既存UI specialistの649件・5,109 assertions成功 |
| 結合 | r7: 記憶有効のPipeline、interact承認/忘却、観測、既存command/browser/media、配布物など27件・252 assertions成功 |
| 画面側 | 実Artifact hostの二担当表示、既存UI adapter・workspaceなど34件成功。型検査2,881ファイル成功。Web全体build成功 |
| 最終観測回帰 | r8: 36件・216 assertions成功。利用者発言を新造せず、元依頼を今回の発言として末尾へ再掲しないこと、reply以外の拒否も確認。型検査2,881ファイル成功 |
| 自分の静的検査 | 41ファイルのformat/lint、30製品ファイルのsize、context再生成整合、bundle登録検査が成功 |
| ブラウザー描画 | 保存済み実API成果物と、認証付きin-process APIから得た下書きを、実ArtifactRenderer/DesignSystemで表示。1440px/390pxとも描画エラー・横はみ出しなし。部署欄が任意で入力可能なことを確認。HTTPサーバーは起動していない |
| 必須verify | r2〜r5は並行変更の整形等で停止。その後の更新で共有mainの整形3,905ファイル・size 2,117ファイルが成功。r9の `verify --domain collaboration` は全12工程成功（範囲外のKanban依存5警告）。以前失敗したbrowser Driverも、更新後の27件・160 assertionsが成功。全体gate成功とは扱わない |

共有作業ツリーに別担当の変更があるため、コード・依存を固定したsnapshotで通し確認した。最終snapshotは `3fee9717d2abc4bba5e1e8e399dfafed57c31d5c75d84d866e7432ff821b9a54`。その後の共有main全体の状態を保証する記録ではない。

実APIで判明した記憶有効時の子command起動失敗は、同じsession用の出所確認を子担当の入口にも接続して修正し、固定試験とLunaで再確認した。観測本文が寄与した別発言の忘却後にも残る箇所も修正した。初回の実API通知確認では元依頼を新しい希望と誤読する返答があり、通知の末尾メッセージをホスト観測として明示する修正後に再確認した。型を公開していない外部schemaを内部Zodとして扱う実験は削除し、公開parse/checkと型を説明するskillだけを使う。

## 実APIの範囲と限界

同じ10USD台帳を継続し、失敗・不明な結果の予約も含む累計は **6.765742USD**。今回の導入で増えた保守的計上は0.497419USD。追加送信は終了した。最終の結果通知では記録済みの実APIによる作成・修正・確認操作を再生し、同じ担当が保存された完了観測を説明する1呼出しだけを新規送信した。返答は「二つのタイマーは開始済みで、結果は一つ目が20秒、二つ目が45秒です。」だった。

- Luna: UIの作成→部署だけ任意化→他項目保持→実保存→通常会話への復帰、および新Pipelineの作成→部分修正→別発言での確認→20秒/45秒の実タイマー作成→同じ担当への結果返却を確認した。確認後のcomposer呼出しは0、親実行は1件。
- Claude: UIの作成・部分修正・保存・復帰操作は通ったが、復帰の返答で保存状態を誤って説明した。Pipelineは三文の返答を二文制約へ修正できず、未合格である。制約を緩めたり出力を自動短縮して成功にはしていない。
- 親の担当選択とtimer操作翻訳は固定モデルで、specialistだけ実APIである。通常会話の実モデルによる担当選択、保存済みLARMでの製品全体受入、実外部サイトの操作は未確認。
- 旧実験のopaque JSON変換で失敗したため、追加確認では両providerに同じscalar JSON文字列の検証用transportを使った。元の4 actionは変更せず、実ホストで検査・実行した。製品のLARM経路をこの検証adapterに置き換えたものではない。[Structured Outputsの公式仕様](https://developers.openai.com/api/docs/guides/structured-outputs)を確認した。

## 残作業と運用への反映

1. 並行するPipeline/interact等の導入を確定し、利用側を含む全体verifyを完了する。最新共有変更を反映したr9 snapshotは `b2ecd79f75684336711373d7fbceabfe2908d8ac0d04594b8ff5a37e690fc92d`。既知の整形・size・browser Driver失敗は別担当の更新後に通過した。範囲外のKanban依存警告は残る。選択されるapplication試験には `Bun.serve` によるHTTPサーバー起動が含まれるため、許可前に一括実行しない。当方から別チャットへ連絡・担当外修正・一括stageはしていない。
2. 稼働サーバーで登録・会話・実画面の受入を行う。サーバー操作には [AGENTS.md](../AGENTS.md) の「ユーザーの明示的な許可なしに、サーバーを停止・起動・再起動しない」が適用されるため、今回は停止・起動・再起動していない。製品DB・設定をコピーせず、CIも実施していない。
3. Claudeの自然言語品質は残課題として扱う。同じ失敗の追加有料反復は停止した。製品で採用する保存済みモデルと実際の宛先選択を含む受入が次の判断材料である。

この導入と前提の並行変更は同じmain作業ツリーで未commitである。自分の変更だけでは前提package/APIが欠けるため、他担当の未確定の共有変更を一括でcommit/pushしていない。独立側で確定済みの80点超評価を、この未受入の本流全体へ転用しない。
