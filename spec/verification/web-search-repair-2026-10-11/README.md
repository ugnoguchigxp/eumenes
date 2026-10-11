# Web検索修正 A〜Dの実装記録

2026年10月11日。A〜Dのコード・回帰テスト・docsの実装を揃えた。実LLM受入は失敗しており、実動作の完成とは扱わない。最新指示に従い、この実装区切りでは追加の検証・liveを実行していない。

## 実装

- A: researchの入力をkindで分け、Webはquestionのみ、historyはquestionと任意のrequirementProfilesにした。Webのprofileを黙って捨てず、schemaと内部parseで拒否する。既存のhistoryだけで解決する処理と開始側の防御を維持した。Luna公開条件と会話方針・説明の整合は既存差分を保持した。
- B: 既存差分で合成されていた必須規則と短い表現規則を保持した。partial・unknown/unsatisfied・報告なし失敗・未信頼の報告・historyのspeaker/createdAtを扱う規則が揃っている。request・report・参照情報の保持とhistory/報告なし失敗の回帰ケースを追加した。
- C: 一覧は参照・document・可用性のmetadataにし、正確な抜粋はobservationsへ一度だけ計上し、各stepで再提示する。以前の参照内容を固定し、失効した参照を復活させない。一覧8,192 bytes、全体65,536 bytes、根拠64件を維持した。容量到達時は実際の提示ツールとgrantsを閉じる。
- D: 要件抽出・profile・意味検証の試験をhistoryへ移した。10種の要件profileケースを残し、Lunaの10ケースはWebのV2報告・意味検証0回を確認する。旧Webの検索2回・検索前の無許可本文読取・意味検証回数の期待を現契約へ合わせた。検索のfetchモックにはBunのfetch型が要求するpreconnectを補った。本文にだけ数値を置くAPI fixture、Lunaの複数読取、容量停止、失効維持を追加した。docsをquick@2・search@1・history@2の現仕様に合わせた。

資料枠は20,000から32,768 bytesへ変更した。5件×500文字の日本語抜粋と3件の約1,270文字本文のfixtureで、一覧892 bytes、資料21,467 bytes、参照25件、容量到達falseを測定したためである。既存の32 KiB全文一覧・45 KiB資料枠方式から重複を除いた。取得・意味判断・専用株価API・DB migration・inference portの構造改善は追加していない。

Dotsなど担当外の既存差分を保持した。別チャットへの送信、追加エージェントへの委任、コミット、デプロイは行っていない。

## 既に実施した確認

- agent-runtimeドメイン: Bun 51件、Web側9件成功。
- dialogueドメイン: Bun 111件、Web側6件成功。
- web-researchドメイン: 45件成功。
- 検索部分・API結合: 26件成功。長い日本語の検索結果5件からquick本文1件、Luna本文3件を実行して会話回答まで返す2件を含む。意味検証0回。
- 要件profileのAPI fixture: default/history 10件、Luna/Web 10件成功。fixtureは意味判断の正しさを実LLMで保証するものではない。
- toolchainの関連失敗は修正後に通過。historyの該当ファイル15件も最終確認で成功した。
- 全体verifyは一度実行した。境界・サイズ・SQL境界・docs・整形・lintが通り、既知のsearch-locale.test.tsのfetch.preconnect不足で型検査が停止した。モック修正後の全体型検査とweb-researchドメインは成功した。verify:all全体の再実行はしておらず、全体テスト・Web build・ブラウザ等の後続gateは未実施。全体検証済みとはしない。
- 最終の対象整形・lint・サイズ確認は成功。差分を点検し、個別の企業・語句・地域を製品コードで判断する処理を追加していない。

## 単発liveの全経過

入力: マイクロソフトの最新の株価を教えて

runId: dcc4c5b6-a531-4955-ab40-aaf131f90683

担当: 会話側LARM gemma4-26b-a4b。検索担当の起動には到達しなかった。

| 日本時間 | 経過 |
| --- | --- |
| 14:55:39.187 | 保存済み設定によるLARM接続開始。隔離DBを使用し、製品DB・秘密の複製なし |
| 14:55:44.834 | 接続完了。接続準備5.648秒 |
| 14:55:44.845 | API受付、HTTP 202 |
| 14:55:44.852 | 会話モデルの第1呼出し開始 |
| 14:55:48.097 | 第1呼出し生成終了、3.245秒。操作の採用に失敗し既存の内部修復へ |
| 14:55:48.101 | 同じ依頼・モデルの会話側内部修復1回を開始 |
| 14:55:50.586 | 第2呼出し生成終了、2.486秒 |
| 14:55:50.588 | 会話の操作確定でinvalid_conversation_operation。検索担当起動前に終了 |

API受付から終了まで5.756秒。会話モデル2回（既存修復1回を含む）、検索担当0回、最終回答生成0回。検索0回、本文読取0回、要件の意味検証0回（worker自体が未作成のため集計欄はnull）。workerの内部形式修復0回。

生成した検索語（拒否分を含む）: 検索担当が起動せず、記録なし。
実際の検索条件・取得URL・件数・読取URL: 未実行、0件。
拒否code: invalid_conversation_operation。具体的なvalidationPath/codeは会話側で記録されていない。
採用報告: なし。
最終回答全文: なし。answer欄も存在しない。

確認済み原因: nativeツール呼出しを採用する会話の契約確認が、初回と既存修復の両方で失敗した。conversation-generation.tsの最終拒否箇所とqueue.settledのreasonが一致する。検索・本文容量・外部取得の失敗ではなく、それ以前の入口で止まった。

未確認: 具体的なツール名・引数、不正schemaの項目、呼出し件数、本文混在のどれが拒否原因だったか。会話のstream経路は今回のanswer観測ラッパーを経由せず、ルーティング詳細イベントは残っていない。Provider生応答は保存しておらず、今回の記録から復元できない。schema分岐のモデル互換性を原因と断定できない。変更した根拠容量と本文選択指示の実LLM動作も未到達で未確認。

失敗後は製品コード・テスト・プロンプトを修正せず、追加live・別モデル・別プロンプト・天気・Luna確認を実行していない。残作業は入口の拒否理由の特定と実LLM受入であり、この実装区切りでは再開しない。

## 保存記録

pre-live-status.txtにlive前の作業ツリーを保存した。live.jsonは結果と採用報告・回答の有無、events.jsonは安全な実行観測、live-diagnostics.jsonlは運用metadataの記録。Provider生応答・秘密・取得本文を通常ログへ保存していない。

initial_instructionsは1回、context_compileは1回、compile_evalは1回。評価対象runIdは00000000-0000-0000-18dd-63700acb74b3。
