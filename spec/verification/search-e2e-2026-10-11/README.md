# 検索E2Eの作り直しとMSFTの単発確認

製品コードは今回変更していない。対象は検索テストと検証用スクリプト。

## テストの契約

- 従来検索: 地名・株価・天気。Luna: AIニュース。
- 固定モデルと固定Web応答でAPI受付→担当起動→取得→報告保存→会話への引渡し→回答を確認する。
- 成功時は検索1回、取得済み出典、要求した結果、公開報告APIを確認する。ニュースは3〜5項目の箇条書き、Lunaの追加検証0回。
- 失敗時もreportにはfailureとresearchProgressが入る。reportの有無で成功判定しない。親にはエラーと取得回数が渡り、会話が完了しても検索成功とは判定しない。
- 固定応答で確認できるのは接続・契約。実LLMによる担当選択、検索語生成、要約品質が成功した証拠にはしない。
- 株価・天気のfixture値は架空。実際の相場・天気ではない。

## 実行結果

関連単体・結合24件成功、API fixture E2E 8件成功（各1実行）。その後、追加テストの型のみを補正。型チェックに残るのは既存search-locale.test.ts:15のfetch.preconnect不足1件。全体verifyは未実施（今回の限定範囲、既知の型エラー）。実機TTSは未検証。

実LLMは「マイクロソフトの最新の株価を教えて」を1回だけ実行。保存済みLARM接続設定を読み取り、隔離テストDBのAPIを使用。Gemma4の実応答を使い、取得条件の補完fixtureは使っていない。製品内蔵の修復1回は発生したが、手動再試行はしていない。

- runId: 58ebf574-b95e-4bf1-8c54-6e755acf9296
- 11:34:23 JST: API受付。
- 11:34:27: 従来検索package:web.quick@1を選択（約3.52秒）。
- 11:34:39: Gemma4がinvoke/web.lookupを生成。invalid_requirement_schemaで拒否（約11.95秒）。
- 11:34:46: 内蔵修復の応答もinvoke/web.lookup。同じ理由で拒否（約7.37秒）。
- 11:34:50: 親Gemma4の失敗説明が返り、会話完了（約4.24秒）。全体27.16秒。
- Web検索0回、ページ取得0回、報告なし、意味検証0回。Lunaは呼ばれていない。

拒否箇所はrequirement-schema.ts:122→80で、入れ子のstringスキーマのmaxLengthが契約（0〜2000の整数、必須）に合っていない。未指定か不正値か、どのフィールドかは記録不足で特定できない。観測用のschemaSummaryは最上位objectだけなので、そこでのmaxLengthPresent:falseは失敗根拠にはしていない。

検索前の拒否のため、実行された検索語はない。生成途中の検索語は今回の観測記録に含めておらず提示できない。天気の実LLM確認は実施していないため、天気も同じ原因とは断定しない。

最終回答（全文）:
> 申し訳ございません。マイクロソフトの最新の株価に関する情報を取得することができませんでした。

## 再利用

- `bun run test:search`: 固定応答の部分・結合・API E2E。
- `bun run test:search:live -- --case stock`: 株価の実LLMを1回実行。weather/quick/lunaも指定可能。今回は再実行していない。
- `bun scripts/search-agents-live.ts --case stock --check-results spec/verification/search-e2e-2026-10-11/msft-live.json`: 保存結果の判定のみ（LLMやWebは呼ばない）。

テスト中の固有語・正規表現はfixtureの期待値に限定し、製品の意味判断やルーティングには追加していない。既存の別作業差分は保持。
