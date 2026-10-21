# サービス内検索・外部補完 実装記録

2026-10-21。利用者の実装依頼により計画へ合意。mainで作業し、既存の並行変更を維持する。

## 最新状態（単体受入への絞込み後）

- 利用者指示により通常入口のツールチェーン選択は本件の完了条件から除外。`execute_task`の選択調整は終了し、検索担当単体を既存の一時DBのapplication harnessから起動する。入口の担当選択だけを固定し、検索担当・ブラウザ担当・ガード・既存DuckDuckGoは実物を使う。実行手順は `scripts/service-search-live.ts`。製品設定・製品DBへの直接操作や検証専用HTTP APIは追加していない。
- 実ブラウザはEumenesのあるBraveプロファイル **ugnoguchigxp** を選択し、実行タブとEumenesタブが同じプロファイルにあることを確認した。
- **YouTubeとWikipediaの検索欄への入力・送信・到着先の実観測は確認済み。** 下記の単体Live記録とスクリーンショットを参照。検索結果URLの推測移動だけをこの成功に数えていない。
- **実ブラウザの期限切れ→対象ドメインを含む外部検索→動画候補2件と不足1件の部分報告→会話完了** を実確認済み。
- **Wikipediaの通し実機受入は成功:** サイト内検索欄へ入力→記事へ到着→collect→既存ガード受理→browser完了→browser由来c1を親が採用→実リンクで会話完了。run `b1d64f35-fe01-4139-8c72-4f883a5bd1ec`。開始ページだけをfixtureで開き、検索・採取・報告の判断は実モデル。検索担当の報告は本文未確認の候補として保存された。
- **残件:** YouTubeの個別動画選択は不安定。最新試行では一覧URLを候補に採取し、個別動画3件を満たさず、親の報告にも一覧を「1本」とする誤りが残った。外部queryのドメイン保持は成功したが、会話側はspoken_reply_too_longで失敗。これを受入成功や実装全体の完成とは扱わない。X・Instagramの実機受入は未実施。
- 最新の7領域verifyは **pass、integrityErrors:[]、開始・終了revision一致**。Bun 994件、Web 48件、DesignSystem 28件成功（別集合）。今回の採取契約と接続の11件/83検査成功。全体型検査2283ファイル成功。従来の42件・14件等と集合を合算しない。
- 利用者のロック解除後に再開済み。以後のサーバー再起動は許可済みだが、単体受入は最新ソースを直接読み込むためこちらでは再起動していない。既存サーバー・製品設定を変更していない。最新の起動版は `package:browser.service-search@4`、採取ツール説明は `tool:browser.page.collect@2`。既刊版は保持した。

## 目的・完了条件

既存ブラウザによる指定サイト検索と、利用不能時の既存外部検索による補完を、候補/本文の区別を保って会話へ返す。サイト別の製品分岐を追加しない。部分→結合→通しの固定検証後、利用者と実ブラウザ受入を行う。

## 基準と接続状態

- 着手前: guided-contract、guided-web、browser-task-runner、observationの37試験・513検査成功、失敗0。固定試験であり実モデル受入ではない。
- 稼働backendの認証付き読取は成功。browser設定済み、接続はdisconnected。利用者へ接続を依頼中。サーバー操作・設定変更はしていない。
- 共通子実行の型・handlerは別作業で実装中。独立した受付/配送/会計台帳は作らず、公開契約を再利用する。

## 残作業

1. YouTube等の一覧から個別候補を選び、必要件数・対象の不足を正しく報告する実モデル受入。ホストでサイトや項目の意味判定を代行しない。
2. 会話側のspoken_reply_too_longは担当外として証拠を残し、無断修正しない。通常入口の経路選択も対象外を維持。
3. 新しい仮説・評価条件が定まるまでは、同じ検索や指示の微調整を重ねない。以下は経緯の記録で、現行状態は冒頭と末尾を正本とする。

## 実装した接続

