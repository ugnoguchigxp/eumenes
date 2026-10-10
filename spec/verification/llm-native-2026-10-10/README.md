# LLM-Native 実装・検証記録（2026-10-10）

S1〜S7の実装、fixture・データ追加試験と文書更新を行った。接続設定の環境変数依存を撤去し、部分検証の後に最終全体gateを実施する。liveモデル、実Web取得、実機器の受入結果は下記に区別して記録する。fixtureの合格を意味判断の正答率や音声MVPの完成として扱わない。

## 作業の基準と実装

開始時HEADは `30f9524905f8fdf281a53b7c207c467d27e2f1e5`。未コミットの並行変更がある作業ツリーに実装した。開始時の [status](baseline-status.txt)・[diff](baseline-diff.txt) を保存し、既存の取得先専用処理の削除、Luna接続、既定のquick Web経路などを維持した。コミット、製品DBの起動・migration、秘密のコピーは行っていない。

| 段階 | 実装・fixtureで確認した内容 |
| --- | --- |
| S1 | 非実行JSONのrequirement profile、strict JSON Schemaの限定サブセット、immutable revision、CAS、無効化・再有効化と失効。認証付きAPI、client、CLIから登録・閲覧・管理 |
| S2 | profile/SKILLの実本文、依頼全文、profile snapshotをモデルへ渡す。最初のinvoke/finishと同じsavepointで要件を凍結し、実行失敗時は凍結もrollback |
| S3 | finish候補→同じengineによるツールなしの意味検証→V3報告の採用。unknown/null、型、全check、原文網羅性の検証結果、claims/checks/externalRulesの全根拠、失効・取消・期限と共有修復予算を検査 |
| S4 | 語彙ゲートと文言による抑揚補正を削除。全6候補を一回のjudgeへ渡し、引用・否定を保持。説明・設定は配布対象のspeech-delivery.v1.json。失敗時は保存済みの手動設定 |
| S5 | 全タイマーのラベル、残時間、状態、部分一覧・失敗を構造化して回答モデルへ渡す。回答直前のrefresh、操作一回性、採用時の再照合を維持。user本文を文字列判定で書き換えない |
| S6 | 最終ASRに一回の言語control（256 tokens・8秒）。モデルが言語を判定し、コードが許可リストを照合。ASR・言語receipt・voice policyの権限を回答/操作/TTSへ引き継ぐ |
| S7 | 共通runner・固定資料adapter・API登録で新しいprofileを処理。既定/Luna経路を別々に試験し、意味評価はuncheckedとして出力。domain、全体gate、live、実機器の結果を分離 |

配布済みmigration・旧builtin revisionの内容を変更せず、`agent-runtime/0005-requirements` と `inference/0007-control-policy-binding` を追加した。旧位置番号DB、新DB、再起動・再適用は既存golden migration試験を含む隔離DBで確認。V1/V2の保存報告readerは維持し、新規調査はV3を生成する。要件の契約・候補はtask削除と保持期限に従って削除する。

## 初期再現との対応

[初期再現](baseline-reproduction.json) では、日本語中のAPIを拒否し、en設定でフランス語を許可していた。変更後は文字種判定を削除し、ja/frのモデル結果と許可リストの組合せ、許可外・判定不能時の会話/TTS停止、判定中取消とlate receiptをfixtureで確認した。モデルが実際に正しい言語を返すかはlive未検証（要件suiteの停止条件で一括実行を止めたため、言語suiteに到達していない）。

同じ再現記録の暗黙の祝福は候補ゼロだった。現在は明示語の有無によらず全候補をjudgeへ渡す。否定された「注意」に反応する抑揚補正は削除し、語句が異なっても手動設定を保持する。タイマーの二件という定型文は、両方のラベル・残時間・状態を含む入力へ置換した。既存fixtureの旧専用取得や自動prefetchへの依存は、共通ツールを明示して選ぶ合成モデル応答へ更新した。

開始時の対象fixtureはcapabilities 12件、他の対象domain 244件が成功していた（[記録1](baseline-verify.txt)、[記録2](baseline-tests.txt)）。この数は全体gateの件数ではない。

## データ追加だけの確認

人工資料は `api/application/testdata/llm-native/` のJSONに保存した。催しの締切/料金、施設の時間/年齢、製品の規格/firmware、宿泊の取消、機材レンタルの年齢/保証金を、既定engineとLuna engineで処理する。型、outcome、check状態とJSON値を厳密に比較し、意味の正しさはstubで保証しない。

