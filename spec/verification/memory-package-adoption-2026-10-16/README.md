# MemoryパッケージのEumenes導入検証

2026-10-16。ユーザーの目的は普段のEumenesで使うことであり、隔離環境の試験は事前確認。普段の環境への登録まで実施した。

## 実環境への登録結果

- 通常の `bun run start` で既存 `data/eumenes.sqlite3` を使い起動。Memoryは enabled / healthy、既存の保存済み接続もready。初期化・DB削除・接続設定の再設定は実施していない。
- 認証済みAPIを通る通常のCLIで preview → import → list → 同一import を実施。
- Seed50件の内訳はState28・host_procedure18・continuity4。State28件を未確認候補 `agent_inferred` として登録し、22件は保留。元のSeedや出典本文をこのリポジトリに複製していない。
- 既存6件（有効3件、過去版等3件）は、ID・revision・本文・出典を含むDTO全体が一致。全件数は6→34。Memoryの接続設定・健全性も前後で一致。
- 登録した28件すべての候補出典を読める。会話の本人発言は捏造せず、候補資料からの引用として提示。
- 同じSeedを再投入した結果は `unchanged / registered: 0`。
- 普段のEumenesの `memoryContext("main")` で28候補すべての本文が長期文脈に含まれることを確認。既存記憶を含め13,281 / 16,384 bytes。会話で返答を生成する実LLM試験は未実施で、文脈反映の確認と区別する。

本文を含まない集計は `verification-reports/memory-adoption/usual-seed.json` と `usual-context.json`。同フォルダはローカル検証用でgit管理外。Seedの正規化済みdigestは `8c28c95bde4f7bc66c95e06051e515c26e70b0472312f1a54687d326efb3d03d`。

## 固定試験と契約

変更前はMemory・Steward・会話側Memory結合の248件成功。実装後の最新集計は後述。追加試験は架空データであり、実Seedを正解データにしていない。

- 公開API・clientでプレビューと登録、既存キーの保留、Memory OFFの保持、候補出典の表示を確認。
- 重複識別子・不整合なUTF-8範囲・確認済みoriginの偽装など契約違反を拒否。
- 容量超過は全件保留、2件目の出典保存で例外を起こす対照検査ではState・出典・受付記録の全件巻き戻しを確認。
- 訂正・部分忘却後の再投入防止、確認済みと候補の統合での由来の非昇格、統合履歴経由の候補出典削除を確認。
- import前とimport後の古いDBへ戻す2条件で、忘却journal再適用と再投入による復活防止を確認。
- 実際の名前付きmigrationで旧環境を再開し、記憶・会話・接続設定を保持することを確認。
- 同一更新連番の並びを含むページングで全版を取得し、権限外scopeを拒否することを確認。
- Stewardの実queue経路で、入力のkey・origin・件数と、通常update・明示訂正・否定を持つ再確認の出力反映を確認。

既存の1,100過去版の忘却試験は、人工的な負の連番を正の同一連番へ変更した。新版カーソル契約は1以上が必須である。履歴件数、全版削除、他principalの保護という期待値は一切変更していない。旧Web移行fixtureは、新設したtool@2を過去版の集合から除外した。旧版保護の期待値は維持。

## 起動障害と移行

最初の起動はMemory外の `tool:web.lookup@1` のschema fingerprint衝突で停止。本人に起動障害への対応範囲を確認し、初期化の許可も受けた。旧schemaを保持した新schemaKey・tool@2と、既存data-driven bundleの新版参照・pinへの修正で解消した。登録済み定義やDBを強制上書きしていない。

新しい回帰試験では、旧版を導入したDBから新版をseedし、旧定義の本文・hashが不変であること、新packageがtool@2を使いvalidateできること、再seedしても不変であることを確認。Capabilities全66件成功。現在の検索schemaの条件・期待値を緩和していない。

## 最終検証の状態

- Memory・Steward・会話側Memory結合・Memory adapter: 277成功 / 0失敗。
- Capabilities: 66成功 / 0失敗。検索文脈の既存試験も個別に成功。
- client core: 91成功 / 0失敗。
- Memory単独の規定ゲート: 境界・サイズ・書式・lint・型検査・130試験は成功したが、並行作業によるsource変更で最終判定がinvalidated。
- Memory + Stewardの規定ゲート: 別領域の型エラーで停止（agent-runtime/web-read-plan、dialogue/generation-handler）。Memory + Steward + Dialogue: 別作業中のDialogueファイルの書式で停止。担当外の実装や期待値は変更していない。
- ブラウザE2Eは未実施。新しい画面や操作を追加せず、既存adapterの出典ラベルのみ変更したため、API・client・adapter結合を確認した。
- 単体Examplesで得た過去の実モデル試験結果は、このEumenes統合の実モデル成功結果として数えていない。

最終再検証では、Memory・Steward・会話側Memory結合・Memory adapter・Capabilities・検索文脈をまとめた366件がすべて成功（52ファイル、2,688 assertions）。client coreは91件成功。

4 domain（memory / steward / capabilities / dialogue）の規定ゲートは、境界・サイズ・書式・lint・DesignSystem型検査とbuildが成功し、選択範囲の型検査で担当外2ファイルの8件により停止。場所は `api/domains/agent-runtime/service/web-read-plan.ts`（nullable引数とfindLast、7件）と `api/domains/dialogue/service/generation-handler.ts`（selection出力の型、1件）。全体型検査は上記に加えapplicationとweb-researchの別変更も含む5ファイル11件。今回のMemory・Steward・lookup版管理に型エラーは報告されていない。型エラーを無視する設定や期待値の変更は行っていない。ゲート報告は `verification-reports/runs/2026-10-16T11-07-34-654Z-41604e85-73d1-4043-973e-fe157da16806/report.json`。

最終時点でも通常APIのMemory状態は enabled / healthy。サーバーを起動したままにしており、次の普段の会話から候補を参照できる。今回、会話でのモデル返答・訂正・忘却を実データ上で試すことはしていない。訂正・忘却の破壊的な確認は架空データの試験に限定した。

## 差分の点検

意味の抽出・分類・同義性・訂正対象・会話中の操作選択は既存LLMへ委ねた。追加したコードは、構造化Seedとの接続、容量・上書き権限の制約、原子的な保存、出典整合性、忘却時の派生削除と再投入防止、外部契約のページング・版管理に限定。人物名・本文の語句・シナリオ別の条件分岐や辞書は追加していない。World・Web調査などの並行変更は維持し、検索定義の衝突修正に必要な箇所以外は編集していない。
