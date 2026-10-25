# 会話からの調査(toolchain)

## SystemContextの配置と生成

コード内の固定SystemContextは `s11tnext@0.1.2` で管理し、所属domainの `api/domains/<domain>/contexts/**/*.context.toml` を正本とします。会話、調査worker、保守、監督、画面生成、組込みprofileの本文が対象です。版付きSKILLは既存のMarkdownとbundle登録機構を使います。依頼、取得資料、記憶、ツール一覧、出力schema、権限・取消・予算の検査は既存の実行機構に残します。

`api/infrastructure/system-context.ts` が検証済みcatalogを一度読み込み、型付きのキーで固定文面を返します。会話の口調・役割・名前はTOMLの変数で組み立てます。名前は従来どおり保存設定から読み、既存の指示への埋込み方を保持しています。この互換用の `trusted` / `raw` 変数へ、依頼や取得資料を追加で渡してはいけません。新しい未信頼変数はライブラリの `delimited-context` と非raw encodingで宣言し、メッセージの信頼境界も確認してください。

TOMLを変更したら `bun run context:lint`、`bun run context:build` を実行し、`.s11tnext/catalog.json` と `.s11tnext/catalog.generated.ts` を一緒に更新します。設定はリポジトリ直下の `s11tnext.config.toml`、文面のlocaleは現行の日本語です。`bun run context:check` は書込みをせず、TOMLと生成物の不一致を拒否します。通常の `bun run verify -- --domain <name>` にもこのチェックを含めます。生成物は専用compilerが整形するため、汎用formatterの対象外です。

末尾改行はライブラリが正規化します。断片を連結するときの区切り改行は呼出し側で明示し、既存の文面・順序を保持します。会話SystemContextは移行前の文字列fingerprintを用いて、全口調と名前の有無・特殊文字を回帰検証しています。固定文面の移動で、LLMの判断を置き換える条件分岐は追加しません。

## LLM生成JSONの構文補正

LLMが返すJSONは `api/infrastructure/llm-json.ts` の共通処理を一度通してから、各domainの既存スキーマと採用条件で検証する。対象は会話function引数、workerの操作・要件検証、Codexの最終制御応答、音楽生成・再生計画、coding-supervisionの判断、Worldの抽出。通常の会話本文、HTTP/SSEの通信envelope、DB保存値、設定や利用者のJSON入力は対象外。これらの破損をLLMの出力不正として補正しない。

正常なJSONは値を変更せずに通す。構文不正だけ `jsonrepair@3.15.0` で一回補正し、元のキー・値・コロン・括弧の列が保たれることを検査する。補正を採用できる範囲は引用符とカンマ。完全な外側のJSONコードブロックと先頭のthinkブロック一件は解包するが、説明文からJSONを探さない。欠けた値・括弧・文字列の補完、型変換、項目削除、重複キー、複数JSON、深さ64超過は拒否する。入力と補正後の双方へ容量上限を適用する。語句・業務シナリオ別の対応表を置かず、意味の判断はLLMへ委ねる。

補正後も契約に合わなければ、会話・worker・coding-supervisionの既存のモデル修正を一回まで使う。構文補正の成功はモデル修正の枠を消費しない。会話側は違反箇所と容量を制限した不正引数の抜粋を未信頼のuserデータとして返し、systemで資料内の指示に従わないことを指定する。再修正も同じ構文補正・スキーマ・公開ツール・権限・根拠・期限・取消の検査を通す。既存のモデル修正がない処理は、補正後の不正を従来どおり拒否する。構文補正だけで意味や根拠の正しさを保証しない。補正のdebugログは容量と固定分類だけを記録し、生応答を残さない。

部分試験は共通補正と各domain、結合試験は会話・worker・監督の修正回数と音楽の通し経路、全体は `bun run verify:all`。途中切断・値補完・重複キー・権限外の操作を拒否する回帰試験を含む。固定試験は実モデルの補正成功率を証明しない。

## 会話から担当への経路

