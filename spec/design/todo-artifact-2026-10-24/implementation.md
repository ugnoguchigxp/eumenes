# TODO アーティファクトの表示改善

利用者の依頼（2026-10-24）: 画像生成でデザインを検討し、todo / done / archived をテーブルとページネーションで表示する。

## 範囲と完了条件

- 既存の会話別・読み取り専用 TODO を、DesignSystem の Tabs / ServerDataTable（TanStack Table）と、bundle・登録adapter・共通ArtifactHostに接続する。todoとdoneは同じテーブルの行として扱い、状態列だけで区別する。archivedだけを別タブにする。一覧全体で一つのページ送りを使う。新しい artifact 種別は作らない。
- 画像案を `concept.png`、生成指示を `concept.prompt.txt` に保存する。既存の暗色テーマ、テーマ変数、内容欄8pxの余白を維持する。
- 状態ごとの件数、依頼内容、状態・結果を表示する。結果は依頼内容の下に全文を表示し、日付・最終取得日時・詳細ボタン・詳細モーダルは置かない。更新ボタン、初期10件・25件・50件、前後のページを備える（利用者の追加指示を反映）。
- 現行の8件・20件上限でページが途切れないよう、既存の読み取りAPIに状態別のサーバーページングを追加する。旧API応答とagency自身が読む一覧は維持する。報告済みは実行単位にまとめ、最新の報告日時で並べる。
- 表示状態は既存の保存済み execution / report が正本。todoの対象状態、doneの保留、archivedの解除済みという意味は既存設計のまま。
- API取得のキーを会話・状態・ページ・件数に分け、取消後や古い条件の応答を採用しない。取得失敗と空状態を区別する。

変更しない範囲: 実行・報告の判断、LLM指示、DBスキーマ、認証、書き込み操作、ほかの作業中の変更。新規ライブラリ・サーバーの起動停止は行わない。

## 依存順と検証

1. 既存実装と設計、対象試験の基準結果を確認する。
2. 保存済みLARM設定と共通gatewayでcatalog・確保応答を検証し画像生成する。
3. 読み取りAPIのページ取得、クライアント契約、DesignSystem、OpenUI登録、Webホストの順に接続する。
4. 部分: ページ境界・状態別件数・会話分離・重複報告・空状態、表示と操作の試験。
5. 結合: クライアントとOpenUIホストで切替・更新・遅延応答の破棄を確認。
6. `bun run verify -- --domain agent-runtime --domain artifact` と対象外のworkspace・DesignSystem試験、Webビルドを確認する。サーバーを起動せず、ビルド済みUIをブラウザへ直接読み込ませ、広い／狭い表示を確認する。稼働サーバーの再起動・live反映は区別して報告する。
7. 差分を確認し、担当外変更・語句依存の判断処理が増えていないことを確認する。

追加修正の範囲: 日付と詳細画面の削除、表内の全文表示、一覧の横幅調整、確認画像を会話と並べて提示すること。既存のOpenUI・共通テーブルから不要な表示propsを外して対応する。API・保存・業務判断・全体の分割表示機構は変更しない。完了条件は、全3状態に日付列・time要素・詳細ボタン・dialogがなく、依頼と結果が省略されず、状態切替とページ送りが動き、右側のアーティファクト枠と狭い幅に収まること。部分・結合試験の後、実際のResizableWorkspace内でブラウザ確認する。

基準: execution-reports の既存2試験は成功。旧画面は添付画像とmarkdown実装を確認した。

## データドリブンでの実装方針（追加指示）

`docs/toolchain-extension.md` の§3・§5・§10、検証手順、add-toolchainスキル、既存の画像・端末のbundleとadapterを確認した。利用者の明示指示により、専用のReactホストと固定ランチャー入口を撤去し、画面単独のbundle登録へ移す。新しいLLM担当・profile・Skill・会話ツールは追加しない。

| 接続 | 登録・実装 |
| --- | --- |
| ランチャー | `agency-todos-screen.bundle.json` の `launcher`。`artifact:agency.todos@1` を一件公開 |
| 表示JSON | `todo-workspace`、source `agency-todos`。会話・取得状態・日時はJSONに埋め込まない |
| backend | 既存 `adapter:task-execution@1` に `query:agent-runtime.todos@1` を追加。業務判断を移さず、agent-runtimeの公開transaction読み取りへ接続 |
| source条件 | `schema:todo-screen-query@1`。会話ID・active（todoとdone）/todo/done/archived・ページ・件数を共通source APIで検証 |
| 表示操作 | `schema:todo-screen-view@1`、`schema:todo-screen-page@1` とlocal action。変更するのは表示条件だけ |
| Web | `web/src/domains/agent-runtime/toolchain-adapter.tsx` を登録。共通 `ToolchainArtifactHost` が描画。activeを一つのsource取得で読み、archived切替時は旧取得を取消。ページ送りは一覧全体で一つ |
| DesignSystem | TanStack Tableの `ServerDataTable` を主体に構成。日付・詳細ボタン・モーダルなし。依頼と結果を表内で全文表示 |

