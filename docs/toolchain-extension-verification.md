# ツールチェーン追加の検証手順と基準記録

登録手順と最小例は[ツールチェーンの登録と拡張](toolchain-extension.md)を参照する。本書は検証範囲を決める際の補足と、2026年10月11日時点の記録である。掲載コマンドを登録のたびに全件実行する指示ではない。

## 1. 製品コード・回帰試験コード・記録を先に揃える

実装中は、未完成の経路を通す検証を繰り返さない。まず、必要な変更を接続の末端まで揃える。回帰試験のコードと実装記録もこの段階で作成し、試験実行は次段階へ分ける。

実装を終える条件は次のとおり。

- 公開、担当確定、実行、結果採用、保存、回答まで必要な経路が接続されている。
- 不正入力、権限失効、取消、期限、重複操作、容量到達でどう終わるか定義されている。
- 容量は本文だけでなく、title・URL・schema・依頼・履歴・JSONの枠を含む実際の提示量で扱う。提示済み根拠を追い出したり、未提示の参照を登録したりしない。
- 観測は製品が実際に使うstream等の経路にある。拒否は安全な分類・path・codeと相関IDで追え、本文・秘密・Provider生応答を通常ログに残さない。
- 正常系と再現例の回帰試験コード、変更理由、残作業が揃っている。
- 差分を確認し、個別例の専用処理や担当外の改修が増えていない。

ここで「実装済み・試験未実行」と報告して終了できる。単体や結合の実行指示を待つ場合は、全体検証や実LLM確認を先に始めない。

## 2. 確認は段階ごとに実行する

各段階で対象、入力、期待結果、実結果、失敗、スキップ、残作業を記録する。コマンドが成功したことと、確認したい振る舞いが確認できたことを区別する。

| 段階 | 目的と対象 | 通過条件 |
| --- | --- | --- |
| 単体 | 所有domainの契約、容量境界、参照、状態、失敗分類 | 正常系・境界・回帰例が成功し、期待値が仕様と一致する |
| 結合 | 公開操作から担当・ツール実行・報告・回答まで、固定モデルと固定資料で確認 | 成功だけでなく拒否・取消・不足の終端と保存・ログが一致する |
| 全体 | 他機能との干渉、型・依存境界、build、画面接続 | 選択した全gateが成功し、入力が途中で変わっていない |
| 実LLM | 本物のモデルの担当選択、引数生成、資料解釈、報告、回答 | 実際の呼出しと採用結果を記録し、利用者の目的を満たす |
| 実機器 | 音声など機器に依存する操作 | 所定の受入を実機器で通す。音声MVPは3往復を別途確認する |

### 単体・結合の選び方

domain指定でも静的検査（境界・型・format・lint など）はリポジトリ全体に行い、指定外の違反は警告として表示する（[検証](verification.md)）。試験を利用側まで自動選択する仕組みではない。`scripts/test-domain.ts` は所有パス内の試験を選ぶ。`api/application` の結合試験、利用側domain、ブラウザ試験は計画で明示する。

今回の変更範囲に対する参照用コマンドは次のとおり。毎回すべてを機械的に実行する一覧ではなく、変更した接続に合わせて選ぶ。

```sh
# 所有domain・利用側の確認。各コマンドは静的確認とdomain試験を含む。
bun run verify -- --domain capabilities
bun run verify -- --domain agent-runtime
bun run verify -- --domain dialogue
bun run verify -- --domain inference
bun run verify -- --domain web-research

# 検索の部分試験とAPI結合の既存入口。
bun run test:search

# 公開契約・履歴との分離・失敗回答・診断に影響する場合の追加結合試験。
bun test api/application/toolchain/search-results.test.ts api/application/toolchain/requirements-toolchain.test.ts api/application/toolchain/research-history.test.ts api/application/toolchain/toolchain.test.ts api/application/control-logging.test.ts api/application/toolchain/agent-voice-response.test.ts
```

