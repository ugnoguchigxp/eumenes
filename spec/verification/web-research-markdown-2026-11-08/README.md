# Pursuit調査結果のMarkdown保存

2026-11-08。実装・固定検証済み。後続の起動許可を受け、実モデル・実Docling・稼働画面でも文書保存を確認した。自然文の中止と担当選択には未解決の課題がある。

目的: 調査の担当を切り替えず、タイトル付きMarkdownを一時ファイルと利用可能なDoclingのEumenes専用領域へ保存する。[合意済み設計](../../web-research-markdown-design-2026-11-08.md)。

## 検証の条件

固定試験では製品サーバー・製品DB・設定・認証情報は使わず、固定モデル・隔離SQLite・固定文書API・一時SSDを使う。後続のliveは起動許可後に保存済み設定と公開APIを使用した。既存の未コミット差分を保持し、実行中の検証が読む実装は編集しない。

基準: 既存Pursuit/Markdown/会話結合26件成功。最初のディレクトリ指定が保管コピーにも一致した実行は中断し、以後は `./` 付き実ファイルを指定した。

## 結果

| シナリオ | 確認した結果 |
| --- | --- |
| 通常の調査→Markdown保存 | 会話の公開入口から調査、独立検証、タイトル付き一時ファイルとDocling保存まで成功。本文のUTF-8読戻し、出典リンク、`research/` のpath、共同編集sessionが0件であることを確認 |
| Doclingに接続できない | 一時ファイルを取得でき、Docling未保存と区別。PUTなし |
| ローカル容量不足 | 一時保存の失敗を明示し、独立したDocling保存は成功 |
| 部分結果 | 文書を保存しても調査statusはpartialのまま |
| 保存待ち中の再起動 | 同じ文書IDと結果照会を再開。追加の調査・モデル呼出し・文書作成なし |
| PUT応答喪失 | GET一致なら保存確認。不一致・未取得なら結果不明または競合。PUTは1回だけ |
| 取消・忘却・遅い書込み | 古い結果を採用せず、一時ファイルを除去。訂正前のepochで作った文書の参照も忘却対象 |
| 保存先変更・既存文書との競合 | 古い接続の結果を採用せず、自動上書き・新IDでの再送なし |
| 結果不明の再確認 | 公開操作は固定IDのGETだけで照合し、PUT回数は増えない |
| 旧版seed済み／新規DB | 新版を公開し、再seedで変化なし。旧revisionはPursuit19件、Markdown24件が不変 |
| 文書を画面で開く | 既存Plate取込みへ接続し、会話の担当を切り替えない。Web固定試験も成功 |

関連domainの試験はBun **1,385件**（201ファイル）、Web **148件**（24ファイル）、DesignSystem **25件**（5ファイル）がすべて成功。最後の修正後に対象6ファイルのシナリオ**37件**を再実行して成功した（重複を含むため上の件数へ加算しない）。型検査は3,172ファイルでエラー0件。bundle2件、変更ファイルのformat/lint/サイズ予算、SQL境界、SystemContext整合、domain文書、Webビルドが成功。保存処理の共用後も既存workspaceの保存試験を通過した。

詳細は [シナリオ実行ログ](scenarios.log)、[結果一覧](summary.json)。fixtureを実LLM・実LARM・稼働画面の成功とは扱わない。

## 実行した入口

- `bun run verify -- --domain pursuit --domain markdown --domain docling --domain scratch --domain capabilities --domain tool-runtime --domain dialogue --domain resources --domain artifact`
- 一括入口の停止後、同じdomain指定で `bun run test:domain -- --domain …` を実行。部分・結合試験は `./api/domains/{pursuit,markdown}/test/` と `./api/application/pursuit/` 等の実ファイルを明示した。
- `bun run typecheck`、`bun run build:web`、bundle2件のcheck、変更ファイルのformat/lint/サイズ、SQL境界・SystemContext・domain文書の各check。

## 一括gateと実接続

一括verifyは、既存の `artifacts/pursuit-integration-20261106/` 内の保管コピーが試験inventoryに列挙される問題で停止した。除外や期待値を変更せず、個別検証の成功と区別する。全体の依存境界チェックには、既存の `client/agency.ts` の深いimportが1件残る。全体の `git diff --check` は既存の `vendor/agency/adoption-source.patch` の空白指摘で失敗したが、今回の変更ファイルは通過した。これらの担当外差分は変更していない。

起動許可以前のCLI照会は接続できず終了コード5だった。その後ユーザーが起動と実践テストを明示的に許可したため、既存の開発サーバーを起動した。題材の異なる2件の実モデル調査が完了し、タイトル・比較表・出典を含むMarkdownをscratchとDoclingの `eumenes/research` から読み戻して本文の完全一致を確認した。通知リンクから既存Markdown画面で開く操作も2件成功し、specialist sessionは作られなかった。

第3の題材では自然文の中止が新規調査になる問題を観測。既存TODOの公開中止・archive操作は成功し、22分後も文書・通知が追加されなかった。複合依頼が通常検索へ選ばれて期限終了する例もあった。これらと約20〜24分の所要時間は、保存成功と区別して [実接続記録](live/README.md) に残した。設定変更・実サービスの故障注入・追加の製品修正は行っていない。ブラウザーの実操作と固定Web試験を確認したが、Playwright E2Eスイートの追加実行は行っていない。

## 差分点検・残作業

意味判断・タイトル・構成はPursuitの既存LLMと新版Skillが担当する。追加コードは公開保存契約、固定ID、出所・版・取消の検査、Queue、ファイル出力と結果照合である。語句や題材ごとの分岐、固定回答、別の担当選択ループは追加していない。

実装・固定シナリオ・実接続の検証は完了。自然文中止・担当選択・調査時間の課題は未解決であり、今回の保存接続とは分ける。Pursuit本体・配布物と接続設定は変更していない。liveでは検証会話と生成文書を通常の公開操作で作成し、DBを直接開いていない。サーバーは起動したまま。別Codexチャットへの連絡は行っていない。