backendのadapterを増やさず、既存task-execution adapterのqueryを拡張する。WebだけでSQL・DBを扱わない。初期状態と履歴は外部モデルが使えなくても表示できる。固定入口、`useOpenAgencyTodos`、`AgencyTodosArtifact`、`WorkspaceArtifacts` の専用分岐は削除する。既存の読み取りAPIは維持する。

検証順: bundle dry-run → sourceと入力検証のAPI結合 → 新規DB・既存DBの再seed → 共通hostとWeb adapterの操作・取消 → ResizableWorkspaceでのブラウザ確認 → 所有domain・利用側のgateとビルド。表示専用なので、実LLM・新規ジョブ実行・実機器の試験は対象外。稼働サーバーの起動停止・再起動は実施しない。

## 初版の実装・検証結果（変更前の履歴、2026-10-24）

実装済み。表示だけを担う `TodoWorkspace` をDesignSystemに追加し、`todo-workspace` としてOpenUIに登録した。既存のアーティファクト枠から描画する。元のLLMへの情報と状態判断を確認した結果、問題はmarkdownの表示経路にあるため、LLM指示や業務判断の変更は不要だった。仕事の意味分類をコードに追加していない。SQLは保存済みの状態の絞り込み・件数・ページ取得だけを担う。

画像生成には、プロジェクトの指定に従ってLARMの保存済み接続設定と共通gatewayを使用した。catalogから画像capability/protocolを発見し、確保応答のサービス同一性・URL・descriptionを共通gatewayで検証した。生成POSTは1回で、取得後に接続解放を確認した。組み込み画像ツール・CLIは使用していない。

- [生成案](concept.png) / [生成プロンプト全文](concept.prompt.txt) / [生成条件](generation.json)
- [実装画面・横幅1100px](implemented-desktop.png)
- [実装画面・横幅390px](implemented-narrow.png)
- [実装画面・空状態](implemented-empty.png)

| 確認 | 結果 |
| --- | --- |
| agent-runtimeのドメインverify | 成功。Bun 150試験、Web 12試験。境界・行数・整形・lint・型・DesignSystemビルドを含む |
| ページングの部分試験 | 進行中12件、未報告11件、報告済み31件を全ページ取得。会話分離、複数報告の集約、安定順序、ページ範囲補正、空状態、旧応答維持、不正入力400を確認 |
| TODOホスト・client・既存ランチャー | 6試験成功。3状態、ページ、件数変更、更新、取消後の遅延応答排除、失敗と空の区別、HTMLを文字として表示、詳細を確認 |
| 共通artifact-ui | 341試験成功 |
| 共通ServerDataTable・Tabs | 14試験成功。既存の検索・並べ替え・詳細の動作も維持 |
| ブラウザ通し確認 | 1試験成功。実際のArtifactPanel→OpenUI→ホスト→client→HTTP固定応答で検証。3状態、ページ、25件表示、詳細、空状態、1100/390px、明色テーマを確認。ページ全体の横あふれなし・表内の横スクロールあり・ブラウザ実行エラー0件 |
| 全体の型確認・変更箇所lint・Webビルド | 成功 |
| 差分点検 | 完了。着手前からのagency・repository・報告関連・LARM検証記録の変更を保持。判断の語句依存処理・DB migration・認証変更を追加していない |

### 共通領域の既存不整合

`bun run verify -- --domain agent-runtime --domain artifact` は行数制限で停止した。変更前のHEADにも `contracts.ts` 806行、`composition-fixer.ts` 827行、`ui-studio-components.tsx` 974行があり、800行制限を超えていた。今回は `contracts.ts` のview登録等13行だけが増えて819行になった。制限やbudgetは変更していない。agent-runtime単独のverifyと共通領域の各検査を分けて実行した。

artifactのWeb試験を適切なVitest環境で実行した結果は78成功・2失敗。失敗は `composition.test.tsx` と `nested-layout.test.tsx` のレイアウト制限の期待値で、変更前から実装が深さ6・240view、試験が深さ4・60view等を要求している。TODO登録の差分はこれらの上限を変更していない。担当外として試験・実装のどちらも変更していない。予備確認でWeb試験をBunへ混ぜた実行はdocument未設定となったため評価から除外し、上記の通りランナーを分けて確認した。