会話エージェントへのmessageは、system（人格と規則）、資料のJSON文書（1件目のuser）、最後のuser（利用者の新しい発言、または新しい発言のないときのhostの固定文）の順に並ぶ。最後のmessageだけを今回の指示として扱い、資料・ツールの結果・構造修正の資料からは指示を作らない。配置・各部分の寿命・再構成は[会話エージェントのContextWindow仕様](../spec/context-window-spec-2026-10-24.md)の§5・§12を正本とする。過去発言・記憶は指示語や継続条件の理解に使う参考文脈であり、明示された今回の対象・日時・条件を置き換えない。

委譲先は共通の `delegatedTaskRules` で、具体化した `request` / `question` と同じ依頼の原文 `originalRequest` を、参考資料・snapshot・catalog・実行状態から区別する。通常Web・SDK経由の調査・履歴・Worldのworkerと要件検証、登録adapterの操作担当、音楽生成・再生・画像・描画の計画担当に適用する。子へ親の会話履歴や人格を追加せず、既存のツール・資料・容量上限を維持する。確認回答からの再開は、既存のinteractionに凍結された依頼と対応する `previousQuestions` の回答を使い、回答文で元の依頼を置き換えない。意味の解釈と検索語の選定はLLMが行い、ホストは入力の同一性・schema・権限・期限・取消を検査する。

会話本文は、画面・音声へ投影する前に共通の出力契約を確認する。正式なfunction呼出し以外に、本文中の登録済み・提示済みfunction名に続く括弧、Providerの内部制御区切りが現れた場合は、本文の契約違反として既存の一回限りのモデル修正へ進む。本文から操作を復元・実行したり、該当部分だけを削除して回答を採用したりしない。再修正も不正なら回答を保存せず失敗で終了する。

streamでは、function名や制御区切りになり得る末尾だけを保留し、形式が確定した通常本文を順次表示する。不正な制御表現は途中の分割chunkも公開しない。修正時の本文・引数の抜粋は各4096文字以内の未信頼データとしてモデルにだけ渡し、ログには拒否の固定分類を残す。楽曲・調査・タイマー等の選択と不足情報の判断はLLMに委ねる。入力の語句・分割状態・依頼の内容で分岐しない。

追加の種類ごとの変更箇所と最小例は[ツールチェーンの登録と拡張](toolchain-extension.md)、確認段階と過去の実績は[検証手順と基準記録](toolchain-extension-verification.md)を参照してください。

通常の会話入力から、登録済みのツールチェーン(定形セット)を選べます。`EUMENES_TOOLCHAIN_ENABLED` は既定 `1`、`0` なら従来の会話生成へ戻ります。内部JSONを読み上げや態度収集へ渡しません。子の待機中は推論枠を解放します。

候補は今回のユーザープロンプトだけをEmbeddingし、登録された機能との類似度で取得します。履歴を検索文に混ぜたり、FTSや過去の選択を加点したりしません。履歴はLLMが省略や指示語を補う参考文脈として扱い、今回の明示された依頼を優先します。候補件数・Embeddingを利用できない場合の全候補提示・権限検査は従来のままです。