最初の [基準](product-baseline.json) の後で第三シナリオの製品データを追加した。その後CLI一覧の省略引数が文字列undefinedになる通信上の不具合を修正したため、当初のデータ追加受入を最終合格根拠には使わない。[再基準](product-baseline-after-cli-fix.json) の後に未使用の宿泊シナリオを追加した。

最終確認で、既存のdata/除外によって表現設定JSONがGitの配布対象とhash対象から漏れていたことを見つけた。該当JSONだけを追跡対象にし、動作資産を含めた [最終基準](product-baseline-final.json) を取り直し、未使用の機材レンタルシナリオを追加した。これは意味判断・共通prompt・builtinの変更を伴わない。[再照合](product-recheck.json) では製品706ファイルのdigestが投入前後で一致し、変更0件。このデータ追加試験の後で保存済み接続の読み取りと共通の形式説明を修正しているため、上記digestが現在の全製品コードと同一であるという主張には使わない。

最終digest: `bc71cc237c0aec2715adef8fb7f93eec2082de9759988ce4933f82e4207e30ab`。対象はapi/client/cli/web/packagesの製品コードと資産。test/tests/testdata/__tests__、test/fixtureファイル、生成物を除く。試験データは全30ケース（要件20・表現5・言語5）。要件fixture20件とAPI/CLI往復1件が成功した（[21件の記録](data-only-fixtures.txt)）。

モデルは合成応答（Luna側もfixture-luna）であり、通常の単一資料ケースで worker 3回＝read判断・finish・verify、会話の開始/最終回答を含めてモデル計5回。意味検証は1回、構造修復は全phaseで合計1回まで。通常会話は従来の一回生成を維持。言語判定は非空の最終ASRに一回、空ASRとpreviewは0回。非空回答の表現判定は全6候補を一回判定し、既存の回答・チャンクreceipt再利用を維持する。

[data-only-fixtures.txt](data-only-fixtures.txt) の約60ms前後は合成モデル・人工資料の隔離試験時間であり、実推論・通信・表示開始・音声開始の性能ではない。以前より高速化したとの評価は行わない。

## live・実Web・実機器

初回の [live記録](summary.md) / [構造化結果](results.json) の60 skippedは、作業者が誤って接続先の環境変数を前提にした結果であり、保存済み接続設定がないという根拠にはならない。この判定を廃止し、backendのsettings domainがSQLiteからLARM接続設定だけを読み取り専用で取得する。通常推論・live検証とも保存済み接続先を使い、製品DBのmigrationや設定変更は行わない。テスト用接続先は認証付き設定APIで保存する。

[保存済み設定でのlive記録](live-saved-settings/summary.md) / [構造化結果](live-saved-settings/results.json) では、既定モデルgemma4-26b-a4bに接続し、最初の人工資料ケースを2回実行した。接続成功、skippedは0件。値schema違反と報告形式違反により採用できず、一括実行を停止した。これを受け、モデルへJSON Schemaの受付制約・全要件のIDとcheck契約を明示し、schema違反も既存の一回だけの構造修復予算に含めた。語句や対象に対応する処理は追加していない。[修正後のlive結果](live-final/summary.md) も2回とも受入未合格。1回目は実モデルで取得・finish・意味検証・V3採用まで完了したが、モデルが登録profileを選ばず、登録した型付き確認項目の比較を満たさなかった。2回目は値schemaの形式違反が一回の修復後も残り、ツール実行前に拒否した。プロファイル選択欄に適用判断の説明を追加した最終差分のfixtureは確認済みだが、その説明を加えた後のlive受入は未完了。結果を合格に丸めない。

[実Web laneの記録](final-web-live.txt) では保存済み接続設定で隔離backendを起動し、実モデルで長文資料のケースを2回実行した。依頼原文の引用契約と値schemaの形式違反により取得前に拒否し、停止条件に従って一括実行を止めた。実Web取得の合格にはしていない。以前の [preflight](web-live-preflight.txt) は廃止済みの前提に依存した失敗であり、接続不能の根拠にはしない。SSRF guardは維持した。

実機器の日本語＋API、二件タイマーのラベル/残時間、調査または判定中の割込みという最低3往復、許可外言語・判定不能表示は未実施。録音・実会話・Provider生応答・認証情報を成果物へ保存していない。音声MVP完成とは宣言しない。

保存済みの接続設定を使って、`EUMENES_LIVE_LLM_NATIVE=1 bun scripts/llm-native-live.ts --suite all --cases api/application/testdata/llm-native/cases.json --out <別の結果ディレクトリ> --repeats 2` を実行する。要件はliveモデル＋固定人工資料、言語はテキスト判定のlane。取得・ASR・実機器は別に確認する。意味確認欄を人が評価するまでuncheckedを合格にせず、二回の再現可能な失敗はbatch停止条件にする。

