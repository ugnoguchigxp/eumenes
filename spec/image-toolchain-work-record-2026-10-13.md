# 画像生成ツールチェーン作業記録

目的・範囲: LARM画像生成、会話の担当選択・回答、OpenUIのプロンプト編集／画像履歴タブ、拡大・取得を接続する。既存音楽、メモリー、設定の未コミット差分を保持する。新規ライブラリ、参照画像編集、画像の自動分類は対象外。

再利用: capabilitiesの登録・検索、inference control receipt、queue、dialogueの操作受付・取消・再開、LARM playgroundの同期画像生成と認証済み取得、OpenUI JSONと共通Renderer、DesignSystemのTabs・GenerationStatus・ImageViewer。
専用部分の根拠: 画像APIは同期POST、任意100〜1280寸法、PNG/WebP、Control上の画像一覧・取得であり、音楽の非同期ジョブと音声契約には入らない。画像domainに生成状態・依頼・計画・LARM成果物参照を保存し、画像実体の正本はLARMに置く。

接続: toolchain:image.create@1 / function image / package:image.create@1 / profile・skill:image.create@1 / tool:image.generate@1。会話引数は共通request。担当は生成・画面表示・履歴表示の意図を解釈。schemaとコードが寸法・形式・容量・期限・receipt・取消後不採用を検査する。

外部仕様: 2026-10-13、保存済みsettingsの読み取り専用操作から接続し、SAAA-w-Imageのdescriptionと配備先OpenAPIを確認。model=qwen-image-2.1-turbo、steps=8、POST自動再送禁止。GET /v1/image-artifacts はimagesと容量、GET /:id/content はPNG/WebP。services.urlがあれば優先し、現行endpointも受理。

依存順・完了条件: 1 契約と登録 2 LARM一覧・生成・取得 3 所有domain・migration・queue 4 会話／client接続 5 DS・OpenUI・host・入口 6 部分→結合→全体→live・ブラウザ 7 最終差分点検。正常・失敗・取消・失効、不正schema、再seed、UI合成・タブ・取得を確認する。

実装済み: 登録・依存・runtime公開、画像domainのmigrationとplan/generate、receipt採用、取消・失効後不採用、認証済み一覧・取得、client、DesignSystem/ImageWorkspace・Storybook、OpenUI登録・JSON合成、singleton画像タブと入口。

実施結果（全体検証前）:
- 固定部分・結合24件成功（音楽の既存8件を含む）。生成／表示のみ／不正計画／外部失敗／取得失敗、重複受付、取消後遅着、権限失効、一覧のorigin・ID・MIMEを確認。WebのJSON合成と部品3件も成功。
- 実API生成1回: image_cd1a01e35d7d416198d1fa54df71d26a、512×384 PNG、258329 bytes、13822ms。画像をデコードして寸法・表示を確認。verification-reports/image-live/lighthouse.png と events.json。確認画像はLARMに残す。
- 実LLM一覧1回目: 1f0fded3-2175-4db5-905d-3cfbbc455a91、操作なしに「開きます」と返答。新しいtoolchain summaryを「表示には関数実行が必要」と修正。個別発話を条件分岐で処理しない。
- 修正後実LLM一覧: 334584dd-3547-4ba8-b705-a6243b706090、image関数→action=library計画→結果採用→回答、生成POST0回、LARM一覧35件。verification-reports/image-toolchain/2026-10-13T02-34-26.841Z/（実際のevents.jsonを参照）。
- ブラウザ: プロンプト・任意寸法、タブでの草稿保持、履歴・ダウンロード、生成完了、拡大、狭幅、再読込・再表示を確認。ローカル認証URLの除外を特定し、画像専用の許可パスだけを表示可能にした。既存の一般画像URL許可範囲は拡張しない。
- ブラウザのcold開始から再表示まで21.7秒。初回30秒枠の残りが再表示操作中に尽きたため、既存重いfixtureと同じ60秒枠に設定。期待内容や失敗条件は維持。
- User steering: UIの実装に先行したことを指摘された後はUI作業を止め、実API画像の生成・取得・表示を先に完了し、その後でUI検証を再開した。

最終確認:
- 所有・利用側verify: image、larm、capabilities、dialogue、artifactは成功。dialogueはbackend208件とWeb6件を含む。
- 画像と音楽の固定部分・結合24件、画像ホストとWorkspaceのWeb6件、DesignSystem3件、ブラウザ1件成功。型検査1199ファイル成功、DesignSystem＋Web build成功。SQL境界177テーブル成功、差分の空白検査成功。
- dialogueの初回size gateで、個別runtimeの可否列挙を長くしたため関数長が1増加。共通の必須toolchain registryを検査する形へ置換し、部分・結合・dialogue verifyを再確認した。旧capability版や既存SystemContextを上書きしていない。
- verify:allは着手時から存在する `web/src/domains/settings/MemoryItemsPanel.test.tsx: forbidden dependency settings -> memory` で境界チェック中に停止。担当外のため修正せず、以降の全体gateは未実行。新機能の単体・利用側成功と全体成功を区別する。
- 実APIの生成・画像取得・デコードは成功。実LLMの担当選択・計画・結果採用はlibrary表示で確認した。実LLM経由の画像生成から会話返却までを一続きにしたlive生成は未実施（画像生成POSTは今回1回）。機器依存の操作は本機能にないため実機器試験は対象外。
- 最終差分: 対象発話や題材の専用分岐・辞書・固定応答は製品コードに追加しない。追加した分岐は登録runtime・API引数・状態・MIME・権限・許可取得URLの接続と検証だけ。既存の別作業の未コミット差分を保持。
- 検証証拠は [image-toolchain-2026-10-13](verification/image-toolchain-2026-10-13/) に保存。画像本体とlive経過は上記verification-reportsの専用出力先。
- context_compile 1回、compile_eval 1回（runId 00000000-0000-0000-18dd-f51d9b6052d4）。

残作業・制約: 依頼された実装・固定試験・実LARMの生成・UI受入は完了。全体gateの完了には担当外の設定試験の境界違反解消が必要。担当外の改修依頼なしには修正しない。