- 新規bundle `web-service-search`。公開入口 `service_search` → `package:web.service-search@1`（guidedCandidates）。LLMへ `browser.research@1`、既存 `web.lookup@2`、候補参照を解決する `web.read@2` を提示する。サイトの判別・検索手順・検索語・補完判断はSkillとLLMが担う。
- `ChildOperationPort` / `ChildCaller` を共通 `ToolchainExecutionPort` に接続。調査は実在するOwner・invocation・元発言、複数操作は既存ChildExecutionで識別する。ブラウザの実taskと既存tool_invocationsを正本とし、検索専用の台帳は追加していない。
- 既存browser runnerを `package:browser.service-search@1` で実行する。元発言は保存済みユーザー発言からホストが取得し、委譲文はbriefとして分離。開始後も元発言のdigest・取消世代・期限・凍結packageを検査する。入力許可は元発言の引用を使い、委譲文だけから権限を作れない。
- 共有ARIAノード分割を再利用し、最新観測のbNから採取する。link href/到着先と本文は実観測のみ。2観測・各8KiB・合計16KiB・候補5件・結果24KiB、native guard最大2回。既存の隔離されたWeb内容判定を通過した資料だけを採用する。
- cN候補とeN本文根拠を分離。候補のみはcandidates_foundとして保存し、本文未確認を表示。URLの再生成はLLMに任せず、ホストが観測URLから回答リンクを作る。本文確認は既存read/根拠検査へ戻す。
- service予算はroot360秒、worker330秒、親推論5回/各20秒、browser1回/90秒/最大12推論/各15秒、外部lookup1回、read1回。browserはworkerの補完150秒を残して終了する。明示された外側期限を延長しない。既存packageの既定値は維持。
- 外部取得は既存の通信・guardを含む30秒上限を再利用し、計画のread45秒枠以内に収める。検索専用のHTTP取得やCAPTCHA回避は加えていない。

## 固定検証の結果

重複する試験集合は合算しない。live/実機器の結果ではない。

- 基準: 37件/513検査成功。
- browser/capabilities/tool-runtime/agent-runtime/web-research/queue: 494件/3675検査成功（42.56秒）。その後の元発言・権限点検を含むbrowser/agent-runtime/tool-runtime＋今回のapplication結合は309件/2478検査成功（15.47秒）。
- 今回のAPI結合: 会話→browser子→候補→保存→回答、ログイン待ち→外部検索→候補→保存→回答、再seed、委譲文からの権限捏造拒否、取消後の遅延結果拒否、補完時間を残す期限終了を通過。
- 候補→web.readの実URL解決→本文のeN→answeredを固定試験で通過。
- ResearchTaskCard: Vitest 12件成功。Playwright `tests/browser/service-search.spec.ts` 2件成功（320px/960px、1.2秒）。サーバーを起動しない部品受入。実ブラウザで候補リンク、本文未確認、進捗→終了、重複なし、横はみ出しなしを確認しスクリーンショットも点検。
- 今回の追加ファイル等のlintと `git diff --check` は成功。対象外の型・依存を弱めて通していない。

## 全体gate・許可済みの共通修正

利用者は依存宣言・型の最小修正と生成物更新を許可した。依存宣言tool-runtimeは適用直前に並行作業側で解消されていたため重複適用せず、generation-prepareのTaskOffer構造整合だけを適用した。context:buildで生成物を更新し、context:check成功。型検査は全2265ファイル成功。

次のgateで今回追加が関わる既存大型関数2件の成長を検出。ToolRuntimeはpending jobの状態判定を関数へ分離し、WebResearchは引数型をinterfaceへ分離した。挙動・上限・期待値は変更していない。関連91試験/609検査成功、失敗0（22.03秒）。6領域は境界・context・sizeを通過し、並行作業の書式違反32ファイルで停止。

利用者は追加でpending-gate-cleanup.patchのdialogue引数型移動と指摘32ファイルの書式整形を許可した。適用済み。全7領域の再検証では、その実行時点に増えた並行作業のcreateTaskExecutions（644行）でsize-budget停止。閾値・baselineを緩めず、新たな担当外ロジックの整理はしていない。全体gateは未通過。

## 実ブラウザ受入

利用者自身が開発サーバーを再起動した。こちらから停止・起動・再起動していない。認証付きAPIでservice_searchの登録を確認。接続はbackend_restart後のdisconnected、autoConnectAvailable=true。

### Live 1: 通常の会話からの担当選択