## 製品差分の原則適合レビュー

削除対象のasr-language/speech-intonation/timer-phraseとdelivery evidence語彙ゲートに製品参照が残っていないことを確認した。意味判断はモデルの入力・プロンプトへ移した。case IDによる製品分岐、シナリオ語句の辞書・regex、正答の埋込みは追加していない。fixtureの合成応答と期待値はtestdataに閉じ込めた。

コードに残した条件分岐はschema keyword/ID/URL/固定protocolの検査、CAS・世代・根拠・receiptの権限検証、保存と採用、token/byte/件数・時間・数値範囲、supported等の結果照合。これらは実行契約と安全制約を強制する最小範囲であり、資料や発話の意味を分類しない。profile登録でツール権限は増えず、外部ルールは管理APIへの明示登録なしにprofileにならない。ログは固定code・安全な項目位置・件数に限定し、動的JSON keyの内容も反射しない。

既定quick Webの検索1回/取得1回/モデル最大5回と、Lunaの探索枠は並行作業の仕様を維持した。quick枠の上限内で不足した場合は不足として終了し、旧専用取得経路へfallbackしない。根拠全文・要件・依頼が制限を超えた場合も切捨てて成功にせず、明示的に失敗する。

コンテキストMCPの実行回数: initial_instructions 1回、context_compile 1回、compile_eval 1回。

## 追加の静的確認

`git diff --check` は成功。計画の全体gateとは別に実行した `bun run deadcode` は、現在の作業ツリーのexport 312件・exported type 278件を未使用として検出し終了1となった（[出力](additional-deadcode.txt)）。公開contract・schema、既存のdomain公開API、試験から利用するexportも検出対象になっている。本計画のverify:allにはこの確認は含まれず、Memory/World等を含む全公開APIの削除やknip設定の変更は実施していない。この追加確認が成功したとの主張はしない。

## 検証の順序

最終の実装変更をすべて終え、対象domain・接続設定の部分検証、その後にverify:allによる通し検証を行う。先行する [全体gate](full-gate.txt) は変更前の2923成功・2 skip（約394秒）であり、今回の最終差分の結果とは分ける。最終結果は別ファイルへ記録する。

最終部分検証: [185件のbackend/API/CLI・要件fixture](final-partial-tests.txt) が成功、[ブラウザの接続・音声2件](final-partial-browser.txt) が成功。settings domainの [専用検証](final-settings-verify.txt) と [変更対象のformat/lint・全体の型確認](final-partial-static.txt) が成功。全体gateはこの部分検証を終えてから実行する。

## 最終の通し検証

実装変更を完了 → 部分検証185件・ブラウザ2件 → `bun run verify:all` の順で実施した。[最終ログ](final-full-gate.txt) / [runnerの元の判定](final-full-gate-report.txt)。backend 1231件、Web 253件、client 329件、DesignSystem 1086件、browser 42件の計2941件が成功。skipはbackendの実local provider 1件と環境条件付きfake-microphone 1件の計2件。format、lint、型、SQL/依存境界、サイズ、domain文書、buildも成功。所要406506ms（約6分47秒）。

runnerの終了値は1。全stepが通った後、同じ作業場所の別の検証が生成した `spec/verification/llm-native-remaining-domains-2026-10-10/verify-all-freshness-failed-report.json` をソース変更と判定した。記録を削除・変更せず、その追加ファイルだけを除いてrunnerと同じ順序で全入力のSHA-256を再計算したところ、開始時revision `423b0082b5c84d9ad113acc34e8ce6921f2baf598866e117d627240fc8177f0b` と完全一致した（[同一性の確認](final-input-freshness.txt)）。試験対象の元のコード・資産・fixtureには変更がない。通しの全試験は成功しているが、元のコマンドを終了0として書き換えていない。コードが同一と確認できたため全試験の一括再実行は行わない。

[最終status](final-status.txt) / [差分の範囲](final-diff-stat.txt) を保存した。未コミットの並行変更を含む作業ツリーであり、他の変更をこの計画の成果として数えていない。製品コードにシナリオ別の語句判定や専用正答は追加せず、最終差分も原則に照らして確認した。接続先の環境変数参照はコード、設定例、現行手順と過去の手順から撤去。AGENTS.mdにも保存済み接続先を再確認しない規則を残した。設定そのものと秘密の変更は行っていない。

実装・fixture・通しの試験は完了。live受入は要件の選択と形式違反で未合格、Luna/表現/言語suiteの一括受入は停止条件により未完了。実機器3往復も未実施。これらを実装やfixtureの合格と混同しない。
