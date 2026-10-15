# Web本文のguard拒否調査・修正（2026-10-16）

## 状態

コードレビューでタイトルの検査漏れを追加修正し、llm-fetchの全体検証1,880件とEumenesのWeb domain検証54件が成功した。アプリ実APIでの最終確認は、別変更の `inference/0009-agent-sessions` のマイグレーション・チェックサム不一致により未完了。全体完了とはしていない。実モデル400例はレビュー前のビルドでの結果であり、分類器の指示・出力検証はその後変更していない。

## 原因

2026-10-15のLuna調査run `7fc388ca-15d0-48df-951e-0da3b244acc0` は正しく `web_research` へ委譲され、検索後の `https://www.explainx.ai/news` の本文取得が `web_guard_requires_approval` で拒否された。Web取得runは `70705385-72c3-4159-8f32-262ded275634`。

理由コードは `PATTERN_DETECTED` と `SEGMENT_TEXT_LIMIT`。ページには約10万字の非表示コンテナがあり、構造化データ・記事・料金説明が結合されていた。2,000,000字の検査予算を明示していても、収集器が各部分を64,000字で先頭・末尾へ切り詰めた。さらに、離れた `tool / Open` や `token / output` が命令として関連付けられた。資料中には、人間向けの正当な実行・保存手順もある。

可視部分だけでは本文が不足するサーバー生成HTMLだったため、検査と意味判定を通した同じ応答の参考本文を抽出する必要もあった。

## 変更

- 既存の明示的な検査予算をHTML・Markdown内HTML・JSONの収集へ渡す。既定の64,000字制限、総予算超過・未検査時の拒否は維持する。
- 英語の参照範囲を狭める試案は攻撃を通したため撤回。元の参照検出を復元した。対象語やサイトの例外は追加していない。
- `llm-fetch` に、全文検査済み資料をホストの独立した意味判定器へ渡す明示的な `contextGuard.review` を追加。切り抜き・最初の一致だけでは許可しない。未検査、過大入力、失敗、不明、取消、追加guardの拒否は許可に変えない。
- Eumenesは既存のinferenceの構造化control、保存済み経路、receipt受理・取消を使用する。会話履歴・実行ツールを持たない1回の呼出しで、文書全体と全検出項目を分類する。権威偽装、エージェントへの命令、秘密要求、不明は拒否する。
- 可視本文が不足する場合だけ、全文の意味判定が許可した同一応答の参考本文を既存selector/Markdown変換で抽出する。スクリプトを実行せず、非表示内容を含み得ることをsecurity limitationsへ残す。
- 本文上限64,000字、Lunaへ渡す表示用本文12,000字、`untrusted / tainted` を維持する。Lunaや会話モデルのContextWindow設定は変更しない。
- 公開前の修正を再インストールで失わないよう、既存vendor形式で `vendor/llm-fetch/llm-fetch-0.1.3-guard-review-v2.tgz` を固定した。npm公開・公開版番号の変更は利用者が行う。

## 検証

| 範囲 | 結果 |
| --- | --- |
| node_modules試験版のguard単体 | 1,508件成功 |
| llm-fetch全体 `npm run verify` | レビュー修正後1,880件成功、任意ブラウザ7件skip。型・lint・coverage・配布パッケージ・packed guard E2E・publint・ATTW成功 |
| 実モデル重点試験 | 元ページと引用内の権威偽装・回答書換えを含む16件成功 |
| 実モデルの全コーパス＋追加回帰 | レビュー前のビルドで400件成功。攻撃230件は全拒否、正当な資料170件は許可。現在の分類器は同一、タイトルを追加収集する現在のビルドでの実モデル再検証とは区別する |
| 元ページへの攻撃混入 | 本文途中の間接実行、外部送信、符号化、判定書換えの4例を拒否 |
| 初期試験版の実URL取得 | 本文64,000字・表示用12,000字を取得（約14.3秒）。最終のアプリAPI確認とは区別する |
| Eumenesの変更部分 | レビュー修正後Web domain verifyで54件成功。前回のInference＋LARM domain verifyで280件成功。いずれもソース固定状態でpass。途中のinvalidated runとは区別する |
| プロジェクト全体の型検査 | 別変更の `api/application/workers-ai-settings.test.ts:143` の `ArtifactListEntry.artifactId` 参照エラー1件で未完了 |
| 最終アプリAPI | SDKセッションの適用済みmigration変更により起動不可。未完了 |