通常のブラウザ・fixtureサーバーを起動せず、ブラウザへの応答をPlaywright内で供給した。固定データでの確認と、LARMでの画像生成の実接続を区別している。稼働アプリのサーバー起動・停止・再起動は行っていないため、稼働画面への反映は未確認。

context_compile 1回、compile_eval 1回。評価保存済み（runId `00000000-0000-0000-18e1-492ab7361963`）。

## 前回実装・検証結果（訂正前の履歴）

実装済み・固定試験済み。TanStack Tableの共通 `ServerDataTable` を主体に、todoとdoneを同じ画面で上下に表示する。archivedだけを別タブにし、3状態それぞれのページ・件数を独立させた。日付と詳細モーダルは削除した。依頼と結果の文字を省略せず、表内で折り返す。仕事が多い場合も現在の2段階を見比べられるよう、現在の表はそれぞれスクロールできる。画面全体は既存のResizableWorkspace内に置く。

登録は `agency-todos-screen` bundle。revisionは `artifact:agency.todos@1`、`schema:todo-screen-query@1`、`schema:todo-screen-view@1`、`schema:todo-screen-page@1`。接続先は既存の `adapter:task-execution@1` で、新しい担当・LLM呼び出し・判断方式・固定語句での分岐は追加していない。旧専用host・opener・WorkspaceArtifacts分岐は撤去した。公開済みの旧revision本文は変更していない。今回の新規bundleは稼働DBには未投入で、隔離DBで初期化・冪等性・再公開状態の保持を確認した。

- [最終実装・会話と並べた表示](implemented-desktop-v3.png)
- [狭い画面](implemented-narrow-v3.png) / [空のアーカイブ](implemented-empty-v3.png)
- 元の画像案は利用者が採用。修正検討中に生成した[別案](concept-v2.png)と[そのプロンプト](concept-v2.prompt.txt)も保存した。その後のtodo/done同時表示の指定は最終実装画像で確認する。

| 確認 | 最終結果 |
| --- | --- |
| bundle dry-run | 登録可能、issueなし |
| API・公開入口・seedの結合 | 7成功。入口が1件、登録source経由の読取り、ページ入力の検査、source/target偽装の拒否、モデル呼び出し0回、新規DB・再seed・公開状態の保持 |
| Web adapter・ランチャー | 4成功。todo/done同時表示、独立ページ、件数変更、表示中の表の更新、archived切替、2取得の取消と遅延応答排除、空・失敗・復旧、HTMLを文字として表示、日付・詳細モーダルなし |
| `verify --domain agent-runtime --domain capabilities` | 成功。Bun 241試験、Web 15試験、境界・整形・lint・型・DesignSystemビルド。`verification-reports/runs/2026-10-23T23-57-10-124Z-040d1e48-77b2-4509-9c9c-6d7b07f3883e/report.json` |
| 共通artifact-ui | 341成功 |
| TODOブラウザ通し | 1成功。実際の共通ArtifactHost→登録Web adapter→client→HTTP固定応答。会話と並べた595px幅のアーティファクト内でtodoとdoneが同時に見えること、独立ページ、archived、空状態、明色、390pxでの折り返し、日付・詳細・dialogなし、ブラウザ実行エラー0件 |
| 全体型確認・変更箇所lint・整形・Webビルド | 成功 |
| 差分点検 | 完了。別作業のLARM・monitoring・agency・背景・CLI等の変更は修正対象にしていない |

途中のverifyは試験の層境界、JSON fixtureの読み込み方法で停止した。跨るランチャー試験をworkspaceへ分離し、canonical bundleを試験用データとして読み込む形へ修正した。共有ソースとDesignSystem出力が変化してinvalidatedとなった実行も成功に含めない。最終実装を揃えてから再実行した上記verifyはintegrity errorなしで成功した。検証期待値・ドメインの依存規則は弱めていない。

artifact全体gateの既存行数超過・レイアウト期待値不一致は前節の通りで、今回は修正していない。最終 `contracts.ts` は登録等12行増の818行。共通artifactの全体gate完了とは区別する。

サーバーの起動・停止・再起動、製品DBへの直接書き込みは未実施。通常の初期化時にbundleが登録される。実LLM・実機器は表示専用の変更のため対象外。固定試験・画像生成の実接続・稼働アプリへの反映を区別する。

今回のcontext_compile/compile_evalは各1回、会話全体では各2回。追加分の評価を保存済み（runId `00000000-0000-0000-18e1-4d0f100ff6b0`）。