- 依頼: YouTube内でpython3の日本語入門動画3件、検索画面のタイトル・動画URL、動画本文は未確認、不能なら対象ドメインを保って外部補完。
- runId: 735c8cb8-c3bd-496f-95d9-8a067381fcc9、HTTP requestId: aeeac65f-06bb-433f-b533-c25451e1dc54。
- 選択履歴: execute_task / task.execute@1、retrieval=none。service_searchには到達していない。会話は開始予告を返してcompleted（約17秒）。
- 別の汎用作業execution 189e074f-8c73-4558-8fdd-fd41cf563dd3はその後partial / execution_invalid_decisionで終了。browser taskなし。サイト内検索・外部検索の受入は不成立。
- 担当外の汎用作業を変更せず、次は担当名を明示した入力で今回の検索経路を切り分ける。通常の入力の選択成功とは扱わない。

### Live 2: 担当名明示による切り分け

runId: a77d37a4-5fbd-41b9-a709-f02a75173ead、HTTP requestId: becd11ba-d30c-4237-bc3e-09e1233b347d。service_search担当を明示した同種の検索依頼。この入力でもexecute_taskが選ばれ、検索担当へ到達しなかった。

実装済み・固定試験済み。全体gate通過、実モデル・実ブラウザ受入の完了は未宣言。

## 保存した証拠

`outputs/` に固定試験・停止したverify・型検査の出力、`screenshots/` に部品受入の画面を保存した。すべてfixtureであり、実ブラウザの受入証拠とは区別する。

最終点検でbrowserのQueue jobへ実task期限も渡し、guard中の待機も期限で中断するよう接続した。期限前に実行へ入れなかったjobも実taskをexpiredへ揃える。関連50試験成功、重複した期限判定を整理した後の13試験成功。

最新の型検査では並行作業のterminals-adapterのPickに不足するcancel/stop操作2件も出現した。担当外を追って修正はしておらず、全体検証を通過したとはしない。


### Live 3: 汎用作業を除外した切り分け

- runId 7ddfe249-d264-49b6-b209-ae295f34d643、worker ba4040b0-4cab-45bb-8063-aa4eb8a3ed27。
- find_toolchainの実embedding検索でservice_searchが1位となり採用。browser.researchが実行され、約30秒でbrowser MCP接続不能（mcp_unavailable）。
- LLMがweb.lookupへ切り替え5候補、web.readで1本文を取得。補完の動作までは実モデルで確認。ただし報告契約のcustom違反を2回検出しinvalid_control_jsonで失敗したため、回答までの受入は未達。検索語のドメイン維持も、この公開状態だけからは未確認。
- report.candidateRefsの診断パスがunknownへ伏せられ、resultKindの項目間条件もJSON Schemaへ説明されていなかった。契約・判定は維持し、Schemaのdescriptionで候補のみ/事実のみ/混在の必要条件を提示し、既知の契約キー2件を診断へ追加。修正時も値やprovider本文は出さない。6試験/42検査成功。
- 差分点検で計画にある期限終了時の既採取候補の部分返却が欠けていた。guard済み採取のみfailed/expired/needs_inputでも保持し、取消・権限失効・不確定は破棄。実runnerで期限後の部分返却と取消後の破棄を追加し、関連15試験/53検査成功。最新2266ファイルの型検査、context:check、対象lint、diff空白検査も成功。
- CUAでEumenesの接続パネル自体が未接続であることを確認。Codex側のBrave接続とは別の状態だった。その後、利用者自身の再起動と許可操作で2026-10-21T02:10:35ZにEumenes APIのconnectedを確認。

### Live 4: 接続済み・契約説明修正後

runId f9cb48e1-79d1-481d-9613-964b2c0bd767、HTTP requestId d8b17527-e95b-42b4-81ec-f373f85c23e2。汎用作業を除外した切り分け条件を維持し、YouTube内で明示検索語と3候補を要求する。実行中に製品コードは変更しなかった。browserはtab_lostで終了し、外部lookup5候補・readはresponse_too_large。非対応の追加操作の出力と、不要なrecipe:nullの出力で報告保存に失敗した。


### Live 4後の修正と固定検証