ツールチェーンは「サブエージェント・SystemContext・SKILL・ツールの使い方・ツール詳細・Artifact」の一組です([設計](../spec/.archived/toolchain-set-routing-design-2026-10-12.md)、[登録手順](toolchain-extension.md#1-全体像))。会話エージェントがツールチェーンを探し、こなせるかを評価して依頼する流れ（担当の検索・分析・予告・構造の修正・実行の確認）は、[会話エージェントのContextWindow仕様](../spec/context-window-spec-2026-10-24.md)の§6を唯一の正本とします。

専門担当へ完全に切り替えるsession型は、hostが発行した保存作品の `target` と、未保存作業を破棄して切り替える `resolveUnsaved` を任意で持ちます。選定時には登録済みの方式が関数説明へ渡され、切替を予告します。成立後の発言は専門担当へ直接届き、通常会話AIの再選定や言い直しを挟みません。担当は既存の返却・終了の契約で通常担当へ戻ります（[計画](../spec/.archived/toolchain-specialist-dialogue-implementation-plan-2026-10-17.md)）。結果返却型は担当の結果を通常会話AIが伝えます。内部の経路・ツール・引数は各ツールチェーンのサブエージェントが決めます。

即時回答型（binding `execution:"instant"`）は、担当の検索結果の候補に登録定義が宣言した入力（`weather_forecast` は `place`＝言われた地名、`prefecture`＝その都道府県、`day`＝`today`/`tomorrow`/`day_after`。`stock_quote` は `query`＝会社名・ティッカー）が付き、会話エージェントは依頼ツールの`execute`の`inputs`にそれを書いて呼びます（予告なし）。入力は利用者の言った言葉で、地名から予報区域、名前から銘柄への解決はadapterが自分のデータ（気象庁の区域表、EDINETコードリスト等）で行います。adapterの `availableInTransaction` が候補に出すかを決めます（天気は区域表を取得できない間は出さない）。hostはadapterを実行し、返った文をツールの結果として返し、会話エージェントがそれを根拠に話します。TODOは作りません。adapterが失敗（ネットワーク・タイムアウト・非200・形式不正）したときは、ツールの結果が即答できなかったことと代わりの担当（bindingの `fallbackToolchainId`）を返し、会話エージェントが改めて予告付きで依頼するかを判断します（同じrunで自動的に別の担当へ回す動作はありません）。天気の説明・使う/使わない場面・文の形は、会話の共通SystemContextではなく担当の登録定義・SKILL・adapterに置きます（[天気の設計](../spec/weather-instant-toolchain-design-2026-10-18.md)、[株価の設計](../spec/stock-instant-toolchain-design-2026-10-18.md)）。

仕事の結果: 会話エージェントが依頼した仕事はTODOになり（実行中`todo`・質問待ち`waiting`・終了`done`）、担当の状態・質問・結果はTODOへ報告されます。結果と質問は資料の`<log>`に「結果」「問い」の出来事として足され、`<state>`のTODOの状態も変わります。会話エージェントが結果を伝えた後にTODOはアーカイブされます。結果の照合と継続のrun、完了報告の保留・解放は廃止しました。詳細は[会話エージェントのContextWindow仕様](../spec/context-window-spec-2026-10-24.md)の§9・§10と[ContextWindow 構成仕様](../spec/context-window-layout-spec-2026-10-25.md)です。

調査担当には今回の依頼を渡し、検索キーワードは担当が選びます。過去の会話から出典URLを集めて渡しません。URLの直接読取りは今回の依頼に明示されたURL、今回の検索結果、今回の依頼に合う保存済み手順の候補に限ります。

| 関数名（選定の記録） | ツールチェーン | package | 実行 | 検索 | 読取り | 保存本文 | モデル呼出し | 報告 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `web_search` | `web.search` | `package:web.recipe@5` | LARMの調査担当。guided、手順キャッシュ付き | 2 | 4 | local予算4 | 5 | 本文根拠と完成回答 |
| `conversation_history` | `history.research` | `package:history.research@2` | 調査担当 | — | — | 履歴 | 7 | V3報告 |
| `world_query` | `world.query` | `package:world.query@5` | World有効時の調査担当。ホスト内の読取 | — | — | Worldの主張・収集資料 | 7 | search報告 |
| `timer` | `timers.manage` | `package:timers.manage@2` | 操作担当→タイマー操作 | — | — | — | 1+回答 | 操作結果 |
| `music` / `music_library` | `music.create` / `music.library` | `package:music.create@2` / `package:music.playback@1` | 音楽domainの計画担当 | — | — | — | 計画+回答 | 音楽結果 |
| `delegate_project` | `dots.delegate` | `package:dots.orchestrate@2` | 操作担当→dots委任 | — | — | — | 1+回答 | 委任結果 |
| `ocr` | `ocr.manage` | `package:ocr.manage@1` | 操作担当→OCR | — | — | — | — | 操作結果 |
| `kanban` / `codex_tasks` | `kanban.manage` / `codex-tasks.manage` | `package:kanban.manage@2` / `package:codex-tasks.manage@1` | 操作担当→タスクボード | — | — | — | — | 操作結果 |
| `claude_code` | `claude-code.request` | `package:claude-code.request@2` | 操作担当→作業依頼表 | — | — | — | — | 受付 |
| `ui_create` | `ui.compose` | `package:ui.studio@1` | 専門担当へ切替（session）。以後の発言は担当が直接受ける | — | — | — | 1ターン最大6 | 下書き反映・作品参照 |
| `weather_forecast` | `weather.forecast` | `package:weather.forecast@1` | 即時回答型（instant）。依頼ツールの`inputs`（区域・日）から天気予報を取得し、決まった形の文をツールの結果で返す。予告・TODOなし。取得に失敗したら代わりの担当（`web.search`）を結果で示す | — | — | — | 会話の生成の中の1回 | ツールの結果（ホストが作成した文） |
| `stock_quote` | `stock.quote` | `package:stock.quote@1` | 即時回答型（instant）。依頼ツールの`inputs`（`query`＝言われた会社名・ティッカー）から、EDINETの上場会社一覧（日次更新・失敗中は前の一覧）とYahoo検索で一社を特定し（日本株優先、同名は完全一致→前方一致→部分一致）、Yahooのチャートで取得した現在値・前日比・JST時刻を決まった形の文にしてツールの結果で返す。会社を特定できない・取得に失敗したら代わりの担当（`web.search`）を結果で示す。履歴・指標・財務・ニュース・複数銘柄比較は対象外 | — | — | — | 会話の生成の中の1回 | ツールの結果（ホストが作成した文） |

候補の提示: 会話エージェントは、`state.retained`（最近使った最大4件）で足りないときに担当の検索ツールを1回の生成で1回まで呼びます。検索文は会話エージェントが最初に行う一つの作業の用途として書きます。hostはその検索文に対し、ツールチェーンの`title`・`summary`・`useWhen`・`examples`へのFTS(trigram)、LARMのembedding(保存済み設定・catalogのモデルで、passageとして保存、検索文はquery)、似た依頼での過去の選択をRRFで統合し、`state.retained`の担当を除いた上位4件の説明をツールの結果で返します。候補は関数として提示しません。embeddingを利用できない間は候補を広げず、取得できなかったことを結果で示します。候補検索は分類ではなく、こなせるかの評価と選択は会話エージェントが行います。

選択の記録: 会話の判断ごとに、提示した候補(順位・FTS順位・類似度・過去の選択由来)、判断(ツールチェーン・回答・契約違反)、選んだ関数と渡した依頼、サブエージェントのtask、結果(outcome)、手順キャッシュの利用を `toolchain-history` に30日保存します。`/api/toolchain-history/selections`、`bun run cli -- toolchain-history list|show`、設定「ツールチェーンの記録」で確認できます。ログには相関IDと固定分類だけを出し、依頼文は出しません。

`web_search` の手順キャッシュ: 担当は保存済みの取得手順を候補として探し、現在の依頼に合うかを判断します。一致すればそのURLを取得し直し、なければ予算内で検索・読取りを選びます。answeredで、読み取ったページを根拠に引用した場合だけ、報告の`recipe`（signature・URL・読む箇所）をホストが保存します。値は保存しません。

操作担当(`timer`・`delegate_project`): ツールチェーンのprofile・SKILL・ツール詳細とsnapshot(タイマー一覧・委任catalog)を読み込み、ツールを一つ選んで平坦な引数で返すか、確認質問を一つ返します。ホストは型付きの操作に変換して既存の実行経路で実行します。確認質問は会話担当が自分の言葉で尋ねます。

現行のWeb経路は `package:web.recipe@5`・`package:web.search@5`、schema `guidedResearch`、SKILL `skill:web.guided@4` を使います。検索抜粋は取得先選択の参考とし、主張の根拠にはしません。`web.read` は `{url}` だけを受け、同じ呼出しで確認する追加URLを `readAhead`（URL文字列の配列 `["https://…", …]`、最大5件。旧 `[{url}]` の object 形は受理しません）で指定できます。主URLを含め残りの読取・外部呼出し上限内に収めます。全操作を共通のツール実行記録とQueueへ登録し、選んだ組の全件が完了・失敗してからモデルを一度再開します。到着ごとのモデル呼出し、2件ずつの追加取得、10秒タイマー、独自の取得状態は使いません。保存済み本文の `web.find` / `web.read_saved` と手順の `recipe.find` はページ読取とは別のlocal予算（4）です。

`finish.report` は `completion`、利用者へ届く `answer`、`summary`、事実ごとの `claims`（`verified` / `unknown` / `conflicting` と本文根拠 `eN`）、`limitations` を持ちます。本文に基づく主張・未確認点・完成回答を同じfinishで返し、要件抽出・追加の意味採点は行いません。不明や矛盾を説明した回答は `complete` にできます。構造や参照が不正な場合の修正（一回まで）、権限・取消・期限の検査を維持します。再試行のcooldownは前の確定receiptからQueueの受付可能時刻へ渡します。

実装目標(SystemContextの層構成、会話方針と公開ツールの一致、結果返却の必須規則など)と現行との差分は [Web検索 実装目標](../spec/.archived/web-search-target-2026-10-11.md) にあります。今回の会話契約と根拠容量の修正範囲は[実装計画](../spec/.archived/web-search-repair-implementation-plan-2026-10-11.md)のA〜Dです。後続の構造改善とは区別します。



子は取得本文を読みます。guidedのWeb経路は利用者向けのanswerと事実ごとの確度を、履歴経路は短い要約と主張を返します。メインへ本文・生引用・ページタイトルは渡しません。主張の引用が実際に子へ提示した資料に含まれるかを確認しますが、この検査だけで主張の意味まで正しいと保証するものではありません。メインでも報告を未信頼データとして扱います。調査cardに進行状態・停止・出典・確認できなかった点を表示します。

話題や地域を限定せず、検索・本文取得・保存本文の確認を使います。検索語、取得先、資料の解釈はLLMが選びます。天気・株価専用の読取りや、発話の固定文法による取得先学習は実行しません(手順キャッシュの一致判断はLLMが行います)。上流の取得拒否やguard拒否を迂回しません。結果データは14日、本文を含まない処理metadataは30日で整理し、既存の会話は残します。

`EUMENES_LIVE_TOOLCHAIN=1 bun run verify:live -- --domain agent-runtime` は一時DBを持つ隔離backendを起動し、実LARMと公開データで天気・株価を確認します。LARM認証はbackendの環境変数から読み、通常DBは使いません。判定は子の報告と最終回答の数値まで確認します。[実装・検証記録](../spec/verification/toolchain/README.md)を参照してください。

domain の責務は [domains.md](domains.md)、Web 取得は [web-research.md](web-research.md) を参照してください。旧「取得先と手順(research-routes)」は2026-10-12に廃止し、テーブルを削除しました。

## 要件profileとV3報告

要件profileとV3報告は `history` 経路だけが使います。Web経路（`web.recipe@5`・`web.search@5`）はprofileを受けず、指定された場合は開始時に `invalid_requirement_contract` で拒否します。

利用者が再利用する確認基準は `kind:requirement` のデータとして登録します。要件profileは実行権限を持たず、package検索・ツールの依存閉包へ入りません。履歴のサブエージェントは、開始時に固定した要件catalogから適用するprofileの短いrefを最初の応答で選びます(最大4件)。会話担当はprofileを選びません。workerは最初の操作と同じ応答で依頼の条件を抽出し、ホストが登録profileと合成して、取得開始前に凍結します。原文、版付きSKILL/profileの本文、選択した要件データがモデル入力へ届きます。

`finish` は候補の提出です。同じworker・同じengineが `tools=[]` で依頼、条件、完全な該当抜粋、未確認点を一回照合し、受理された結果だけV3報告になります。requestの網羅性や根拠との意味上の対応はこのモデル判定に委ねます。形式・値・根拠の所有者と版・取消・期限・profileのrevision/generationはホストが検査します。意味検証は任意の業務判断の正しさを証明するものではありません。

確認できない値は `unknown/null`、未達は `unsatisfied`、許可された適用外は根拠付き `not_applicable` として残します。必須条件がunknown/unsatisfiedならansweredにできません。外部資料の条件は `externalRules` に出典付きで保持し、profileを自動登録したり凍結した利用者条件を書き換えたりしません。チェックと外部ルールだけが使う根拠も失効検査の対象です。

構造修復は調査と意味検証を合計して一回まで。意味検証の不支持、枠不足、期限切れ、取消、profileの改訂・無効化では未検証候補を回答に使いません。履歴は `package:history.research@2` です。旧revision(`package:web.quick@1`・`package:web.research@9`・`skill:web.research@8` など)とV1/V2報告のreaderは維持しますが、新しい調査には使いません。

## 要件の登録と改訂

APIは既存の認証・origin検査を使います。GET `/api/capabilities/requirements` と `/:id`、PUT `/:id`、POST `/:id/state` を提供します。新規PUTの `expectedStateToken` はnull、改訂・状態変更は取得した現行tokenが必要です。競合は409で、勝手に再試行しません。同じ内容のPUTはrevisionを増やさず、無効なprofileの改訂も無効のままです。無効化・再有効化・改訂は既存の実行を失効させます。

```sh
bun run cli -- requirements list --json
bun run cli -- requirements show criteria --json
bun run cli -- requirements import criteria ./profile.json new --json
bun run cli -- requirements import criteria ./profile.json <state-token> --json
bun run cli -- requirements disable criteria <state-token> --json
bun run cli -- requirements enable criteria <state-token> --json
```

profileは最大12要件・16 KiB、同時選択は4profile、合成後は12要件まで。有効profileは32件かつ会話catalogは8 KiB以内。値のJSON SchemaはZodの標準変換で検証し、未知keyword、正規表現、条件分岐、参照、default、coerceを許しません。数値・文字列・配列・objectの型と範囲だけを表現します。超過や不正なschemaを切り捨てて受理しません。完全な例は [評価データ](../api/application/toolchain/testdata/llm-native/cases.json)とprofile JSONを参照してください。

## タイマーと音声

タイマーは bundle 登録の `toolchain:timers.manage@6`（「タイマー」。package `@2`・skill `@2`）で、binding `binding:timers.command@4`（確認質問は取消対象の選択だけを宣言）と artifact `artifact:timers.workspace@3` を通じて登録 adapter `adapter:timers@1` が実行します（[登録手順](toolchain-extension.md#3-bundleだけで追加改訂する)）。時間・単位が依頼にない開始は、聞き返さずに既定の3分（180秒）で保存します。既定値はskill本文（`builtin/timers/SKILL.v2.md`）が持ち、会話側のコードには持たせません。時間が示された依頼はその秒数で開始します。

タイマーは権限・操作receiptを再検査したうえで、label、状態、残時間、期限を含む全itemsを回答モデルへ渡します。ページングされた一覧は `complete:false`、失敗は固定codeを含む構造化結果です。回答直前に状態をrefreshし、ユーザー本文を位置・内容検索で書き換えません。操作の再実行やホストでの定型文章化は行いません。

音声入力はASRの文字起こしを入力とし、発話の続き判定をLLMで行いません。ASR要求（確定・途中表示とも）には `language` を1つ渡し、認識言語を固定します。「利用する言語」に日本語があれば `ja`、なければ先頭の言語です（ASRは複数言語を指定できないため）。ASRは雑音から任意の言語の文を作るため、設定の「利用する言語」（`general.asrLanguages`）以外の文字起こしは雑音として捨てます（エラーにも保留にもせず、送信前の入力は保持）。かなを含む文は日本語としてモデルを呼ばずに判定し、それ以外の文だけ既定controlモデルで一回判定します（8秒・128 token）。判定できない文・判定失敗は不採用です。無音で区切られた区間を送ると `input_ready` になり、Webは話し終えた状態で送信します。送信前に次の区間が届いた場合は直前の入力に連結し、元のASR receiptはすべて回答・TTSの検証parentに結びます。

音声回答は生成中の本文を既存の進捗購読から受け取り、句読点で区切った句を順次Ruriへ送ります。`current_chunk`は現在の句、`response`はその時点の回答文脈で、直近の会話も渡します。引用・否定・定義文を保持して全6候補を提示し、句ごとに判定して直ちにTTSを生成します。判定結果は後続の句へ使い回しません。機能選択の前置きは音声化せず、出典の整合性を検証する回答は検証済み本文から音声化します。記憶・目標の参照は生成中も再検査し、取消・参照失効後の判定と音声を採用しません。URL・ドメイン名・出典だけの行は画面に残し、TTS本文から除きます。途中で分割されたURLも、構造が確定するまで読み上げへ流しません。候補・判断基準・声色presetは `delivery/data/speech-delivery.v1.json` に置きます。語句・句読点から抑揚を推定せず、判定失敗時は保存済みの声設定を使います。

## 固定資料とliveの検証

[検証記録](../spec/verification/llm-native-2026-10-10/README.md)でfixture、liveモデル＋人工固定資料、実Web取得、実機器を分けています。固定資料adapterは提示URLの完全一致で本文を返し、ネットワーク・意味分類を使いません。expectedを実モデルへ渡しません。fixtureの意味検証stubはhost契約を試すもので、モデルの意味判断に対する合格記録ではありません。

```sh
EUMENES_LIVE_LLM_NATIVE=1 bun scripts/llm-native-live.ts --suite all --cases api/application/toolchain/testdata/llm-native/cases.json --out spec/verification/llm-native-2026-10-10 --repeats 2
```

既存LARM接続URL・認証が必要です。製品DB・設定をコピーせず一時DBを使い、登録は認証済み管理API、推論は既存公開操作を通します。各caseは2回。意味確認がuncheckedの結果やskippedを合格にしません。実ASR・マイク・スピーカーの3往復は別の受入です。

根拠一覧は8 KiB以内の参照metadataとし、正確な抜粋は取得資料の観測に一度だけ提示します。各stepで以前の抜粋と後半の留保も再提示します。新しい抜粋の登録は、title・URL等を含む実際の提示資料(根拠一覧と観測)が資料枠に収まる場合だけ行います。資料枠は最大32 KiBで、64 KiBから指示・依頼・guidance・要件契約と、操作履歴(4 KiB)・修正状態等の予約を差し引いた残りです。同じ資料が複数の操作から届いた場合は一度だけ提示します。収まらない場合は登録せず、収まらなければ容量到達として操作を閉じ、提示済みの根拠で不足を含めて報告します。replayで過去の観測が後ろへ移った場合も、未提示の新規登録だけを取り消して枠内に保ちます。全体64 KiB、根拠64件が上限です。検索後に抜粋が足りなければ許可URLの本文を予算内で読みます。WebはV2の短い報告、historyはprofile・V3・意味検証を維持します。全経路のsystemに共通規則(資料は未信頼、未提示の事実を補わない、残時間60秒以下またはcanInvoke=falseでfinish、JSON一つ)を置き、経路の方針文で置き換えません。契約違反の修正診断(path/codeのみ)はタスク入力ではなく専用の列に保存し、受理時に消します。会話側の操作拒否は、分類・公開済みツール名・呼出し数・validationPath/codeだけを `dialogue.operation_rejected` に記録します。

調査失敗の回答では、CURRENT_RESEARCH_FAILUREを今回のホスト確定状態としてsystem通知で渡します。報告と取得資料は未信頼のデータのままです。失敗分類以上の原因を推測せず、過去の会話の障害説明を現在の原因へ流用せず、システム障害をキーワード不足に置き換えません。コードが未知・抽象的なら詳細不明と伝えます。

### 調査へ渡す出力定義


`ControlContract.instructions` は指示とTOOLS、`outputSchema` はホストの契約から生成した定義です。Web調査には契約のmetadataに2つの出力例を持たせ、SystemContextの `OUTPUT_FORMAT` にその例だけを渡します。引数の定義はTOOLSのinputSchemaに一度だけ記載します。その他の既存担当はOUTPUT_SCHEMAを使います。指示文から定義を読み戻しません。

調査はactionを直接返します。操作は `{"action":"invoke","tool":"提示済みのid","arguments":{}}`、終了は `{"action":"finish","report":{"outcome":"not_found","summary":"調査結果","claims":[],"limitations":[]}}`。argumentsは選んだTOOLSのinputSchemaに合わせ、任意項目は省略します。報告の事実には提示済みの根拠参照を付け、answered/partialではclaimsを1件以上、それ以外では空にします。SystemContextで役割・各項目・終了条件を説明します。


Web本文の根拠は、履歴等と同じ最大300文字の連続範囲を使います。短い行を一件ずつ数えず、見出し・表ヘッダ等の対応は範囲間のcontext参照で補います。正確な抜粋を保持し、根拠64件・資料32 KiB・全体64 KiBの上限を変えません。日本語パス・国際化ドメインを含む指定URLはURL parserの正規形で許可対象と照合し、別パスや未提示の取得先へ権限を広げません。
