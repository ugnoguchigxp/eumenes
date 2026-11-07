# ブラウザ部品 F09・F11（2026-11-06）

利用者が承認した、候補の意味判断をLLMへ戻す改修と、撮影範囲を保存前に確認する改修を反映した。

配布版0.1.3、契約3、core state format 1。archive SHA-256は `be8c07de742be96572c1a727e68acf94caafdeb24645d4e377c67dd58c328af5`。正確なファイル一覧とsource tree hashは `vendor/interact/provenance.json` と配布内manifestで固定した。ソースは未commitの作業ツリーで、再現用の製品ソース差分を `vendor/interact/adoption-source.patch` に置いた。

## 接続

- `BrowserDriver.readChoices` → 固定の読取り専用関数 → 観測参照・tab・対象を検査する `PartExecutionPort.choices`。
- `page.capture` のprepareは読取りだけ。saveだけを既存の保存承認へ通し、同じ観測・対象・範囲を確認した参照で保存する。
- `skill:browser.interact.operator@1` は保持した。新しい正本を `skill:browser.interact.operator@2`、生成context、配布物で同期した。package・binding・artifact・adapterの登録ID、初期無効のavailabilityは変更していない。

## 確認

- [関連試験](tests.log): 379件成功、失敗0。browser・capabilities、applicationのinteract結合、dialogueの親実行・質問・取消を確認した。実ChromeのHTTP pilotは汎用の選択肢検査、prepare/save、認証済み回答、WebP保存・取得・削除まで通る。
- [型](typecheck.log)、[lint](lint.log)、[context](context.log)、Skill同期は成功。
- 旧bundleを先に登録した環境と新規環境で、新revisionの追加と再登録の冪等性を確認した。旧operatorの本文は変えていない。
- 広域verifyは、既存の `artifacts/pursuit-integration-20261106/` 内の試験コピーに実行経路がなくinventoryで停止した。除外を増やして通したり、保存済みの別作業を削除したりしていない。

本体の別作業（router・agency・pipeline等）の変更を保持した。稼働中のサーバー・製品DB・利用設定は変更していない。検証用のHTTP/Chromeは試験自身が所有する一時環境である。

実APIの呼出しは追加していない。共有台帳の600回上限に対して596回使用済みで、回数上限の変更は利用者の回答待ち。固定応答試験と実LLMの意味判断の精度は区別する。