- 既存runnerの開始時に、明示タブを指定していないchildはタブなしからLLMへ判断を渡せるようにした。明示タブ消失と既存会話操作の契約は維持。既存tab_newで候補収集へ進む結合試験を追加。
- candidate用報告から、このpackageでは使用しないrecipeを除外。共通の旧guided報告は維持。未知項目やnullを受理する方向へ緩めていない。
- 関連12試験/70検査成功。その後browser/agent-runtime/tool-runtime/web-research＋今回applicationの368試験/2737検査成功（35.52秒）。重複集合は合算しない。

### Live 5: タブなし開始の修正後

runId ff9052ee-e4f4-4873-b621-131305c538bb。実browser担当は推論まで進んだが、タブ作成や検索をせずfinish。検索親は外部lookup5候補を取得し、1回の形式修正後にcandidates_foundを保存した。queryは「YouTube python3 日本語 入門」であり、依頼したドメイン文字列を含まず、候補に対象外記事も混ざった。coverageはpartial。親会話は候補全件を列挙してspoken_reply_too_longを2回起こし、invalid_conversation_operationでfailed。成功とは扱わない。

### Live 6: 試験用の担当指定を含まない依頼

runId 18c99cfe-a4ee-4c93-8af8-9f3c6a3ab7d5。同じ会話の追質問でYouTube URLと検索目的だけを依頼。browser_operateが選ばれ、browser_tab_not_foundで検索・補完へ進まなかった。単純な再試行を止め、既存指示と登録の修正へ切り替えた。

### Revision 2の調整（固定検証済み、live未実施）

- v1の登録定義を保持し、Web/Browser Skill・package、公開toolchainのv2を追加。Browserは自分の道具とbriefの担当範囲を使い、空タブなら既存tab_newを選べることを明示。外部補完のqueryへ実ドメインを含め、対象外候補で件数を埋めないことを明示。
- 候補のみの最小報告とmixedの必要条件を明確化。親の共通research-result指示へcandidateResultsの扱いを追加し、画面が表示する全タイトル・URLを音声で再列挙しないことを指示。160字制限は維持。
- capabilities＋今回の結合・取消/期限・候補契約100試験/924検査成功（11.43秒）。最新2273ファイルの型検査成功。context:build更新済み。
- 共有の通常入口には、一担当内で完結する複数手順をexecute_taskへ渡さず、担当未提示ならfind_toolchainで探す補足案をpending-routing-instruction.patchへ保存。担当外の共有指示のため、利用者の許可待ちで未適用。
- 通常入口の自動選択、実サイト内検索、異なる2サイト、実障害から補完して会話まで完了、最新全体gateは未達。


### 共有指示の補足と全体gateの再確認

利用者がpending-routing-instruction.patchを許可し適用済み。生成物更新後のrequest-analysis/toolchain-toolsは19試験/135検査成功。許可済みの整形目的で追加指摘22ファイルも書式のみ整えた。

全7領域verifyは境界・context・size・format・lint・DesignSystem型/ビルド・選択領域型検査を進み、Bun試験913成功/62失敗（975件、168.29秒）。実行中に別作業の製品ソースが変わり、結果はinvalidated。全体成功とはしない。今回の3失敗はfixtureが非activeなpackage@1を直接指定していたためで、現行@2へ揃えて4試験/18検査成功。既存dialogueの質問・会話等の失敗は対象外として未修正。繰返し全体実行は停止する。

### Live 7と8

- 通常入力ded6d27a-991a-4e83-88ae-a52b445fa405は共有指示補足後もexecute_taskを選択。通常入口の自動選択は未達。
- 担当限定0a4c5ac3-5a85-4c1a-8859-efaa6e77477eは現行package:web.service-search@2を選択。browserが実YouTubeタブを開いたが、第2推論が15秒でdeadline_exceeded。これは画面読み込みではなく次操作を決める推論の失敗である。
- 親は実際に「python3 日本語 入門 site:youtube.com」で補完。本文取得がweb_response_too_largeで失敗し、候補を返さずnot_found/partialで報告。会話への短い返却はcompleted。本文確認不要の候補提示としては未達。
- root360/worker330/native90/補完150秒は維持し、browserの1推論のみ30秒へ実測調整。子notesへ実際のphaseも渡す。候補のみ・本文根拠不要の有効なfinish例をSchemaに追加。関連15試験/85検査、型2274ファイル、lint/diff検査成功。その後例をfinish一つへ絞った候補契約3試験も成功。