「単体だけ」「結合だけ」と依頼された場合は、上記をまとめて実行せず、その段階のファイルだけを指定する。型検査やブラウザも含める場合は、その範囲を明示する。

### UIを追加・変更した場合

登録先と最小例は[DesignSystem・OpenUI・Artifactの追加手順](toolchain-extension.md#10-e-designsystemopenuiartifactを追加する)。変更した段階から、次の順序で確認する。

1. **部品**: DesignSystemのprops・イベント・キーボード操作と必要な状態を単体試験し、Storybookで見た目を確認する。既存部品の再利用だけなら、その部品の全試験を個別に作り直さない。
2. **JSON・ホスト結合**: 登録viewのJSONがコンパイルできること、未知view・不正props・source不在・種類違いを拒否すること、複数部品で同じsourceを共有できることを確認する。操作がある場合は選択・更新、revision競合、権限、取消後の古い結果を採用しないことも対象にする。
3. **画面**: 実際のArtifactを開き、他のUIとの合成、処理中から完了・失敗への必要な遷移、今回追加した操作をブラウザで確認する。保存済み音声・画像などを使える場合は再生成せず、API fixtureで確認した範囲と実サービスで確認した範囲を分ける。
4. **回帰**: 所有domainと影響のある利用側domainを`bun run verify -- --domain <name>`で確認する。ブラウザE2Eは対象domainの試験ファイルを明示して個別に実行する。実LLMの選択や生成APIまで変えていなければ、UI確認のためだけにlive生成を追加しない。

音楽UIの入口は`bun run verify -- --domain artifact`、`bun run verify -- --domain music`、保存済み音声を使う`scripts/music-ui-check.ts`。このスクリプトは認証付き読取fixtureを使う画面確認であり、実サービスの生成成功や製品DBからの取得を保証しない。音楽以外のツールチェーンにそのまま流用せず、対象のsource・成果物・必要操作に対応する試験を用意する。

ドキュメントだけの変更では、参照先と最小例の契約を確認し、製品試験・生成APIは再実行しない。検証中は実装を編集せず、結果記録は検証終了後に追記する。

### データドリブン形式（bundle・adapter）を追加・変更した場合

登録手順は[データドリブン形式の手順](toolchain-extension.md#3-bundleだけで追加改訂する)。変更した段階から次の順に確認する。

1. **bundle**: `bun run toolchain:bundle -- check <bundle>` がissue無し。pinは `bun run toolchain:bundle -- pins <revisionId>...` の値と一致。旧revisionのhashが変わらないこと、fresh DBと旧版seed済みDBの両方で登録できること、二度目のseedが冪等であることを `api/domains/capabilities/test/bundles.test.ts` の形で確認する。
2. **adapter**: 追加・変更した操作ごとに、正常・domainの拒否・同requestIdのreplay・revision競合・会話originの対象検査を単体で確認する。domainの業務判断はdomainの試験に置き、adapterでは接続だけを試す。
3. **会話の結合**: 固定モデルで候補提示 → command → 保存receipt → 回答と、clarify → 質問保存 → 回答 → 再開を通す（例 `api/application/timers/timer-toolchain.test.ts`、`api/domains/dialogue/test/command-interactions.test.ts`）。
4. **UI操作**: 受付と実行の原子性、同eventIdの再送、異なる入力の409、時刻窓、source/action偽装の拒否、field errorの非保存は共通機構の試験（`api/domains/tool-runtime/test/action-requests.test.ts`）が持つ。新しいdomainでは、そのadapterを通る代表操作を1件以上の結合試験で通す。
5. **Web**: Web adapterの試験（source解決、`settled` の反映、競合時の `refresh`、通信断のindeterminate）と、`bunx playwright test tests/browser/<domain>.spec.ts`。入口が一件であること、再読込みでタブが自動で増えないことを含める。
6. **自然言語受入（必要な場合）**: 凍結ケースを `tests/acceptance/nl/` に置き `--freeze` でlockを更新、`bun run nl-acceptance -- --dry-run --case <id>` で計画を確認してから実行する（[自然言語UI受入](nl-acceptance.md)）。テスターモデルの能力が結果を左右するため、モデルと版を記録し、別モデルは別群にする。

```sh
bun run toolchain:bundle -- check api/domains/capabilities/bundles/<名前>.bundle.json
bun run verify -- --domain capabilities
bun run verify -- --domain tool-runtime
bun run verify -- --domain dialogue
bun test api/application/<domain>-*.test.ts
bunx playwright test tests/browser/<domain>.spec.ts
```

### 部分試験を厚くする項目

- 公開の有無と提示schemaの一致、使えない担当の非公開。
- 検索・読取り・モデル呼出し・修復回数の上限。失敗した操作も予算を消費する場合を含む。
- 根拠の再提示、長い日本語、長いtitle・URL、重複資料、後半の留保、空の本文とcursor、失効参照。
- 不正JSON、schema違反、未知ツール、複数操作、操作と本文の混在、未提示根拠。
- 取消・期限後の結果不採用、重複実行の防止、保存・再起動・API返却。
- streamと非streamの引数・callback・診断の整合。CLIはイベント完了と最終出力の両方を確認する。
- 結果の成功・不足・失敗が会話回答へ届くこと。モデルの意味判断の正しさは固定モデルで保証しない。

## 3. 失敗時の切り分けと停止条件

停止条件は着手時の依頼に合わせる。「実装だけ」「通し確認は1回、失敗したら停止」と指定された場合は、その区切りを守る。通常の実装・検証まで依頼された場合、担当範囲内で原因を特定できた不具合は必要最小限で修正できる。担当外の変更、要件変更、原因不明の反復には進まない。試験期待値や要件を弱めて通さない。通常ログの調査は `bun run logs -- --level warn` から始め、runId・jobId・HTTPの `X-Request-Id` で絞る。

原因分析には次を含める。

1. どの入力が、どの接続で、どの期待値と異なったか。
2. 実行された操作と、失敗地点より後の未実行操作。
3. ログ・コード・契約から確定できる原因と、まだ推測である部分。
4. 製品不具合、試験前提との不一致、観測不足、外部条件のどれか。判断できなければ未確定とする。
5. 修正する場合の対象と影響、再確認が必要な段階。停止指定に達した場合や担当外の変更が必要な場合は、明示的な続行・改修依頼を待つ。

同じ失敗に新しい根拠がなければ再実行を止める。実LLMの拒否だけでschemaのモデル互換性が原因だと断定しない。固定試験で生じた期待値の不一致も、仕様の正本を確認する前に「テストが古い」と決めない。

## 4. 検証範囲の選び方

2026年10月14日の利用者指示により、横断変更での`verify:all`必須を廃止し、ブラウザE2Eを`verify:all`から分離した。通常は変更したdomainと影響のある利用側domainを選び、必要なアプリケーション結合試験をファイル指定で追加する。domain指定はapplicationの結合試験を自動選択しない。

全体の境界・型・単体／API結合試験・buildを確認する必要がある場合は`bun run verify:all`を使える。ブラウザE2Eはここに含めず、`bunx playwright test tests/browser/<対象>.spec.ts`で対象domainだけを確認する。実時間待ちや機器依存の受入も、その機能の検証として個別に実施する。

推論・ツール実行・認証・保存・migration・キュー・取消・共通UI・依存関係を変えた場合は、通常のツール追加より広く確認する。前回の成功を再利用するなら、関連入力・依存・試験条件が変わっていないことを証明できる範囲だけにする。

2026年10月11日の旧手順の基準検証は467,866 ms。バックエンド等182,807 ms、ブラウザ242,777 msで約91%を占めた。分離後の短縮時間は未測定。

## 5. 今回を基準にした実装状態と確認結果

基準コミット: `8dc69ea`。直前の作業フォルダで全体検証が成功し、その後の変更を同コミットへ保存した。検証入力hashは `1406948fef1066eba87b5685ad9185a59e27081f8aa22db6f7291269a9898123`。hashはコミットIDではない。

現行実装の特徴は、共通実行機構を使い、Web検索を短いV2報告へ接続し、履歴のprofile・V3・意味検証を保持していること。正確な根拠と提示量を管理し、会話の操作拒否を安全な分類・path・codeで観測する。構造修復は既存の一回上限を維持する。

| 確認 | 結果 |
| --- | --- |
| 静的確認・型・build | 成功 |
| バックエンド等 | 1,465成功、1スキップ |
| Web | 282成功 |
| client | 329成功 |
| design-system | 1,086成功 |
| ブラウザfixture | 44成功、1スキップ |
| 修正後の実LLM | 未実施 |
| 実機器 | この検証では未実施 |

スキップを合格項目に含めない。全体試験成功は実LLMの判断・外部サービス・機器を含む完成を保証しない。修正前の単発liveは会話操作の採用で停止し、検索担当へ到達しなかった。記録だけでは具体的な拒否原因を確定できない。修正後のliveで解消したとは言えない。

したがって現段階は「固定試験と全体検証を通過した実装基準」。実LLMを含めて最良・受入完了とは宣言しない。実LLM確認が許可された段階で、保存済みLARM設定をbackendの読み取り専用操作から確認し、隔離環境の設定APIで接続先を保存する。利用者へ同じ接続先を再確認したり、製品DB・秘密をコピーしたりしない。担当選択から最終回答までを観測し、途中で失敗した場合は着手時に定めた停止条件に従う。

以前の[実装・live記録](../spec/verification/web-search-repair-2026-10-11/README.md)は当時の履歴として読む。現在の全体結果は上記の入力hashと検証結果（`verification-reports/latest.json`。ローカルの検証記録でリポジトリには含めない）で区別する。`latest.json` は後続検証で上書きされるため、新しい機能の記録にはその結果と入力hashを別途保存する。

## 6. 次回も使う完了報告

報告には、目的、実装した経路、変更した契約、試験段階ごとの結果、スキップ・未確認、失敗分析、残作業、次の続行条件を記載する。「実装済み」「固定試験済み」「実LLM受入済み」「実機器受入済み」を使い分ける。

実装後、確認段階の途中、原因分析後のいずれでも終了できる。その場合は未完了の段階を明示する。確認に成功しても、依頼された範囲を超えて次の検証・改修・モデル変更へ進まない。

## task型の日常担当を変更する場合

[実装計画](../spec/everyday-task-agent-implementation-plan-2026-10-21.md)と[契約表](../spec/verification/everyday-task-agent/contract-matrix.md)を正本とする。登録だけでなく、公開会話入口→親→既存adapter→確定結果→会話での採用を検証する。

```sh
bun run toolchain:bundle -- check api/domains/capabilities/bundles/task-execution.bundle.dormant.json
bun test api/domains/capabilities/test/task-binding.test.ts api/domains/agent-runtime/test/task-execution.test.ts api/domains/dialogue/test/task-delegation.test.ts api/domains/dialogue/test/execution-notices.test.ts
bun test api/application/toolchain/task-execution.test.ts api/application/toolchain/task-execution-browser.test.ts api/application/toolchain/task-execution-media.test.ts
```

同じ生成型の二回呼出しと再送、確認後の新しい物理browser task、共有予算と元の期限、忘却・取消・訂正後の遅い結果、再起動時の全待機状態を含める。原文の後半がbriefで置き換わらないこと、result refの版と所有会話が一致することを確認する。固定モデルの成功、実モデルの意図判断、実ブラウザーの再生観測は別々に記録する。実モデルの正式usageが未報告なら不明と記載する。