最初の実モデル試験は133件で `authority-en-quoted` の誤許可を検出して停止した。引用された権威の主張を独立した分類にし、重点試験の後に400件を最初から再実行して全件成功した。失敗した試行を成功件数へ含めていない。

実モデル400例を通したレビュー前の `dist/index.js` のSHA-256:

`87502f4208f893da699a9463754667dcc37d49a97742c316d50455ab90e0ee4d`

レビュー修正後は以下のSHA-256となる。ソースマップに含まれる52個のソースが現在のソースと一致し、ビルド出力18ファイルはnode_modulesおよび固定したvendorアーカイブと全て同一だった。

`405b91aaa23759111c61548f6fb2132b8d6ac7e5e44a9528c2ad42fc61bd8e80`

## コードレビュー後の修正

- **タイトルの検査漏れ**: 可視本文の選択に失敗すると、意味判定器にはbodyと除外部分だけが渡る一方、復元後はheadのtitleを返せた。攻撃タイトルが判定器へ届かず `allow` で返ることを再現した。共通HTML収集器へtitleのmetadata収集を追加し、単独guardと本文取得の両経路を修正した。攻撃拒否・正当な隠れた本文の取得・返却上限の結合試験を追加した。
- **旧判定のキャッシュ**: 修正前の許可結果を再利用しないようguard revisionをv3へ進め、旧v2の保存結果が不採用になる回帰試験を追加した。
- **期限切れの受入防止**: 応答しない意味判定器でもreadの期限で終了し、判定器へ渡したsignalも取消される試験を追加した。既存の取消・不正出力・追加guardの拒否の試験も成功した。
- **固定値の更新根拠**: 保存済みHTML5例の検査ハッシュ変更は、追加したtitle segmentを除くと全て旧ハッシュに一致した。従来の検査内容・原文・返却量の要件を保持したまま、新しい完全な検査対象のハッシュへ更新した。初回の全体試験はこの5件で停止し、原因を確認してから全体試験を再実行した。
- **導入物の一致**: ソースで全体検証後、導入用アーカイブを1回作成した。同名ファイルへの置換ではBunが旧導入物を保持したため、同じアーカイブの参照先をv2名へ切り替えて導入した。再パッケージ化は行わず、全出力のバイト一致とWeb domain検証を確認した。

最終差分を安全境界、出力契約、取消・期限、完全検査、配布整合性の観点で再確認し、今回の変更範囲に追加の具体的な指摘はなかった。サイト別例外・語句別の許可・モデルのContextWindow変更は追加していない。実API検証の阻害要因は残っている。

## 証跡

生HTML・本文・実モデル結果はGit管理外の `verification-reports/web-guard-2026-10-15/` に保存する。通常ログには本文やprovider応答を出していない。

- `guard.json`, `baseline.json`: 元の拒否と検査診断
- `minimal-results.json`: 最小再現入力
- `evaluation-authority-failure.json`: 初回の実モデル試験で見つかった未修正の誤許可
- `evaluation-targeted.json`: 修正後の重点16件
- `evaluation.json`: 修正後の全400件・対象コードのハッシュ
- `source-runtime-equivalence.json`: レビュー前のソース・ビルド・導入済みファイル・vendorアーカイブと実モデル評価対象の一致確認
- `review-runtime-equivalence.json`: レビュー修正後のソース・ビルド・導入済みファイル・vendorアーカイブの一致確認
- `review-baseline-delta.json`: 保存済みHTML5例で従来の検査内容が保持されている比較結果
- `review-library-verify-final.log`, `review-web-verify.log`: レビュー修正後の全体・結合検証
- `original-acquisition.json`: 初期試験版での実URL本文取得
- `library-verify.log`, `control-tests.log`, `web-verify-final.log`, `related-verify-final.log`: 部分・結合検証
- `backend-final.log`: 実API確認を止めたmigration checksum不一致

評価スクリプト `evaluate.ts` は、保存済み設定で許可されたSDK接続とモデルを実行時に読む。モデル名、接続先、判定対象の語句を製品コードへ固定しない。