### Live 9: 実ブラウザへ到達せず

利用者自身の再起動後、同じサイト・検索語で候補のみを依頼。担当限定の切り分け条件を維持。runIdは /tmp/eumenes-service-search-live-focused9.json に受付済み。製品コードを変更せず結果を待つ。


Live 9 runId ea8e7f01-84b3-4b39-9e5d-f2af9cb6832d / HTTP 004e786c-3f70-4354-bbae-81558e9bc403。明示的にexecute_taskを除外した入力でもexecute_taskが選ばれた。ブラウザ子は起動していないため、30秒調整後の実ブラウザ検証は未実施。汎用execution 8b14ce94-eefc-4e69-a287-318ef390b7eeはpartialで終了した。同じ入力の再試行を停止。

## 現在の状態と続行条件

実装と固定試験は反映済み。実サイトの検索成功はまだ確認できず、通常入口からの検索担当選択と実受入は未達。全体gateも並行変更と既存会話試験の失敗により未通過。完成とはしない。

次の具体案はpending-native-description.patch。最初に提示されるexecute_taskのfunction説明一箇所を、共有SystemContextへ許可済みの役割分担と揃える。分類コード、提供ツール、検索方式、サイト別の分岐は変えない。担当外の共有説明のため未適用で許可待ち。適用する場合は生成contextとの整合、既存の個別/複数操作の固定試験と実選択を再検証し、同じ前提の無変更リトライは行わない。


### ツール説明への反映（2026-10-21、許可済み）

利用者がpending-native-description.patchを明示許可したため、initial-decisionのexecute_task説明1か所へ適用した。一担当内の検索/読取/候補/補完と、別の能力への受渡しを区別する説明で、分類コード・対象別分岐・提供ツールは変えていない。

request-analysis/toolchain-tools 19試験成功、型2274ファイル成功、context:check成功。併せて実行したrouting-request-priority 2試験は、旧stub agents:{}にexecutionsがないためdelegate-conversation:111で失敗。対象外のstubや実装は修正せず別記する。変更したツール説明の実モデル確認は利用者による再起動後に行う。

### 受入範囲の訂正（利用者指示）

Live 10（16d3f185-f132-479b-82b5-93cf6c1db7d1）は再起動後もexecute_taskを選択した。その後、利用者からexecute_taskは複数ツールを使う入口であり、選択問題を追わず検索担当単体へ集中する指示を受けた。以降、通常入口の選択を本件の未達条件から外す。既存試験用環境で担当選択のみを固定し、実モデル・実ブラウザによるサイト内検索、異なるサイト、実制約からの外部補完、候補報告を残作業とする。製品のルーティング調整と同じ入力の再試行は行わない。これまでの選択失敗の記録は過去の切り分けとして保持する。

## 検索担当単体の実受入

`scripts/service-search-live.ts --run --question '<固定した公開検索の依頼>'` を使う。既存application harnessの一時DB、保存済みLARM設定を読む既存backend操作、既存MCP driver、TaskRunner、Web guard、DuckDuckGo acquisitionを接続した。Web担当とbrowserの出力は実モデルで、会話入口の選択だけをfixtureで固定する。APIサーバーの起動・停止・再起動は行わない。接続許可はEumenesのあるugnoguchigxpプロファイルで操作する。

### 経過と判断

