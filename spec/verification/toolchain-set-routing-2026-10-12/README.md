# ツールチェーン定形セット化の検証記録(2026-10-12)

対象: [設計](../../toolchain-set-routing-design-2026-10-12.md) 第15章の実装。実施者は検証担当(別エージェント、Sonnet)で、実装者は試験を実行していない。各回の間に実装者が修正を入れている。fixture・live・実機器を分けて記録する。

## 第1回(実装直後)

fixture:
- typecheck 5件・lint 2件・format 25ファイルで不合格。size-budgetで4domainのverifyが停止。
- api試験 1580件成功・10件失敗、web/client 616件成功。
- 実装の不具合: 手順の成功回数の二重計上、query embeddingの`priority`欠落、lint、サイズ超過。古い試験の期待値: capabilitiesのupgrade試験2件、toolchain.test.ts 2件、検索失敗後の`canInvoke`。

live(隔離DB・保存済みLARM接続):
- 候補検索 recall@4: embedding併用は送信値を補えば1.0(25/25)、文字一致のみ0.48。そのままではLARMが`priority`なしのqueryを400で拒否。
- 天気・株価: 2件とも `package:web.recipe@1` で完了したが不合格(検索抜粋だけで報告、出典なし)。

## 第2回(修正後)

fixture:
- lint・format・size-budget・SQL境界・domain表・webビルド成功。typecheck 1件(playground.tsの型)。
- api試験 1592件成功・5件失敗(本変更起因は古い試験の期待値1件、残り4件は並行作業の音声・言語判定)。web/client 622件成功。

live:
- 候補検索 recall@4: embedding併用 1.0(25/25)、文字一致のみ 0.48。
- 天気: 手順キャッシュ検索→検索→本文読取(tenki.jp)で内容は正しいが、最終回答に出典リンクがなく不合格。
- 株価: Yahoo Financeの読取りがWebガード(`web_guard_requires_approval`)で拒否され、別URLを読まずに終了。回答は取得不能を正しく伝えた。

## 第3回(修正後)

fixture:
- typecheck・lint・format・size-budget成功。
- `verify:all` は design-system の型チェック(本変更と無関係の既存エラー)で停止。以降の段階は手動で実行し、api試験 1597件成功・失敗0件、web・client・design-system試験成功、webビルド成功。Playwrightは未実行。
- domain verify: capabilities・dialogue・agent-runtime・tool-runtime・larm成功。toolchain-historyはdomain試験がなく停止(その後、domain試験を追加。未実行)。

live:
- 候補検索 recall@4: embedding併用 1.0(25/25)。登録済みexamplesでの整合確認であり、一般化性能ではない。
- 天気・株価: 第2回と同じ理由で不合格(出典リンクなし、Webガード拒否後に別URLを読まない)。

実機器: 未実施。

## 第3回以降の変更(未検証)

- 調査担当のSystemContextを定形セットそのものにした。`web.recipe` は汎用の経路方針(`quick-search.md`)を使わず、専用profileとSKILLをsystemの経路方針とし、本文をデータ欄に重複させない(runtime metadata `context:"set"`)。SKILLは失敗時の別URL読取りを含む手順として一本化。
- 手順の採否・成功/失敗の判定を application から toolchain-history domain(`settleRecipesInTransaction`)へ移した。
- 操作担当の契約違反ログに、提示していないツール名(モデル出力)を出さないようにした。
- toolchain-history の domain 試験を追加。
