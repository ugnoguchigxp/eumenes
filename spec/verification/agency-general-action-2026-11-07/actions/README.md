# Agency汎用行動の適用後検証

実装と固定検証の記録。利用者の再起動後、実LLMによる能力検索は成功したが、実生成の前に活動トークン上限で停止した。上限を調整して固定検証済み。実生成と画面表示の通し受入は、調整を反映する次の再起動後に残る。

- 最終の関連試験は140件成功、0件失敗（27ファイル）。出所・取消・忘却・権限・上限・再起動・成果物・質問再開を含む。`final-backend.txt`に全結果を保存。
- 型検査3,056ファイル、今回のlint・書式・サイズは成功。`final-checks.json`と各ログを参照。
- 広域の先行試験は1,514件成功・1件失敗。失敗は既存Markdown登録fixtureの対応backend不足。最終の能力失効・lifecycle検査追加より前の入力であり、最終状態の全件再試験とは扱わない。元の広域ログは後続コマンドと出力先が重複したため残っておらず、実行出力の集計と入力manifestを残す。
- 横断verifyは既存2ファイルの書式で停止。全体lintは既存Markdown検証用画面で失敗。Webは67件成功、10 suiteが既存のKaTeX CSS importで試験開始前に停止。これらのgateを成功とは扱わない。
- `baseline-files.json`は、上記の原因となるファイルと固定HEADの一致を示す。並行作業のMarkdown・起動処理の変更は、この固定checkoutへ取り込んでいない。

実行入力は`source-manifest.json`、横断gateは`domain-verify-report.json`、集計と残作業は`summary.json`。固定モデルの成功は、実モデルの自発選択品質の保証ではない。

再起動後の測定・活動予算の調整・117件の関連試験は`live-after-restart.json`、実LLMの本文を含まない実行記録は`live-agency-metadata.json`を参照する。これらは最初の固定checkoutの結果と分けている。

その後の起動失敗は、忘却済みのMemory RecordとAgency側に残る観測参照の不整合が原因。通常の忘却に加えRecord単位の忘却を反映し、起動前に正本で確認した忘却と入力版の失効を整合する修正を実施した。関連288件とサーバーを起動しない3件が成功。既存の保存済み不整合からの復旧と、独立会話の保持、未知の欠落の拒否を含む。実起動は利用者による確認待ち。`startup-archive-recovery.json`と`startup-recovery-backend.txt`を参照。

前回の修正後も起動が失敗したため、利用者の許可を得て停止中の保存データを読み取り専用で診断した。19会話61件で参照行とprovenanceの両方が欠落し、対応するRecordはすべて忘却済みだった。公開仕様のoriginからIDを得て忘却を確認する経路を追加し、修正後の同じ読取り操作で実データ61件すべてを捕捉した。データ変更・本文や秘密の取得・サーバー操作はしていない。関連292件・型・所有ファイルの静的検査が成功。実起動は未確認。`startup-missing-reference-recovery.json`、`missing-reference-backend.txt`、`readonly-reader-coverage.json`を参照。

補助コンテキスト参照は計5回、評価保存は計5回。