| 単体試行 | 観測と結果 |
| --- | --- |
| YouTube 1 | 候補報告のtop-level examplesで共通controlInstructionsがSchemaを省略し、invoke形式が伝わっていなかった。例をreport内へ移し、全出力形式が届く回帰試験を追加 |
| YouTube 2 | 検索結果URLへの直接移動・採取までは進んだが、試験スクリプトが50秒待機後の非終端状態を終了と誤判定し処理を閉じた。この結果は無効。終端状態を確認するよう修正 |
| YouTube 3–5 | 操作拒否、不要な本文取得、対象ドメインを含まない外部query、サイト外・一覧の候補混入が出た。成功とは扱わず、理由の伝達と検索用指示を見直した |
| Wikipedia 2 | run f6a2379b-d93b-4902-8f76-3cd25ad677b8。実際にtypeでPythonを送信し、https://ja.wikipedia.org/wiki/Python へ移動。browserはcollectせず終了し、親が未発行c1を返そうとして拒否されたため、候補回答までの受入は未達 |
| YouTube 7 | run 076bfde8-5d8a-45e4-980f-193d70a62e13。DNS確認失敗と入力形式の修復後、実際にtypeで「python3 日本語 入門」を送信し、YouTube検索結果へ移動した。nativeは採取前に90秒で期限切れ。親は `python3 日本語 入門 site:youtube.com` で補完し、個別動画2件と残り1件不足をcoverage:partialで保存し、会話もcompleted。対象外の広告・playlistで3件を埋めていない |
| YouTube 8・9 | 検索担当の初回推論が20秒でdeadline_exceeded。ブラウザ未起動のため、新しい入力契約提示の実機評価に数えない |
| Wikipedia 3 | run ce277a89-1751-4754-b068-e94e43e0a66b。typeのvalue/quoteは揃ったが原文引用の検査でinput_value_unconfirmedとなり、入力は送信されなかった。親の再度のbrowser呼出しも現在の契約により拒否。安全検査は緩めていない |
| YouTube 10 | 1推論30秒へ調整後に開始したがMacがロックされ接続許可を操作できずconnect_timeout。ブラウザ・検索担当の新調整は実機未評価 |

途中の接続待ちでは誤って別プロファイルへ進めないよう、Braveの通常ウインドウ/接続画面でugnoguchigxpを確認した。内部情報画面はブラウザの操作制限により使わず、通常の接続許可画面で対象を選んだ。Macロック検出後はブラウザ操作を停止し、利用者へ解除を依頼した。

### ロック前の調整と検証

- 新しい検索用Skill・package・toolchainはrevision 3。既に公開済みのrevision 1・2は保持。入力元の説明は新しいbrowser.page.type@3へ置き、既存type@2の定義/digestは変更しない。
- 採取成功が返却の完了条件であることをBrowser Skillへ明記。Web Skillは開始時の空候補と、ブラウザ実行後の不足を区別する。サイト別処理・検索URL生成・語句による分類は追加していない。
- 承認済み入力参照がない開始状態では、既存browserPageTypeのvalue/quote必須形式を提示する。利用者が承認した入力参照がある場合は既存参照形式を維持。実際の引用/grant検査と承認経路は変更していない。失敗終了時も元の安全な拒否理由を親へ伝える。
- 候補のtop-level例によるSchema欠落を修正し、候補例をreport内へ移した。cNを本文根拠へ使うこと、未発行cN、recipe:null等を受理する方向には緩めていない。
- 初回推論20秒の時間切れ2回を根拠に、Web担当を1回30秒へ調整。最大5回、worker330秒、browser90秒、補完150秒予約、外側期限のclampを維持。browser guardは90秒内、本文guardは取得枠内で動くため二重加算せず、最悪の配分は305秒。調整後の実機確認はMac解除後に行う。
- 最新7領域verify: **pass**（2026-10-21T03:34:53Z開始、85.881秒）。Bun984件/7159検査、Web48件、DesignSystem28件成功。integrityErrorsは空、開始・終了revisionは同じ。初回は当担当bundle1件の整形で停止し、整形後に再実行して成功した。検証中の製品編集は行っていない。
- 全体型検査2280ファイル成功、当担当application/スクリプトのformat/lintとdiff空白検査成功。検証後に当担当が変更したのは本記録・証拠JSON/ログの整理だけで、製品コードは変更していない。並行作業の将来の変更へ検証結果を外挿せず、7領域の結果は保存したreportのrevisionに対するものとする。

証拠: `outputs/standalone-live-summary.json`、`outputs/verify-7-domains-pass.json`、`outputs/verify-7-domains-pass.log`、`outputs/source-schema-42-fixtures.log`、`outputs/parent30-14-fixtures.log`、`screenshots/live-youtube-search.png`、`screenshots/live-wikipedia-search.png`。固定試験と実機、検索欄操作と候補返却は別の結果として扱う。

### ロック解除後の実機受入・最終点検

