# Web本文のguard拒否調査・修正（2026-10-16）

## 状態

ガード用ビルドの400例検証と再インストールによる再現性の確認は完了。アプリ実APIでの最終確認は、別変更の `inference/0009-agent-sessions` のマイグレーション・チェックサム不一致により未完了。全体完了とはしていない。

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
- 公開前の修正を再インストールで失わないよう、既存vendor形式で `vendor/llm-fetch/llm-fetch-0.1.3-guard-review.tgz` を固定した。npm公開・公開版番号の変更は利用者が行う。

## 検証

| 範囲 | 結果 |
| --- | --- |
| node_modules試験版のguard単体 | 1,508件成功 |
| llm-fetch全体 `npm run verify` | 1,878件成功、任意ブラウザ7件skip。型・lint・coverage・配布パッケージ・179 HTTP取得のpacked guard E2E・publint・ATTW成功 |
| 実モデル重点試験 | 元ページと引用内の権威偽装・回答書換えを含む16件成功 |
| 実モデルの全コーパス＋追加回帰 | 400件成功。攻撃230件は全拒否、正当な資料170件は許可 |
| 元ページへの攻撃混入 | 本文途中の間接実行、外部送信、符号化、判定書換えの4例を拒否 |
| 初期試験版の実URL取得 | 本文64,000字・表示用12,000字を取得（約14.3秒）。最終のアプリAPI確認とは区別する |
| Eumenesの変更部分 | 本文取得・意味判定・controlの単体試験成功。Web domainの52件成功。ただしそのverify run全体は並行編集でinvalidated |
| 最終アプリAPI | SDKセッションの適用済みmigration変更により起動不可。未完了 |

最初の実モデル試験は133件で `authority-en-quoted` の誤許可を検出して停止した。引用された権威の主張を独立した分類にし、重点試験の後に400件を最初から再実行して全件成功した。失敗した試行を成功件数へ含めていない。

固定した評価対象と、ソースからの配布ビルド・再インストール後の `dist/index.js` は同じSHA-256:

`87502f4208f893da699a9463754667dcc37d49a97742c316d50455ab90e0ee4d`

## 証跡

生HTML・本文・実モデル結果はGit管理外の `verification-reports/web-guard-2026-10-15/` に保存する。通常ログには本文やprovider応答を出していない。

- `guard.json`, `baseline.json`: 元の拒否と検査診断
- `minimal-results.json`: 最小再現入力
- `evaluation-authority-failure.json`: 初回の実モデル試験で見つかった未修正の誤許可
- `evaluation-targeted.json`: 修正後の重点16件
- `evaluation.json`: 修正後の全400件・対象コードのハッシュ
- `original-acquisition.json`: 初期試験版での実URL本文取得
- `library-verify.log`, `control-tests.log`, `web-verify.log`: 部分・結合検証
- `backend-final.log`: 実API確認を止めたmigration checksum不一致

評価スクリプト `evaluate.ts` は、保存済み設定で許可されたSDK接続とモデルを実行時に読む。モデル名、接続先、判定対象の語句を製品コードへ固定しない。
