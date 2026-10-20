# ブラウザScript・進捗UIの実装記録

2026-10-20。対象設計は[実行Script・進捗と接続承認省略](../../browser-script-progress-ui-design-2026-10-20.md)。ユーザーの実装依頼に基づきmainで作業した。着手前からあるBraveのパス候補・OSファイル選択の変更を維持した。製品設定の変更、サーバー操作、実ユーザーのBridgeトークン取得は行っていない。

最新の反復コードレビューと追加修正は[レビュー記録](review.md)を参照。以下は初回実装時の記録で、レビュー後の最新検証結果は同記録にまとめている。

## 実装した範囲

- 入力は既存のチャットを使う。ブラウザアーティファクトは「操作」を初期表示とし、実行Script、手順の状態・到達条件、結果、折り畳んだ履歴、中止を表示する。プロンプト欄・マイクは追加していない。
- 接続・URL・タブ操作と撮影画像は補助タブに置いた。Braveの場所・ファイル選択・Bridgeの承認設定は設定セクションへ移した。既存ArtifactPanel、OpenUI登録view、既存browser resourceを使い、独立した画面の枠は作っていない。
- ScriptはLLMが登録ツールで公開する。hostが手順IDを発行し、改訂番号・taskのepoch・状態・期限を検査する。Script未公開や古い改訂に対応する操作を拒否し、操作台帳と同じwriterで関連を保存する。撮影も受付と実行時に参照を検査する。
- 手順の完了申告は同じtask・現行世代・最新の観測参照を検査する。taskの終了と手順の完了は別に扱い、中断した「実行中」は現在も動いているように表示しない。実行履歴には既存operation台帳の順番・状態・Scriptの版も表示する。台帳は既存の7日保持に含まれる。
- 現在の会話のtaskを表示し、複数のtaskは選択できる。進捗の更新だけで閲覧対象を変えない。続きの依頼は既存のcontinueFromと期限付き一回限りの承認を使う。
- 接続省略が有効なら新しい依頼を未接続でも受け付け、対象・観測なしを明示した状態からScriptを公開して接続できる。接続終了時の既存停止処理を維持し、前の操作を再実行しない。送信・購入・公開・削除・入力値等の承認を省略する機能ではない。
- トークンはsettings domainで既存の秘密設定用キーによって暗号化する。GETは登録有無・有効状態・利用可否・改訂番号だけを返す。専用の認証済みPUTへ渡し、Artifact outbox・source・LLM snapshot・receiptには入れない。設定変更は改訂番号で競合を検出し、古い接続を即時利用不能にして切断する。画面は保存の成否にかかわらず入力したトークンを消す。
- backend内で読み出したトークンだけをMCP子プロセスの `PLAYWRIGHT_MCP_EXTENSION_TOKEN` に渡す。他の製品秘密や環境変数は転送しない。接続用のextension URLはadapter境界でタブ一覧から除外する。
- PiPは未実装。静止画をライブ映像の代用として追加していない。

意味理解・計画・手順選択は既存の単発型エージェント核とLLMに置いた。YouTubeや個別発話を判定する条件分岐・辞書・固定クリック列は追加していない。コードの専用処理はScriptの保存・参照整合性、画面表示、公式MCPの接続仕様、権限・秘密の扱いに限定した。

## 登録と移行

| 種別 | 追加した版 |
| --- | --- |
| toolchain / binding | browser.operate@4、browser.capture@4 |
| package / skill | browser.operate@3、browser.page-operator@3 |
| tool | browser.task.start@3、browser.page.script@1、browser.page.connect@1 |
| artifact | browser.workspace@4、settings.browser@1、settings.hub@7 |
| schema | browser-bridge-setting@1 |
| migration | browser/0003-scripts、settings/0007-browser-bridge |

既存bundleの定義・文書はキー順を含め変更していない。旧browser bundleを登録したDBからのseedで既存revisionのJSON・hash等が変わらず、新版が登録され、二度目のseedが冪等であることを固定試験で確認した。

Script用ツールを加えた当初、受付packageの必須コンテキストは17,978 bytesとなり、既存16,384 bytes上限に抵触した。重複した説明を整理し15,365 bytesへ縮めた。上限と最大12推論は変更していない。実LLMで必要な操作回数に収まるかは未確認。