利用者の解除済み連絡で再開。ブラウザは通常の接続画面でugnoguchigxpを確認した。開始ページを明示する`--start-url`は試験環境だけの準備で、共通browser.openTabと同じ安全検査を使う。公開トップページを開くのみで、検索語の入力や検索URL、候補選択、ガード判定、報告を固定しない。製品への検証専用操作は追加していない。

| 試行 | 結果 |
| --- | --- |
| YouTube 11 | 検索欄の入力・送信を再確認。最初はquote省略で拒否されたが、原文中のvalue/quoteを揃えて修復した。採取参照は不整合、native期限切れ。外部queryはサービス表示名だけでドメインを保たず、対象外広告等も候補へ混入。会話も失敗し、受入未達 |
| Wikipedia 4 | 新タブへの移動後の推論が30秒で期限切れ。親は未発行c1をreadしcandidate_invalidated。worker失敗 |
| Wikipedia 5 | 開始ページをfixtureで準備。実入力・記事到着・参照検査までは成功したが、採取した材料はガードがuncertainとして拒否。ガードを変更せず、個別公開文の検証では本文・見出しを受理し攻撃文を拒否することを確認。誤検出の原因確定とは扱わない |
| Wikipedia 6 | blockRefs:[b85]、linkBlockRefs:[b160]で部分集合の検査に失敗。次は両方b160へ直したが、そのブロックには/urlがなくobserved_link_missing。ツール説明で伝えていなかった既存の条件を新版へ補足した |
| Wikipedia 7 | **通し成功**。実モデルが検索欄へPythonをtypeし、記事到着後にblockRefs:[b81]、linkBlockRefs:[]で見出しと実到着先URLを採取。既存ガードsource_content、browser completed、親worker completed、会話completed。c1はprovider:browser、contentStatus:unverifiedの実記事URL。親は不要なreadも試みており、その手順遵守まで成功したとはしない |
| YouTube 12 | 検索欄の実入力・送信後、7ブロックをlinkBlockRefs:[]で採取。ガードは受理したが、資料は個別動画ではなく検索結果一覧のURL。親は`python3 日本語 入門 site:youtube.com`で補完し、最終的にpartialを保存したものの一覧を「1本」と呼ぶ誤りが残った。会話はspoken_reply_too_longが修復後も続きfailed。受入未達 |

変更はcollectの既存の引数条件の説明とエラー案内、部分集合拒否の回帰入力、子の起動版の更新に限定。tool:browser.page.collect@2とpackage:browser.service-search@4を追加し、追加前の全定義が同一であることを比較した。ガード・権限・引用検査・予算・候補の意味判断は変えていない。native 90秒、補完予約150秒、親/子の1推論30秒を維持。

固定検証は採取・application結合11件/83検査成功。全体型検査2283ファイル成功。7領域verifyの初回は共有ソースの並行更新で無効となった。更新時刻が該当したのはtask-execution試験、agent-runtimeのexecutions/execution-commands/execution-promptと別作業記録で、担当外の修正はしていない。更新後の取り直しは**pass、88.032秒、integrityErrors:[]、開始・終了revision一致**。Bun994件、Web48件、DesignSystem28件成功。revision:`8d02082108eac7062498c17b4c0a8e93c1c1b3780277e4def9cfe215ff873e79`。検証後の製品コード変更なし。将来の並行変更にこの結果を外挿しない。

俯瞰評価: 参照の契約説明不足を確認・補足し、Wikipediaの採取から回答までという残作業は解消した。一方、一覧と個別項目の取り違え、不要なread、回答長の失敗は複数試行で残った。サイト別のホスト判定やガードの緩和は要件違反になるため追加しない。新しい根拠のない同種試行・指示の微調整はここで停止する。再開には、候補種類と必要件数の判断を測る評価条件と新しい仮説、会話側の担当外問題を扱う明示依頼が必要。全体完成は宣言しない。

証拠: `outputs/standalone-unlocked-summary.json`、`outputs/collect2-11-fixtures.log`、`outputs/collect2-verify-pass.json`、`outputs/collect2-verify-pass.log`、`screenshots/live-wikipedia-unlocked.png`。原資料の個別試験用採取記録はignoredの`verification-reports/service-search/<timestamp>/review-*.json`へmode0600で保存し、Providerの生応答や認証情報は保存しない。