## 利用者による訂正と実装計画

同じ画面の上下の表ではなく、todoとdoneを同じテーブル内の同じアイテムとして扱い、状態列のみで区別する。archivedのみ別タブ。既存の登録adapter・ServerDataTableを再利用し、専用hostは作らない。日付・詳細ボタン・モーダルは引き続き不要。

依存順は、読み取り契約にactive条件を追加→保存済みexecution/reportをSQLで統合してから件数・LIMIT/OFFSETを適用→同じIDの行にtodo/doneの表示状態を返す→共通テーブル1個とページ送り1個へ接続。状態別に取得済みのページをフロントで連結しない。既存の状態別読み取り・業務判断は維持する。activeの順序は依頼の作成順（降順）、同時刻はID降順で安定させる。

完了条件: todo/done混在ページ、状態遷移前後の同一ID、重複報告でも1行、共通ページ送り、archived分離、取消応答排除、狭い幅での表示。部分→登録source結合→共通host→ブラウザ通しの順に検証し、所有domainのverifyと利用側の検査を実施する。DBスキーマ・LLM指示・判断・サーバー起動停止・担当外変更は対象外。

## 訂正後の実装・検証結果（同じテーブルの行、2026-10-24）

実装済み・固定試験済み。todo/doneを一つのServerDataTableに統合し、状態列にtodo/doneを表示する。同じexecution IDのまま状態が変わる。active条件をSQLで絞り、重複報告を集約してから一つの件数・LIMIT/OFFSETを適用する。archivedのみ別タブにする。表・表示件数・ページ送りは各表示につき一つで、状態別の表や独立ページは撤去した。既存の保存状態・報告判断・旧APIを維持し、LLMの意味判断を代替する分岐は追加していない。

登録IDは前回と同じ未公開の新規bundle `agency-todos-screen`、`artifact:agency.todos@1`、`schema:todo-screen-query@1`、`schema:todo-screen-view@1`、`schema:todo-screen-page@1`。既存 `adapter:task-execution@1` → agent-runtimeの公開読み取り → 共通source API → 登録Web adapter → OpenUI → DesignSystem ServerDataTableの経路を再利用する。追加のpackage・binding・モデル呼び出しは不要。表示JSON・ソース・表示操作の契約を揃えた。

- [修正後の実装画面](implemented-desktop-v4.png)
- [狭い表示](implemented-narrow-v4.png) / [空のアーカイブ](implemented-empty-v4.png)

| 段階 | 結果 |
| --- | --- |
| 部分・登録source・seed結合 | 8成功。23件の混在ページを全取得、同一IDのtodo→done、重複報告1行、会話分離・archived分離・旧上限超過、登録sourceのactive許可と不正入力拒否、モデル呼び出し0回、新規DBと再seed |
| 所有domain・利用側verify | `bun run verify -- --domain agent-runtime --domain capabilities` 成功。Bun 242試験、Web 15試験、境界・行数・整形・lint・型・DesignSystemビルド。integrity errorなし。`verification-reports/runs/2026-10-24T00-07-38-360Z-8475ac56-650f-4a23-accb-5d213cda65af/report.json` |
| workspace入口・client | 2成功。共通登録入口とAPI契約・認証・取消伝播 |
| 共通artifact-ui | 341成功 |
| ブラウザ通し | 1成功。実際の共通ArtifactHostと登録adapterで一表・混在行・一ページ送り・archived切替を確認。595pxの分割枠、390pxでの折り返し、明色、空状態、日付・詳細・dialogなし、ブラウザ実行エラー0件 |
| 全体型確認・変更箇所lint/整形・Webビルド | 成功（全体型確認2,405ファイル）。Webビルドには既存の大きなchunkの警告あり |
| 差分点検 | 完了。別作業のagency・LARM・monitoring・背景・CLI等は変更していない。専用host・個別語句判断・新規DB migration・サーバー操作は追加していない |

全試験を揃えた後、Tabsの標準Contentを使って選択タブと表の関連付けも確認した。以後のverify・ブラウザ試験・ビルドはこの最終コードを対象に成功。共有DesignSystemビルドとブラウザ・Webビルドは重ねていない。製品DBへの書込みと稼働サーバーの起動・停止・再起動は未実施で、稼働画面への反映は未確認。表示専用のため実LLM・実機器・自然言語受入は対象外。artifact全体gateの既存不整合は前節の通りで、本変更では修正していない。

今回のcontext_compile/compile_evalは各1回、会話全体では各3回。評価保存済み（runId `00000000-0000-0000-18e1-4e5d1e271ce5`）。残る実装作業なし。
