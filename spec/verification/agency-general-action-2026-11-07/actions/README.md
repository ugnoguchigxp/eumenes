# Agency汎用行動の適用後検証

実装と固定検証の記録。実LLM・実生成・利用者のWeb画面の受入は未実施。サーバー操作の明示許可待ち。

- 最終の関連試験は140件成功、0件失敗（27ファイル）。出所・取消・忘却・権限・上限・再起動・成果物・質問再開を含む。`final-backend.txt`に全結果を保存。
- 型検査3,056ファイル、今回のlint・書式・サイズは成功。`final-checks.json`と各ログを参照。
- 広域の先行試験は1,514件成功・1件失敗。失敗は既存Markdown登録fixtureの対応backend不足。最終の能力失効・lifecycle検査追加より前の入力であり、最終状態の全件再試験とは扱わない。元の広域ログは後続コマンドと出力先が重複したため残っておらず、実行出力の集計と入力manifestを残す。
- 横断verifyは既存2ファイルの書式で停止。全体lintは既存Markdown検証用画面で失敗。Webは67件成功、10 suiteが既存のKaTeX CSS importで試験開始前に停止。これらのgateを成功とは扱わない。
- `baseline-files.json`は、上記の原因となるファイルと固定HEADの一致を示す。並行作業のMarkdown・起動処理の変更は、この固定checkoutへ取り込んでいない。

実行入力は`source-manifest.json`、横断gateは`domain-verify-report.json`、集計と残作業は`summary.json`。固定モデルの成功は、実モデルの自発選択品質の保証ではない。

補助コンテキスト参照は計2回、評価保存は計2回。