## 検証結果

| 段階・対象 | 結果 |
| --- | --- |
| browser単体とapplication/browser結合（最終再確認） | 227件成功。Script前の操作拒否、観測なしの完了拒否、改訂競合、取消後の書込み拒否、未接続受付→Script→接続、credential改訂失効、既存操作承認・続行、認証済み秘密設定APIを含む |
| settings domainの固定試験 | 41件成功。Bridge暗号化、読み出し非露出、失効、キー喪失・不一致を含む |
| browser Web | 24件成功。sourceからScript・エラーを維持、会話での絞込み、settings view、保存後のトークン消去、専用APIへのローカル配送を含む |
| Artifact UI package | 330件成功 |
| 選択domainのverify | browser / capabilities / tool-runtime / inference / dialogue / voice-dialogue / deliveryで成功。Bun 993件、Web 82件、DesignSystem 26件。境界・SystemContext・容量・format・lint・型・DesignSystem buildを含む |
| ブラウザの画面受入 | `bunx playwright test tests/browser/browser-workspace.spec.ts` 3件成功。実際のArtifactPanelとArtifactRendererを使用。320/420/700px、初期Script、選択を保った進捗更新、補助タブ、設定への移動、トークン入力消去、横溢れなしを確認 |
| build・型・変更対象lint | Web build成功、全体型検査2,222ファイル成功、変更対象lint成功。buildには既存の大きなchunk等の警告が残る |
| bundle check | browser.bundle.json、settings.bundle.jsonともissueなし |
| 実LLM・実Brave・ASR実機 | 未実施。画面fixtureの成功で代替しない |

選択domainのverify記録: `verification-reports/runs/2026-10-20T14-08-04-367Z-98e69af5-025e-4fee-8f6e-7d6621f665d8/report.json`。その後、接続開始のwriter内にも取消・epoch検査を追加し、browserの単体・結合227件、型、lint、buildを再確認した。製品サーバーへ接続するE2E fixtureは起動していない。

### 既存の問題で通過していない検証

- settingsを含むverifyは `web/src/domains/settings/useSpeechModels.ts` の既存依存違反 `settings -> inference` で停止した。このファイルは今回変更していない。settingsの所有試験と今回の変更対象の型・lintは別途確認した。
- artifactを含むverifyは未変更の `packages/artifact-ui/src/composition-fixer.ts`（827行）、`ui-studio-components.tsx`（974行）の既存容量超過で停止した。今回増加したcontractsとbrowser serviceの容量超過は、ブラウザのview登録とtask APIをそれぞれ同責務のファイルへ分離して解消した。未変更の2ファイルの上限は変更していない。
- 追加で実行した `api/application/settings/settings-adapter.test.ts` の1件は、既にactiveでない `artifact:settings.ai-connections@7` を指定して `artifact_not_found` になった。既存bundleでは@8がactiveで、今回@7/@8は変更していない。担当外の期待値は変更していない。同時実行した他の134件は成功した。

これらの検証を全成功と記録しない。未変更箇所の修正は今回の範囲に追加していない。

## 画面の記録

以下は生成デザインではなく、固定データを既存ArtifactPanelで表示した画面。ライブブラウザ映像ではない。

- [操作とScript・420px](artifact-420.png)
- [ブラウザの設定・320px](settings-320.png)

## 残る受入

- 実際のBrave profileとBridgeで、初回登録後、再接続・backend再起動後に手動承認が省略されること。無効・失効トークンの終了と、接続対象として扱えるタブの範囲。公式実装が環境変数からtoken付き接続URLを作ることはインストール済みPlaywrightのソースで確認したが、Bridgeの実挙動は未確認。
- 実LLMでASR・テキストの依頼から担当選択、Script公開、操作、観測による進捗、結果まで到達すること。動画の例に加えて異なる対象でも確認し、必要な推論回数を記録する。
- 実接続中の取消・期限・通信断・再起動後の表示。固定試験は失効と再送しない契約を確認しているが、実機受入を済ませたとは扱わない。
- PiPは別の採否判断。今回の実装完了・固定試験成功は、設計のD1/D5を含む実機受入完了を意味しない。

contextStill: 今回context_compile 1回・compile_eval 1回。会話累計は各5回。
