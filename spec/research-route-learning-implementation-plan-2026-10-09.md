# 検索キーワードによる取得先学習と動的SKILLの実装計画

作成日: 2026-10-09 JST。状態: 実装前・文書レビュー反映済み。実装担当: Sonnetを含む実装エージェント。

小さな作業単位、契約、依存順、試験IDをまとめた[実装チェックリスト](research-route-learning-implementation-tasks-2026-10-09.md)を実装の手順書とする。設計の正本は本書、作業の順序はチェックリスト。両者の変更は同時に反映する。

既存コードとの照合による[文書レビュー記録](verification/research-routes/plan-review-2026-10-09.md)を付属する。レビューで確認したのは設計と既存契約の適合であり、本機能の実装・検証完了ではない。

初回はWeb検索で取得先を見つけ、対象と日時が合うデータを取得できた手順を保存する。同じ検索キーワードの次回依頼では、保存した1サイトを直接確認して最新値を取得する。サイトにアクセスできない、構造が変わった、必要なデータが得られない場合は再検索し、新しい取得先で成功してから登録を更新する。

保存対象は検索候補と成功した取得手順であり、天気・株価の過去値を今回の回答に再利用しない。取得手順を動的なSKILLとして版管理し、SystemContextには該当するキーワードの参照先と利用規則だけを展開する。本文を読む子と、要約だけを受け取るメインの境界は維持する。

## 1 実装の前提と初版の範囲

baselineは commit `0492c6bf44cfbb6328fdf899e05570068ef9c004`。直前の実装・レビューのfixtureはbackend 363件、Web 94件、browser 16件、関連9 domain gateが合格。実LARMと公開Webの隔離backendでは天気29.0秒、株価34.8秒だった。ただし工程別の所要時間は計測していない。agent内の通常4制御推論にメインの回答生成が加わり、正常系で通常5回のモデル呼出しになる。これらは今回の変更後の合格結果ではない。

既存の[Toolchain実装計画](.archived/toolchain-web-research-implementation-plan-2026-10-09.md)と[レビュー記録](verification/toolchain/review-2026-10-09.md)、[domain規則](../docs/domains.md)、[ログ規則](../docs/logging.md)を前提とする。着手時に差分を確認し、並行作業を戻さない。

| 現在の実装 | 今回の変更 |
| --- | --- |
| `web-research/service/cache.ts` はstable本文用。lookup結果は保存しない | 検索候補と成功経路の保存を追加。stable本文cacheとは別契約 |
| 組込みSKILLと `publicInvocationHint` は天気・株価を検索より先に専用取得する | 未登録キーワードでは最初に実Web検索。登録済みだけ直接取得 |
| 候補検索・選択はcoordinatorの2制御推論 | キーワードをホストで特定できる登録済み依頼では両方省略 |
| workerがinvokeを生成してから取得する | 登録済みの固定手順はホストが子の所有権でinvoke。子の初回判断も省略 |
| capabilityは組込み定義の登録と少数検索。公開APIは一覧のみ | 動的SKILL・packageの草案、レビュー、有効化、版管理を追加 |
| 子のreport検査は引用の実在中心 | 経路の学習には対象・必要項目・日時の追加検査を要求 |

初版で完成させるのは天気・株価のキーワード経路。鎌倉と静岡市、AAPLを受入例とする。通常会話、一般の比較調査、明示URL読取りは既存経路を維持する。明示URL読取りに発見検索を強制しない。一般検索をすべて自動SKILL化する拡張、任意スクリプト生成、外部文書書込み、全サイト対応、意味の似た検索への転用は含めない。既存の主DBとwriter、Queue、LARM認証、Webのguardと通信制限を再利用し、新規ライブラリを前提にしない。

## 2 検索とキャッシュ照合に同じキーワードを使う

`SearchSpec` を一度だけ生成し、キャッシュ照合と最初の `web.lookup` の両方で使う。別々のモデルに検索語と照合語を作らせない。

```ts
type SearchSpec = {
  keyVersion: 1;
  keywords: string;                 // 正規化済み。最初のlookup.queryもこの値
  scope: "local:owner";
  language: "ja" | "en";
  region: "JP" | "US";
  timeZone: string;
  purpose: "weather" | "quote";
  target: WeatherTarget | QuoteTarget;
  requiredFields: string[];
  timeMode: "today" | "tomorrow" | "latest" | "absolute";
  absoluteDate?: string;
};
```

`cacheKey = sha256(canonicalJSON(SearchSpec))`。元のkeywordsとcanonicalJSONもDBに保持し、hashだけで意味を判断しない。scope・地域・市場・日時の扱いが違えば別キー。問い合わせの原文全体を検索語やキーに入れず、公開情報を調べるための短いキーワードを保存する。最大400文字、最大16語。

正規化はUnicode NFKC、前後空白の除去、連続空白の統一までを共通処理にする。ホストの有限な依頼パターンで「鎌倉の天気を教えて」「天気予報 鎌倉」を同じ `天気予報 鎌倉` にできるが、任意の語の削除、類義語検索、embedding一致、地名の包含一致、語の無条件な並べ替えはしない。tickerの `^`、`.`、`-` は保持する。変換規則を `keyVersion` に含める。

`buildSearchSpec(question)` は `matched / ambiguous / unsupported` のunionを返す。matchedの場合はモデルを呼ぶ前に照合可能。ambiguousでは対象を確認し、unsupportedでは既存coordinator経路を使う。初版のunsupportedでは学習しない。coordinatorへ新しい対象確定schemaを追加せず、既存の通常回答を使う。未確定の対象や一般調査を不完全なキーで登録しない。自然文から確実に同じキーワードを生成できないケースで、推論なしの高速化が実現したと記録しない。

### 地点と対象の境界

| 入力例 | 判定 |
| --- | --- |
| `天気予報 鎌倉` | 鎌倉のキー。未登録なら検索、登録後は鎌倉用サイトを確認 |
| `天気予報 静岡市` | 静岡市の別キー。鎌倉の成功履歴は使わない |
| `天気予報 静岡` | 鎌倉のキーには一致しない。検索時に市・県の対象が曖昧なら確認し、確定前に経路登録しない |
| `鎌倉 明日の天気 最高気温` | timeModeと必要項目を含むキー。明日の日付は毎回Asia/Tokyoで解決 |
| `鎌倉 2026-10-10 の天気` | 絶対日付のキー。別日付へ転用しない |
| `株価 AAPL USD` | 銘柄・市場・通貨・価格種別を固定。別銘柄や別通貨に転用しない |

`WeatherTarget` は地点名、都道府県、地点の粒度を保持する。将来の粒度はcity / prefecture / stationだが、初版の学習はcityだけ。初期のホスト別名表は鎌倉・鎌倉市、静岡市のように確認できる少数の対応だけ。静岡を勝手に静岡市へ、鎌倉を神奈川県全体へ置換しない。県単位の専用JSONが読めても、市単位の依頼が達成できたとは扱わない。`QuoteTarget` はticker、市場、通貨、regular / realtime / historical等の価格種別を保持する。初版の既存Yahoo専用取得はregular-marketの遅延・終値を含む値であり、realtimeを満たす経路として登録しない。

### 初版の入力契約と実行時束縛

実装では上記の概略型をpurposeによるdiscriminated unionにする。weatherは `{name, prefecture, granularity:"city"}`、quoteは `{ticker, market, currency, priceKind}` を必須とし、未知の値を空文字や仮の市場で登録しない。初版のquoteはregularだけを学習する。AAPLのNASDAQ/USD対応はP0で確認したホストの識別子表に限り補完し、他の不明な銘柄は確認または通常経路に戻す。依頼の市場・通貨指定が表と異なれば別キーになる。

weatherのrequiredFieldsはcondition必須＋任意maxTemp/minTempの閉じた集合、quoteはprice/asOf/currency/market/priceKindの固定集合。重複を拒否して辞書順に並べる。省略時の天気はtoday＋condition、株価はlatest＋regularとする。初版の天気timezoneはAsia/Tokyo、株価は市場の固定timezone。language/regionはja/JPまたはen/USの組だけとし、明示指定と既定値を同じ形へ正規化してからhashする。absoluteDateはabsoluteでだけ必須の実在するISO日付。他のtimeModeには許可しない。purposeごとに許容するtimeModeもschemaで制限する。

有限パターンは入力全体に一致させる。引用、複数対象、比較、追加指示を含む入力を部分一致で高速経路へ送らない。本文中の「株価 AAPL」という単語だけで株価依頼と判断しない。経路判定の失敗は通常経路へ戻す。

相対日付は各依頼の受付時刻をclockで一度だけ解決し、`RequestBinding = {specDigest, requestAtMs, expectedDate, validationPolicyVersion}` に固定する。today/tomorrowのキー自体に解決日を含めず、次の日の新依頼では新しい対象日を取得する。同run中に日付が変わっても束縛日は変更しない。URL引数が絶対日付を含み毎回変わるサイトは、初版の相対日付recipeとして登録しない。

初版はSearchSpecの完全一致だけを使う。「必要項目の多い経路を少ない依頼へ使う」包含検索や、地点共通のURLテンプレートへの一般化は後続とする。これにより、未確認の静岡で鎌倉の手順が使われることを防ぐ。

## 3 検索候補と成功経路を分ける

| 種類 | 保存内容 | 有効な用途 |
| --- | --- | --- |
| 検索候補 | keywords、最大5 URL、provider、検索時刻、scope、検索条件 | 成功経路がまだない場合の候補選択 |
| 成功経路 | 対象、primary URL、固定toolと引数、検証条件、SKILL/package参照、成功日時 | 検索を省略して1サイトを取得 |
| 過去の取得値 | 現在のreport保持規則に従う | 今回の最新値として再利用しない |

検索候補は24時間で失効し、title/snippetも未信頼データとして扱う。検索候補だけでは高速経路を有効にしない。active経路の通常利用は1サイトの新規取得だけでよく、候補TTLの終了だけを理由に毎回検索しない。成功経路は14日未使用で削除対象とし、更新確認の絶対期限は30日。期限は定数とテスト用clockから計算し、一覧表示では延長しない。今回の検査と回答採用が成功したwarm利用でidle/lastSuccessAtだけを更新し、絶対期限後は実lookupを経て新版を登録する。warm成功のたびにproof/draftやauthor/reviewを作成しない。

最大5,000キー、同じキーの非終端draftは最大1件、候補8KiB/キー、経路と展開内容12KiB/版、総量64MiB。総量には候補・proof・草案・操作重複防止行とcapabilities側の学習定義・検索索引も含め、UTF-8 bytesをホストで集計する。最大件数まで常に登録できる保証ではなく、bytes上限を先に満たすこともある。容量回収は失効・未使用の古い経路から行う。保護対象だけで上限に達した場合、新規学習をskipped_capacityとして止め、既存回答を失敗させない。本文や任意のProvider生応答はこの保存層に置かない。

実行中run、非終端draft、採用待ちticketが参照する版と依存閉包を保護する。capabilitiesに `pruneLearnedInTransaction` を追加し、research-routesが算出した保持対象の補集合に限り、学習由来かつroute-onlyの定義を公開操作で削除する。組込み定義や他domainの定義は削除できない。route削除と能力GCは同じwriter内で行い、caps SQLを経路domainから操作しない。disabledキーは利用停止の意思を保持するためidle回収せず、候補・版・草案だけを回収する。明示rediscover/clear以外でenabledを復活させない。disabledも5,000キー上限に数える。失効proof/草案は終端後24時間、操作重複防止は24時間、履歴版は非保護なら最長30日で回収する。sweepは起動時と1時間ごとに既存Queueのメンテナンスjobで動かし、1回最大100行。明示clearの物理回収は別のreplay_safe jobで最大100行ずつ進め、writerを長時間占有しない。取消・clearで消える行のincarnationを再利用しない。キーの子行は自domain内のFKで参照し、参照先の旧版を残す間は削除しない。capabilitiesやagentのtableへの跨domain FKは追加しない。key→active版の循環FKは作らず、公開activate操作が対応を確認する。epochの異なる同じキーは共存でき、current epoch以外をAPIへ返さない。64MiBは論理保存量でありSQLiteファイルの縮小保証ではない。

## 4 所有するdomainとファイル配置

永続的な検索キー・成功経路は、新規 `research-routes` domainに置く。これはstable本文cacheとは保持期間・利用条件・有効化処理が異なるため、既存cacheテーブルに混ぜない。主DBの同じwriterを使う。

| 所有者 | 責務 |
| --- | --- |
| `research-routes` | SearchSpec、検索候補、成功証拠、経路草案・版・健康状態、対象/日時/値の検証、author/reviewの業務とQueue handler、登録transaction、SQL、試験 |
| `capabilities` | 動的SKILL/packageの不変版、停止、閉包hash、登録契約の検査 |
| `agent-runtime` | 取得子、汎用のホストstepとplan差替え、子の要約境界、取消・復旧。サイト学習・編集の業務判断は持たない |
| `tool-runtime` | 新runへ発行した実行参照、取得URLの範囲、予算、結果vault、期限 |
| `web-research` | 現在のlookup/read、通信、guard、stable本文cache |
| `dialogue` | 通常の回答採用、学習候補を保存するための確定済み通知 |
| `application` | 各domainのport接続、ルーティング・API結合。業務検査とSQLはdomainの公開操作に委譲 |

`research-routes.depends = ["capabilities", "inference", "queue"]` とする。既存agent-runtimeの依存は増やさない。経路domainが下位の不変定義登録・推論・job受付の公開操作を使う形は、既存service-testsやschedulerと同じ考え方である。agent-runtime/tool-runtime/dialogueは自分が所有するport契約を受け取り、経路domainをimportせず、そのSQLも読まない。経路domainもagent-runtime/dialogue/web-researchをimportしない。下位domainからapplicationへのimportは禁止。

portは以下に限定し、applicationはDTO変換と公開操作の接続だけを行う。

| 契約を所有するdomain | portと境界 |
| --- | --- |
| agent-runtime | `AcquisitionPlanPort.resolveInTransaction(db, {question, requestAtMs, owner})` → unmatched/clarification/search-first/direct。resolveのplanはrootに束縛した提案tokenであり、実行許可ではない。子の作成後に `bindInTransaction` でchild ownerへ束縛する。runtimeがchildのparent/root/cancel epochを確認し、hostのみが呼べる。子のためにpackageをprepareし、初めてURL grantを発行する。rootのexecutionRefを子へコピーしない。`validateInTransaction`、`validateAdoptionInTransaction`、`recordObservationInTransaction`、`releaseInTransaction`も同portで定義。SearchSpec型やサイト名別の判定をagent内に置かない |
| tool-runtime | `CachedSourceAuthorizationPort.validateInTransaction(db, {owner, bindingToken, packageHash, exactUrl})` → allowed/rejected。grantの発行はhost操作のみ。URL安全検査自体は既存adapterに残す |
| dialogue | `PostAnswerObserverPort.recordInTransaction(db, {runId, ticketId, reportEpoch})` → recorded/skipped。通常の採用完了後に呼び、本文は渡さない |
| research-routes | `SourceAdoptionPort.validateInTransaction(db, {runId, taskId, ticketId, reportEpoch})` と `protectedBindingsInTransaction`。元runの採用・取消・削除と保護参照を他domainの公開操作で確認する。終了済みrunをpendingとして復活させない |

経路の健康判定、facts検査、SearchSpec生成、author/reviewのprompt、失効理由の分類はresearch-routesが所有する。agent-runtimeはtool結果から内部の最小検証用観測をportへ渡し、domainが返す検査結果を使う。本文をメインへ渡す公開DTOは増やさない。safe projectionとbindingはagent_reportsの追加列に保存し、prepareAnswerがその内容を使う。投影をメモリーだけに持たず、台帳にraw reportとは別のdigestで固定する。内部factsはagent-runtime所有のopaque検証拡張としてfinishへ追加し、research-routesが自分のschemaで検査する。runtimeにweather/quoteの項目定義や認識ルールを重複させない。portなしの既存fixture・機能は従来経路へ戻り、未接続の学習処理を黙って成功扱いしない。

主な追加・変更先:

- `api/domains/research-routes/{contracts,repository,service,controller,test}/`、`index.ts`。
- `api/domains/capabilities/service/learned.ts`、`test/learned.test.ts`。
- `api/domains/research-routes/service/{keys,validation,registry,authoring,reviewing,plans}.ts`、固定author/reviewer SKILLと対応するtest。
- `api/domains/agent-runtime/service/route-step.ts`、汎用plan差替えと対応するtest。
- `api/domains/inference/contracts/index.ts`、`service/index.ts`、maintenance controlのtest。
- `api/domains/tool-runtime/contracts/index.ts`、`service/index.ts`、`test/invoke.test.ts`。
- `api/domains/capabilities/builtin/web-research/SKILL.v2.md` の追加、`builtin/web-research.ts` の新版追加。旧SKILL.mdと旧版定義は保持。
- `api/application/research-routes.ts`、既存 `toolchain.ts`、`server.ts`、`app.ts`、`migrations.ts`。
- `client/research-routes.ts`、`cli/index.ts`。
- `web/src/domains/research-routes/`、`web/src/App.tsx`のpanel接続、SettingsPageのrender slot、既存調査card・SSE query更新。
- `scripts/domains.ts`、`scripts/research-routes-live.ts`、`scripts/verify-live.ts`。
- `spec/verification/research-routes/README.md`、`docs/domains.md`、`docs/logging.md`、`README.md`。

## 5 永続テーブルと公開操作

`research-routes` は以下のmigrationを公開し、applicationのmigration配列の末尾へ追加する。適用済みmigrationを編集・並べ替えない。

| テーブル | 必須列と制約 |
| --- | --- |
| `research_route_state` | singleton ID、epoch。全削除時に増加し、行を再作成しても過去の権限を復活させない |
| `research_route_keys` | (epoch, key) PRIMARY KEY、incarnation UNIQUE（再作成ごとのUUID）、search_spec_json、keyword_text、generation、active_version_id、enabled、control_version、suspension_reason、retry_after、last_success_at、idle_expires_at、created_at、updated_at |
| `research_search_candidates` | (epoch, key) PRIMARY KEY、generation、hits_json、searched_at、expires_at、provider_version、digest、source_run_id、source_step_id、incarnation |
| `research_route_revisions` | version_id PRIMARY KEY（新登録ごとのhost UUID）、epoch、key、incarnation、revision、UNIQUE(incarnation, revision)、recipe_json、context_projection、skill_revision_id、package_revision_id、proof_digest、review_digest、registration_certificate_json、created_at、revalidate_at。不変。revisionの利用停止は別のhealth行に記録 |
| `research_route_revision_health` | version_id PRIMARY KEY、disqualified_at、reason。利用不能版を識別し、新版の有効化と区別 |
| `research_route_proofs` | id PRIMARY KEY、root_run_id、task_id、ticket_id、report_epoch、epoch、incarnation、key、generation、source_url、binding_json、projection_digest、lookup_provenance_json、validation_policy_version、facts_json、fetched_at、validated_at、adopted_at、status、digest、expires_at。raw本文なし |
| `research_route_drafts` | id PRIMARY KEY、key、epoch、incarnation、base_generation、base_version_id、origin（adoption/edit）、proof_id nullable（adoptionのみ）、base_certificate_digest（editのみ）、skill_draft、review_json、state、error_code、created_at、expires_at |
| `research_route_operations` | (scope, request_id) UNIQUE、input_digest、response_json、expires_at。POSTの同じ入力には同じ結果、異なる入力には409 |

経路の表示stateは `unregistered / preparing / active / suspended / expired / disabled`。state列を二重管理せず、enabled、active_version_id、健康状態、期限、draftからbackendが導出する。優先順はdisabled→suspended（版がdisqualified）→expired（版の期限/policy不適合）→active（健全な版あり）→preparing（版なし・非終端draftあり）→unregistered。編集中でも健全な版があればactive。draftは `queued / authoring / reviewing / activated / rejected / interrupted / superseded` とし、後半4つが終端。reviewerのapprovedは判断値であり永続的な中間stateではない。idle期限、proofのrun、draftの状態にindexを付ける。`generation` は停止・明示rediscover等の権限変更で増える。通常の健康状態更新や新版へのactive pointer切替では増やさない。CASとgrant/draft/proofは `epoch + incarnation + generation + expectedVersionId` を束縛し、削除後に同じキーをgeneration=0で作り直しても古いjobを拒否する。正常な新版登録は実行中の健全な旧版を無効にしないが、旧版のdisqualified化は旧版による採用を拒否する。

経路のdisabledは保存済み経路の利用と自動学習を止める状態。通常の検索による回答自体は既存の権限の範囲で可能だが、自動でactiveを再作成しない。明示のrediscoverで停止を解除して次回検索へ戻す。capability自体の停止は別であり、検索でその権限を補わない。

公開操作は `lookupInTransaction(SearchSpec, RequestBinding)`、`storeCandidatesInTransaction`、`validateProof`、`recordAdoptedProofAndEnqueueInTransaction`、`createDraftInTransaction`、`getDraftInTransaction`、`activateInTransaction`、`markFailureInTransaction`、`disableInTransaction`、`clearInTransaction`、`sweepInTransaction` とする。戻り値を確認してからjobを完了する。activateは期待epoch/incarnation/generationと旧version IDを必須にしてCASで更新する。SQLやモデル応答をcontrollerから直接実行しない。

research-routesの登録serviceがcapabilitiesの公開操作を呼び、SKILL/package登録、経路版追加、active pointer更新を同じwriter transactionで行う。applicationに登録の業務判断を置かない。失敗すれば全部rollbackし、表示と実行で異なる版を使わない。grant/vault更新、Queue起床、SSE通知はcommit後に永続状態を読み直して行い、rollbackした草案のメモリー参照を公開しない。

## 6 取得の状態遷移と高速経路

### 登録前

1. 現在の依頼からSearchSpecを作り、経路を照合する。新キーの台帳が容量内なら作成し、満杯ならlookup(reason=capacity, fence=null)で通常取得へ進む。台帳不足で会話を失敗させない。
2. activeがなければWeb検索する。候補だけが有効なら、その候補を使う。過去に成功した経路がない新キーは、最初の候補保存前に必ずlookupを1回実行する。
3. 子は許可された候補から一次資料を優先して1サイトを読み、対象・必要項目・対象日時を検査する。不足時だけ既存の上限内で別候補を確認する。
4. 子の根拠付きreportをメインへ渡し、回答を通常のticket/epoch検査で採用する。
5. 初回・期限切れ・代替取得成功だけを学習対象にする。回答採用transactionの任意学習用SAVEPOINTで、経路登録に使える成功証拠とauthor job受付を確定する。受付失敗は学習部分だけrollbackし、採用した回答は残す。登録のモデル呼出しは回答後に行う。

照合結果は `direct / candidate / lookup / disabled / unavailable` の閉じたunionで返す。directは健全なactive版、candidateは未登録/preparingの完全一致・現世代・有効候補だけ。期限切れ、サイト故障、初回、rediscover後の古い候補、policy版変更ではlookupを強制し、モデルや候補cacheで省略できない。disabledは通常の回答のみで候補保存・学習を停止する。能力/権限失効のunavailableは再検索せず終了する。

SearchSpecをホストで作れる場合、初回の最初のlookupもホストstepで実行できる。ただし検索の実行を省略して専用取得した結果を「初回検索済み」として保存してはならない。組込み `publicInvocationHint` が未登録でforecast/quoteを勧める現挙動を停止する。検索で見つかったサイトと、専用APIの対応関係はホストの固定mappingで検査する。モデルが任意の検索URLからYahoo/JMA以外のAPIを発明することは許可しない。

### 登録後

1. SearchSpecの完全一致とactive版、現在policy、epoch/incarnation/generationを確認する。
2. packageを直接準備し、必須profile/SKILL・tool schema・依存hashを検査する。
3. coordinatorと子のtaskを作り、子に所属する新しい実行参照とURL許可証を発行する。
4. ホストstepが登録済みの1tool/1サイトを実行する。用途判断・能力候補検索/選択・初回invoke判断の制御推論は行わない。
5. 子は今回取得した本文から要約と検証用factsを作る。ホストが引用・facts・経路版の有効性を検査する。
6. メインが検証済み要約だけを使って回答する。本文・引用・titleは従来どおり親へ渡さない。回答採用後は利用日時の更新だけを行い、登録jobは0。

正常なwarm経路のモデル呼出しは子の要約1回＋メイン回答1回の計2回。登録のauthor/review呼出しは別jobとして集計する。モデルのJSON修正や一般経路への移行が起きたrunを「2回」と記録しない。

保存する `RouteRecipe` は `toolId: web.read / web.forecast / web.quote`、そのtoolのstrict入力schemaに合うarguments、exact sourceUrl、SearchSpec digest、`validationProfile: weather-json-v1 / weather-excerpt-v1 / quote-json-v1 / quote-excerpt-v1`、`singleSource: true` を必須とする。lookupをwarm recipeに保存しない。argumentsはホストが束縛し、ユーザーの新しい依頼から任意の値を上書きしない。動的な日付の検査は受付時に確定したRequestBindingを使う。今回の取得で新しく確認するが、同run途中の再解決はしない。

`agent.route-step` を追加し、LLM資源枠を使わずprepare/settleで台帳を更新する。既存のLLM stepとはhandlerを分ける。1step1job、commit後に取得開始、待機中の親は推論枠を持たない。stepには `actionOrigin=host / model` を末尾migrationで追加し、host actionに架空のinference receiptを作らない。workerが同じinvokeを再生成して二重実行しないよう、stepIdによるidempotencyを共用する。

## 7 保存されたURLと能力の許可範囲

現在の `web.read` は、依頼の明示URLまたはそのrunの検索観測URLだけを許可する。保存済みURLを単に `allowedUrls` に足して検査を省かない。

tool-runtimeにhost発行の `cachedRouteGrant` を追加する。grantはowner（root/task/cancel epoch）、key、epoch/incarnation/route revision/generation、RequestBinding、package/hash、exact URL、deadlineを固定したメモリー参照とする。発行・使用時にapplicationから注入した検査portを呼び、現在のSearchSpecと経路が一致するか再検査する。モデルにはgrantの作成・変更を許可しない。URL変更は再検索と新しいgrant発行で行う。

候補cacheのURLも過去runの検索観測であり、そのまま現在のread許可には使えない。tool-runtimeに `importSearchCandidatesInTransaction` を追加し、同portにkind=route/candidateのdiscriminated unionを追加し、hostが候補のSearchSpec/epoch/incarnation/scope/TTL/provider digestを確認してから、今回owner用の検索観測と読取り許可を最大5 URL発行する。観測のoriginはcandidate-cacheとし、実lookupのreceiptを偽造しない。候補保存時には元のlookup run/step、正規化query、検索時刻、hostが保存したdigestを記録する。proofは現在のcache-import stepと元lookupのprovenanceを両方持つ。新規キーの最初の検索はこのimportで代用できず、clear後の古い候補もimport不可。

能力の準備には `prepareActiveByIdInTransaction` を追加し、既存prepareと閉包/schema/容量検査を共用する。package IDだけで停止・必須SKILL・hash検査を飛ばさない。使い回すのはrecipeであり、candidateRef・executionRef・resultRef・sourceIdは毎run新しくする。

通信のpublic DNS、接続先IP固定、TLS、redirect拒否、最大応答、guardは毎回実施する。登録済みだからtrustedな本文になるわけではない。任意URLや任意header・credential・スクリプトはrecipeに含めない。

## 8 経路を学習するためのデータ検査

reportの引用検査だけで経路を有効化しない。子のfinish契約に、経路対象の場合だけ必須の `facts` を追加する。従来の通常reportとparentProjectionの公開形式は維持し、factsは経路検査へだけ渡す。

weather factsは地点と粒度、予報対象日、timezone、天気、要求された気温、単位、発表時刻または時刻の確認状態、sourceIdと引用を持つ。quote factsはticker、市場、通貨、価格種別、価格、価格時点/timezone、遅延・終値の扱い、sourceIdと引用を持つ。値は今回可視のsource本文から取得する。

既存の公開JSONはホストの型付き抽出を使い、要求との完全な照合を行う。通常ページは、短い同一の引用範囲に対象ラベル・対象日・該当値があるか、ホストが対応する日時/数値表記を解析して検査する。独立した別の段落・別地点・週間の別日付から値を寄せ集めたfactsは登録に使わない。400文字で根拠を保持できない、日時や場所の対応が不明、snippetだけ、truncated、取得部分失敗、相反する値が未解消なら登録不可とし、通常のpartial回答に留める。

初版の数値・日時recognizerはホストの有限な実装とする。生成した任意regex、CSS/JavaScript、コード実行は認めない。未対応表記は登録不可である。P0で鎌倉/静岡市の実サイトがこの検査を満たせるか確認し、必要な有限表記をfixture付きで追加する。実サイトの検査を満たせない場合はfixture成功とlive未達を分け、対象地点の対応を宣言しない。

成功証拠にはlookupのrun/step、読取りのrun/step、該当サイト、今回のfacts、ホスト検査の版とdigestを記録する。検索で出たページと実取得URLの関係を確認できない経路も登録しない。hostの検査は構造・一致・時点の証明であり、1サイトの情報が世界の事実として正しいことの保証ではない。

初期の鮮度上限は、予報の発表から24時間、regular-market株価の価格時点から7日。未来の発表/価格時点はclockの5分以上先なら拒否する。予報は解決した対象日と一致することを別に要求する。株価の7日は休日等を含む最終取引値の許容上限であり、realtimeを意味しない。取得日時を元データの時点の代わりにしない。発表時刻・価格時点が確認できない資料は学習不可。これらの上限はhostの検査policyとして版管理し、SKILL編集で広げられない。

### source検査とreport検査を分ける

検査結果は `valid / source_unusable / report_invalid / policy_unavailable`。ホストが独立抽出した対象/日付/値が資料そのものに存在しない場合だけsource_unusableとし、再検索の根拠にする。資料が正しく子のfactsや根拠引用が不一致ならreport_invalidで、既存の修正上限を使う。これを理由にサイトをsuspendedにしない。policy_unavailableは未対応の検査版等であり、通常検索へ戻すか固定失敗にして、旧policyで通さない。policy版変更による再探索は能力停止の迂回と区別する。判定ルールは経路domainにだけ置く。

検証済みfactsから経路domainが親向けsummary/claims/limitationsを固定rendererで作る。既存parentProjectionと同じ形でagent-runtimeへ返し、経路対象に限ってモデルが書いた自由文をこの投影に置換する。子はfactsと根拠を返し、ホストが引用と構造化値の一致を検査する。weather conditionはP0でfixture化した有限コードに正規化し、親には固定の日本語ラベルを渡す。ページの自由文・モデルの未検査summary・未検査limitationsをコピーしない。agent_reportsのreport_jsonも経路対象はcanonical reportを保存し、管理API/調査cardへ不一致のモデルsummaryを表示しない。canonical claimsのevidenceは検証済みfactsのsourceId/quoteから作り、別日付のモデルclaim引用を流用しない。自由文summary/claimsの意味検査を合否にせず置換し、facts/引用が不正な場合だけreport_invalidにする。一般調査の従来要約は変更しない。これにより、factsが27なのにsummaryだけ26、または命令文という不一致を親へ送らない。最終回答モデルの全ての誤りを防ぐ保証ではなく、liveでは最終回答と投影の値・日時も比較する。

内部factsは最大4KiB、源の引用は既存の400文字上限を維持。証拠を検査するrecordObservation操作は新規登録・再探索でのみ子のreport/receipt採用と同じtransactionでobserved proofを保存する。正常directのwarmではcanonical report/projectionを返すだけでproofId=null。observedは非公開で学習不可、回答採用時だけadoptedへ進める。失敗・取消・期限切れのobservedはroot期限後に回収する。引用本文は保存せず、元資料digest、lookup provenance、検証済みfactsとbindingだけを残す。台帳に入らないcapacity経路でも純粋検査と安全な投影は行い、proofId=nullで登録だけを省略する。

株価の既存JSON抽出には市場を確認できるフィールドも追加し、Providerのexchangeコードから固定mappingで市場を照合する。依頼のNASDAQという単語をそのまま取得元の市場証明にしない。地名・市場・通貨・価格種別が依頼と一致したことをproofに残す。

### 親向け投影の保存

agent_reportsへsafe_projection_json/safe_projection_digest/acquisition_binding_jsonを末尾migrationで追加する。finishの同じtransactionで保存し、prepareAnswerは経路対象ならこの投影を読み、従来のモデルreport.summaryへ戻らない。通常調査は追加列nullで既存parentProjectionを使う。adoptionの再検査は保存済みprojection digestとreport digestの両方を確認する。

## 9 動的SKILLとSystemContextの登録

Codexのローカル `skill-creator` と `system-context-engineer` をEumenesのLLMが直接呼べるわけではない。それぞれの手順を製品内の固定profile/SKILLとして定義し、既存LARM control経路で実行する。ユーザーのCodex skillフォルダーやglobal設定は変更しない。

### 作成担当

`research.skill-author` は、新規作成と編集の草案を生成する。入力はSearchSpec、ホスト検査済みproofの構造化値（URL、対象、時刻、項目と検査digest）、固定tool契約、現在版、編集要求だけ。proof内の引用・自由文や前回の値は渡さない。recipeは検証済み取得からホストが先に固定し、authorには変更を許可しない。外部ページ本文・snippet・titleをsystem instructionへ持ち込まない。出力はstrict JSONの `name / description / body / contextRule / recipe`。nameは1〜64文字、descriptionは1〜256文字。bodyは4KiB以内、contextRuleは512bytes以内、全体8KiB以内。ただし推論側の既存control出力上限2048 tokensも維持し、両上限の小さい方を満たす。contextRuleはレビュー対象の草案であり、そのままSystemContextへ保存しない。

SKILLに書くのは適用キーワード/対象、最初に確認するサイト、許可toolと引数、必要な項目・時点、失敗時の再検索、停止条件。過去の価格・気温をinstructionに含めない。siteの操作要求、権限追加、秘密、他taskへの連絡、任意コード実行は登録契約で拒否する。共通の固定Web SKILLは必須とし、動的SKILLはその上に追加する。固定rendererでrecipeのURL/対象/tool/停止条件を明記し、自由文には外部操作権限を与えない。

### SystemContext確認担当

`research.context-review` は適用範囲、固定policyとの矛盾、外部データの指示化、情報と権限の混同、検索省略条件、失敗時の再検索と停止、context bytesを確認する。出力は `approved / rejected`、理由code、問題箇所、draft digest。reviewにはauthor JSONだけでなく、最終登録予定のrendered SKILLとhost Contextも渡す。digestはspec/recipe/baseVersion/policy/rendered SKILL/Contextのcanonical JSONからhostが計算する。review後に文字列を追加・変更せず、登録は同じdigestの内容だけを採用する。reviewのcode/problem条件はチェックリストのstrict schemaを使い、approvedはcode=null/問題0件、rejectedは閉じたreason codeと1〜8件の問題箇所を必須にする。reviewerは草案を勝手に有効化できず、本文も未信頼のレビュー対象データとして受け取る。

ホストがstrict schema、recipeとproofの一致、URLとtoolの許可範囲、固定SKILLの存在、選択内容の16KiB上限、禁止操作を検査する。登録時の「挙動検査」は純粋な `validateRegistrationScenarios` で、同じspecの直接取得、別地点のmiss、未登録のsearch-first、取消・不正URLの拒否をホストの構造化planから判定する。登録のたびにテストrunnerやモデルの疑似会話を実行しない。自由文の意味の正しさをホスト検査で証明したとは記録しない。モデルのapprovedだけでは登録しない。review不合格の自動修正はauthor1回、review1回まで。それでも不合格ならrejected。登録処理の総deadlineは120秒、制御推論は各job30秒、初回author/reviewを含め最大4呼出し。

### 保存と展開

キーワードに対応するSKILLとpackageを `learned.web.<versionId>` というkind別の不変ID（各revision=1）で登録する。versionIdはhost UUIDを32桁hexにしたもの。key/route revision/incarnationとの対応は経路台帳が保持する。既存の101文字ID上限を守り、同キーの削除・再作成でも旧能力IDと衝突しない。同じcapability itemのactive revision更新は既存のgeneration検査で旧runを失効させるため、経路の版ごとにitemを分ける。共通profile/Web SKILLの停止・更新による失効検査は従来どおり適用する。packageは固定profile＋共通Web SKILL＋動的SKILL＋recipeに必要なtoolだけを参照する。学習ごとに旧版を上書きしない。組込みの検索優先規則変更もSKILLの新revisionとpackageの新revisionで行い、既存版のhashを変えない。現在のseedはSKILL.mdをskill:web.research@1として読み込むので、そのファイルは変更しない。SKILL.v2.mdを追加しskill:web.research@2を新登録する。既存package @2の定義を残し、web.research/web.lookupのpackage @3だけを追加して新SKILLを参照する。明示URL用web.read @2とprofile @1はそのまま。新しい学習packageは共通skill @2を参照する。今後の必須SKILL/検証条件更新はhost validationPolicyVersionも上げ、旧経路をそのpolicyで再検索・検証する。

学習SKILL/packageの両方に `discoveryMode=route-only` を必須にする。固定author/reviewer定義も一般能力候補には出さない。既存の組込みは省略時catalogのまま。route-onlyは登録時にFTS索引へ入れず、alias/一覧のSQLではLIMIT前に除外する。LIMIT後のfilterだけでは大量の学習定義により組込み候補が押し出されるため禁止する。一般検索と通常一覧からroute-onlyを除外し、一致した経路IDからの直接prepareだけで使う。そうしないと、5000地点のSKILLが一般の「天気」の候補を埋め、別地点の手順が選ばれる。定義の互換性を保ち、既存revisionのJSONへ後付けでフィールドを書き込まない。

SystemContextの正本は経路版の `context_projection`。投影は検証済みSearchSpec/recipe/policyからホストの固定rendererが生成し、authorの自由文からは生成しない。独立した編集可能なサイト一覧を別の設定へ二重保存しない。同じ有効版から実行recipe、SKILL参照、モデル向けの短い指示を生成する。基本SystemContextには「今回のSearchSpecで登録を照合し、activeなら優先確認、なければ検索」という固定規則だけを置く。実行時に展開するのは一致した1経路と必要なSKILLであり、全地点・全銘柄を列挙しない。

例として鎌倉の該当Contextは「このキーワードと地点に一致した登録サイトを優先し、値と対象日は毎回取得する。取得不可または検査不合格なら再検索する。現在のSKILL版を使う」という内容を持つ。URLはホストが束縛した値だけを渡す。

## 10 回答後の作成処理と編集

会話の回答採用commit前に学習候補を公開しない。dialogueは通常のticket・memory・inference receipt検査、回答保存とcompleted遷移の後、同じwriter内のSAVEPOINTで任意のPostAnswerObserverPortを呼ぶ。applicationは確定済みticketから内部proofを公開操作で取り出し、research-routesの `recordAdoptedProofAndEnqueueInTransaction` へ接続する。observed→adoptedの更新、draft作成、author job受付は全て保存または全てなし。queue_full、容量超過、学習側例外ではSAVEPOINTだけrollbackし、recorded/skipped_capacity/skipped_errorを返す。必須の回答検査失敗はこの例外処理で隠さない。通知はcommit後だけに行う。学習の失敗ログはcodeのみで本文を出さない。

新規取得を起点とする後のactive化ではSourceAdoptionPortで元runの採用・取消・削除・ticket/report epochを確認し、経路のepoch/incarnation/generationを再検査する。元runの終了後は元の推論deadlineを学習へ流用しない。既存 `validAnswerInTransaction` はready_for_answer限定なので、終了後の照合には再利用しない。agent-runtimeにhost専用 `getAdoptedEvidenceInTransaction` / `validateAdoptedEvidenceInTransaction` を追加し、completedのroot、consumedのevent（ticketIdは既存eventId）、root/child data epoch、保存済みreport digest、削除/取消を確認する。完了時のrevision増加を失効と誤判定しない。内部の学習証拠だけを返し、会話の回答や一般公開report DTOは変えない。dialogueのcompleted/message採用状態も同domainの公開検査で確認する。

正常なwarmのobserverは `recordRouteUseInTransaction` で利用時刻を更新するだけ。新規proof/draft・author/review・能力版更新を起こさない。初回、失効後の再探索、明示の説明編集だけが登録を開始する。同じ非終端draftへまとめる場合、新しいrunのproofを既存draftへ差し替えず、最初に束縛した証拠を維持する。

author/reviewはresearch-routes所有のbackground Queue handler、`inference.llm` 共用で1step1job。各jobはdraft IDとstepだけをpayloadに持ち、prepareで草案の現在状態を読み、commit後に推論する。モデル出力をreceiptの採用なしで保存しない。settleではreceiptと設定権限、origin別の登録証明、epoch/incarnation/generationを再検査する。adoptionはSourceAdoptionPort、editは有効なbase版とその登録証明を確認する。失敗時は草案だけ終端にし、回答や既存の健全なactive版を取り消さない。

safe projectionの採用時にもbindingを確認する。direct/candidateはcached権限のepoch/incarnation/generation・版健康状態を再検査し、clear/disable後の結果を採用しない。実lookupで許可された通常取得は、clearで学習fenceが古くなっても通常のowner/receipt/policy検査を満たせば回答でき、学習だけをskipする。学習fenceとcached取得の権限を同じ取消理由にしない。

同URLの失敗版について、faultより前に取得された古いproofを新版の登録へ使わない。別URLまたはfault後の新規取得で対象/日時を検証したproofだけが再登録可能。同じrunの失敗URLを選び直さない規則は維持する。

### jobと草案の終端

初回author-1→review-1。author-1の契約不正またはreview-1のrejectedに対し、草案全体で修正は1回だけ（author-2と必要なreview-2）。最大4推論、各job maxAttempts=1/recovery=interrupt、draft deadlineは受付から120秒でQueue待機も含む。再起動で新しく生成し直さない。

authorのsettleはreceipt採用と草案保存・次review jobの受付を同じwriterで行う。次job受付がqueue_fullなら草案をrejectedに終端化し、受付済み回答と既存active版を保持する。reviewのapprovedは同じsettle内でreceipt確認、capabilities登録、active CAS、draft activatedまで完了する。approvedという宙ぶらりんのstateは保存しない。CAS失敗はsuperseded、取消/再起動/期限はinterrupted、契約不正や修正上限到達はrejected。required mutationの戻り値を確認し、false/nullを成功としてjob完了しない。非成功時もdraftとjobを両方終端にする。

### 回答終了後の推論契約

既存 `captureControlInTransaction` はpendingな親推論とそのdeadlineを必須にしており、回答採用後には使えない。inferenceにhost専用 `captureMaintenanceControlInTransaction(db, {subject, deadline, maxOutputTokens})` を追加する。現在のsettings snapshotから新しいllm requestを作り、larm-only/cloudAllowed=false、mode=control、context_policy=exact、上限2048 tokensを固定する。subjectは `research-route:<draftId>:<step>` とし、research-routesがprepare前に草案の操作権限を確認する。元runをpendingへ変更せず、既存allowed/valid/receiptの検査を緩めない。各jobのdeadlineはprepare時点から最大30秒かつ草案全体120秒以内。executeControlと既存receipt採用の公開操作を使う。新契約が未接続なら明示のmaintenance_unavailableで草案を終端にし、成功扱いしない。

### 推論枠と待機の限界

Queueのinteractive優先は次のclaim時の順序であり、実行中background jobの先取り停止はしない。新しい会話は既に動くauthor/reviewの残り最大30秒程度とQueue待機の影響を受けうる。1stepごとに枠を返し、author→reviewの間ではinteractiveを先にclaimする。初版でQueue全体の先取り規則や推論枠数を変更しない。warmの2モデル呼出しは待機時間ゼロを意味しない。登録負荷が速度目標を妨げる場合は測定で明示し、バックグラウンド動作を含む達成条件を未達として記録する。

同じキーで同時に成功した受付は非終端draftを重複作成せず、既存draft IDへまとめる。編集と自動学習が競合した受付は409またはskipped_conflictにする。草案は、受付時のbase version IDとepoch/incarnation/generationに対してCASで採用する。先に新版が有効になった場合は遅い草案をsupersededとし、巻き戻さない。初回の草案作成中はまだ高速経路は使えない。健全なactive版の説明編集・更新中は既存active版を使う。その間の検索は有効な候補cacheを使えるが、検証済みactive経路の成功と混同しない。

手動編集も `編集要求 → author → context-review → host検査 → 新版有効化` を通す。保存ボタンでactive本文を直接書き換えない。初版の手動編集は既存SearchSpec/recipeを保った説明の編集に限定する。URL・tool・引数・対象・必要項目・時点policyの変更要求はrecipe_change_requires_rediscoveryで拒否し、次回検索へ戻す操作を案内する。URL変更のための独立した手動取得jobは初版に含めない。取得不能時の自動更新は通常の再検索・新規取得proof・author/reviewで行う。新しいキーワード・地点は新依頼として初回検索から始める。構造変更の判定がauthor出力で確定した場合は受付後のdraftをrejectedとし、202を返した操作のHTTP結果を後から400に変更しない。編集草案のoriginはeditとし、base版の登録証明digestから同じrecipeを継承する。登録証明はspec/recipe/policyのdigest、検証日時、proof/review digestだけを不変版に保存し、引用や過去値を含めない。元会話の保持期限後も有効な版の説明は編集できるが、取得成功日時・絶対再検索期限は延長しない。base版が期限切れ、停止、disqualified、他版へ更新済みなら409で拒否する。adoption由来の未採用草案については、元会話の削除・取消を引き続き拒否する。必要項目の削減や取得時点の条件緩和を、単なる文面編集として通さない。

動的SKILL内のproseは取得方法のガイダンスであり、権限やルーティングの正本ではない。recipe、SearchSpec、host検査条件が正本で、構造化出力が異なるURLや対象を指せば登録拒否する。自由文の矛盾はreviewerが検査するが、その検出を完全な安全境界とは扱わない。固定されたrecipeからhostが指示に必要なURL・toolを追記する。これにより「文章の編集だけで他のサイトへ自動実行先が変わる」ことを防ぐ。

## 11 アクセス不可と再検索

warmの直接取得は初期timeout5秒、HTTP試行1回（1サイト。専用APIとの対応は固定mapping内）。ネットワーク・guard・parserの各時間を含むattempt deadlineと、子の90秒/結果の採用期限を分ける。5秒で取得した結果を5秒後に失効させない。既存ToolAdapterとweb-researchのhostOptionsに `attemptTimeoutMs` を追加し、web-research所有の末尾migrationでrunへ保存する。制限は1〜15,000ms、warmだけ5,000ms。5秒は実際のWeb jobのexecute開始から数え、Queue待機をサイトの通信故障にしない。Queueの全体deadlineは別に維持し、invocationのadoption deadlineは子の期限を維持する。共有取得では利用者ごとの待機期限を持ち、timeoutした利用者だけ離脱させる。最後の利用者が離脱した場合にだけ共有取得をabortする。消費者の取得期限はweb_attempt_timeout、Queue/root全体の期限はweb_deadline_exceeded、利用者取消はweb_cancelledとして分ける。共有controllerのabortを消費者の取消理由へ上書きしない。attemptのtimerはguard/parse完了時に止め、writerで結果を保存する待機は全体期限で管理する。

| 原因 | 今回の動作と登録状態 |
| --- | --- |
| web_attempt_timeout、通信エラー、5xx | このrunは再検索へ。旧版を利用不能にし5分suspended。成功した代替経路があれば新版に切替 |
| 404/410、対象違い、必須値欠落、形式変更、要求時点を満たさない値 | 旧経路をsuspendedにし、再検索。検査成功した新経路だけを有効化 |
| 429 | Retry-Afterを尊重し、そのhostを同runで繰り返さない。別の取得先発見は通常の予算内 |
| guard deny/require_approval、通信安全検査の拒否 | 自動の別経路探索による迂回はしない。失敗として返す |
| Queue/root全体期限、能力停止、owner不一致、取消、削除、権限失効 | 再検索で権限を補わず終了 |
| 子のJSON不正・引用偽装 | 既存の修正上限で対処。これだけを根拠にサイトを故障扱いしない |

アクセス不可で再検索する時は検索候補cacheもbypassし、実lookupを行う。同じ失敗URLを選び直さない。同runの成功経路再探索は最大1回。既存のroot180秒、子90秒、worker8推論/5tool、lookup2/read3/forecast1/quote1を累積で維持し、移行時にカウンターをリセットしない。再検索も失敗したら、既存の固定失敗通知または根拠付きpartialで終了する。

### 失効と実行planの差替え

失敗版はrevision_healthでdisqualifiedにし、retry_afterは再探索の連続開始を抑えるためだけに使う。5分経過しただけで旧版をactiveへ戻さない。suspendedで次の依頼が来た場合は直接取得をせず、通常の検索・取得を行う。retry_after内は新たな登録jobの重複受付を抑え、成功済みの代替proofを持つ非終端draftがある場合はその完了を優先する。安全拒否はそのrunを終了するが、通信故障と混同して経路を自動差替えしない。

現在のrunは旧cached grantをreleaseし、agent-runtimeの公開 `replaceAcquisitionPlanInTransaction` で通常の検索packageと新しい実行参照へ切り替える。旧prepared packageを検査し続けたまま再探索しない。元のowner、取消epoch、deadline、step番号と累積予算は保持し、古いresultRefを新planへ持ち込まない。切替transactionのrollbackでは旧grantのメモリー状態を先に変更しない。遅れて完了した旧版の結果は拒否する。

代替Bの登録証拠はBに対応するlookup/readと完全なfactsだけを使う。先行Aの取得失敗があったという理由だけで、完全に解決したBのproofをpartialと判定しない。B自体の不足や相反する値が未解消なら登録不可。

旧経路の失効と新経路の有効化は別の確定状態である。新候補の登録に失敗しても、失効した旧経路をactiveへ戻さない。検索で候補が見つかっただけでURLを差し替えない。新経路のauthor/reviewは今回の回答後に行い、current runは今回の新資料で回答できる。

起動時に非終端のauthor/review jobをinterruptedとして処理し、外部取得や生成を自動再実行しない。Queue復旧・経路草案のinterrupted化を完了し、applicationのportを接続してからrunner/agentを開始する。中途半端な登録中stateで新規実行を受け付けない。active版は再起動後も使えるが、executionRef等は発行し直す。停止・rediscoverはgeneration、全clearはglobal epochを増やす。キー削除後の再作成では新しいincarnationを発行し、元runの取消・削除はSourceAdoptionPortで拒否する。完了が遅れた学習jobで復元されないことを確認する。

## 12 APIと画面

既存の認証とOrigin検査を通す。WebとCLIはAPIだけを使う。

| API | 用途 |
| --- | --- |
| `GET /api/research-routes?cursor=&limit=` | キーワード、対象、状態、取得先、成功日時、版の一覧。最大50件 |
| `GET /api/research-routes/:key` | 有効版、SKILL、SystemContextの該当投影、草案の状態・draft ID/errorCode |
| `POST /api/research-routes/:key/edits` | instruction最大2,000文字＋expectedStateTokenで編集草案を受付。202とdraft ID |
| `POST /api/research-routes/:key/disable` | expectedStateTokenで新規利用と未採用草案を停止。200と更新DTO |
| `POST /api/research-routes/:key/rediscover` | expectedStateTokenで次回を初回検索経路に戻す。200と更新DTO。ここでは外部取得しない |
| `POST /api/research-routes/clear` | expectedEpochでglobal epochを増やし即時に旧行を不可視・旧grantを失効。200と新epoch/論理削除件数。物理回収は分割job |

編集APIのstrict schemaは `{requestId, instruction, expectedStateToken}`、disable/rediscoverは `{requestId, expectedStateToken}`、clearは `{requestId, expectedEpoch}`。requestIdはUUID、stateTokenはhostが `(epoch,incarnation,generation,control_version,activeVersionId)` から作った64桁hex。表示版の数字だけでは削除→再作成を判別できないため、controllerはこれを比較する。warmの利用時刻更新はcontrol_versionを変えない。instructionは説明変更の要求としてのみ扱い、事前に判断できる構造変更要求は400、author出力で判明した構造変更は202で受け付けたdraftのrejected状態で返す。変更可能なのは既存recipeの説明だけで、authorが返す構造化recipeの一致を強制する。新URLを採用する操作はこのAPIにはなく、説明文に書いても実行先は変更されない。現在のactive内容を編集APIが直接上書きしない。`rediscover` は次回依頼の検索を要求する操作であり、クリックだけで無関係な外部通信を開始しない。

一覧DTOは `{items, nextCursor, epoch}`。keyは64文字のhex、cursorは最大256bytesのbase64url JSON `{lastKey, epoch, scope}`、順序はkey ASC、limitは1〜50。scopeは認証から固定し、cursorから上書きしない。clear前のcursorは409 stale_cursor。POSTはstrict schemaとrequestIdによる重複防止を使い、不正入力400、期待版の不一致409、未知キー404、GETは現存キーならexpired状態でも200を返し、利用不可のSKILL/Context本文はnull。回収済みは404を返す。新しい管理APIには410を割り当てない。編集できるactive版がなければ409 route_not_editable。一覧・詳細・操作を同じowner scopeで絞り、cursorのscope/epochを検査する。認証前の400/404の詳細も返さない。操作台帳は24時間保持し、clearでも削除しない。同じclear requestIdの再送は保存済み結果を返し、その後の新しい経路を消さない。重複判定はscope/requestIdとmethod/path/body digestで行う。操作台帳は最大1,024行/2MiB（総量内）を予約し、受付余地がなければ429 control_busyで変更前に拒否する。認証前に登録内容の存在を漏らさない。一覧のsummary DTOにはkey/keywords/target/state/stateToken/activeVersionId/sourceUrl/lastSuccessAt/draftStatusを定義し、SKILL/Context本文を50件分返さない。詳細DTOはこれにskillRevision/contextProjectionを追加する。draftStatusは `{id,state,errorCode}` またはnull。内部proof/receipt・Provider応答を返さない。

設定に「取得先と手順」を追加する。既存ServiceTestsPanelと同様に、web/src/App.tsxがresearch-routesのpanelをimportし、SettingsPageの新しいrenderResearchRoutes slotへ渡す。settings domainからresearch-routesを直接importしない（research-routes→inference→settingsと循環するため）。一覧・編集の状態とqueryはresearch-routesのWeb domainが所有し、Settingsの保存JSONへ経路を混ぜない。画面のdirty/disabled通知はslot契約で接続し、Appが設定と経路編集のdirtyを別々に保持してORで離脱判定する。一方の保存が他方の未保存状態を消さない。

検索キーワード、対象、登録サイト、利用可否、最終成功日時、編集中/確認中/登録失敗を表示し、SKILLとSystemContextの該当内容を開ける。編集、停止、次回検索、全削除を提供する。調査cardには「検索して確認」「登録サイトを確認」「取得先を探し直す」を永続task/route状態から表示する。SSEは再取得の合図に限定し、定期ポーリングを増やさない。queryRoots/changeRootsへresearchRoutesを追加し、commit後の台帳変化で一覧/詳細をinvalidateする。調査cardの取得modeはagent-runtimeの汎用progress契約に持たせ、cardから経路SQLや別domainの内部を参照しない。検索候補、ページ本文、モデルの作業用JSONを主画面に出さない。

CLIは `research-routes list/show/edit/disable/rediscover/clear`。editはファイルから指示を受け取れる形にして、shellへの本文埋込みを避ける。

## 13 実装工程

| 工程 | 実装と完了条件 |
| --- | --- |
| P0 baseline | 未コミット差分確認、既存関連gate、同じ依頼のcold所要時間採取。鎌倉/静岡市/AAPLの公開サイトを実lookupし、取得・guard・対象/日時検査の実現性を記録。未対応サイトを対応済みにしない |
| P1 キーワードと台帳 | SearchSpec/正規化、完全一致、TTL、DB/migration、候補と経路・草案・proofの公開操作、CAS、容量/期限の純粋fixture。5000キーで全展開しないことを確認 |
| P2 登録契約 | 動的SKILL/packageの新しい版ID登録、hostのURL/recipe/固定SKILL検査、SystemContext投影、facts検査、直接prepareとgrant。旧版hash保存のupgrade fixture |
| P3 coldとwarm | agent.route-step、初回lookupのホスト強制、登録済み1サイト取得、facts/report採用、共通の取消/予算/step/idempotency。coldとwarmのAPI fixtureを通す |
| P4 学習と更新 | 任意学習SAVEPOINTとmaintenance control、経路domainのauthor/review、純粋な登録検査、atomic有効化、説明編集、Queue飽和・同時草案・再起動・削除のfixture |
| P5 再検索 | 5秒の直接取得attempt、非guard故障時の再検索、候補cache bypass、別URL取得、新版への切替。旧run/旧草案が復元しないfixture |
| P6 UIとCLI | 認証API、client、設定一覧/編集/状態、調査card、SSE、CLI、browser入力→cold→active→warm→サイト変更のE2E |
| P7 gateとlive | 各domain→全体gate、隔離backendでcold/warm/new-keyと実取得検査、前後計測、docs更新。コード変更後にgateをやり直す |

実装担当はチェックリストのT00〜T25を依存順に実装する。1作業で扱う公開契約を絞り、fixtureを通してから次へ進む。P0〜P7は進捗集約の単位であり、1回の巨大な編集の単位にしない。実現できない取得元やモデルレビューがある場合は原因・到達範囲を記録し、型/検証条件を緩めて合格値を作らない。P0で鎌倉/静岡市の実資料が読めない場合は取得層/有限recognizerを先に解決する。fixtureでlive対応を代用しない。初版を完了するために汎用MCP、任意コード実行、embedding検索や別DB基盤を増やさない。

## 14 回帰試験と受入条件

### 試験の分離と差替え口

| 層・所有者 | 試験方法 |
| --- | --- |
| research-routesの純粋関数 | SearchSpec/対象日束縛、facts recognizer、構造化登録検査、host投影rendererを入出力で確認。clock/IDを注入。モデル・HTTP・DBなし |
| research-routes/capabilitiesのrepositoryと登録service | 一時SQLiteで本物のmigration/SQL/制約/transactionを使用。公開操作を呼んでrollback/CAS/GC/再作成を確認。SQL実装を写したmockを使わない |
| inference | fake LARMとsettings fixtureで終了済み親、fresh snapshot、control制限、receiptの採用/失効を確認。実通信なし |
| agent-runtime/tool-runtime/web-research/queue | fake port/取得/モデル＋注入timerでhost step、所有者、代替plan、待機とtimeout、共有利用者の離脱を確認。5秒/120秒の実sleepはしない |
| application・dialogue | 全domainの公開操作を結合した一時DB＋fake HTTP/LARM。認証API入力→回答採用→任意学習→active→warm、Queue飽和時の回答保持を通す |
| Web/CLI・browser | clientを差替えた表示/操作試験と、隔離backendへのAPI E2E。画面/CLIからDBを開かない。SSE後の再取得、stateToken競合409、設定と経路のdirty独立を確認 |
| live | 実LARM/実Webの別gate。fixtureと結果を混ぜず、サイト側の表記変更・モデル揺れを記録 |

Queue/取得/生成の完了はテスト用barrierで順番を制御し、late完了、clear、取消、他rootの継続を決定的に再現する。probeの件数や採用された値、公開状態、ネットワーク先を検査し、private関数の呼出順や文面一致だけを合否にしない。テストからproduct DBや認証情報を参照しない。

最低限、以下のobservable条件を試験する。文面一致だけのテストでは代用しない。

| 条件 | 期待する結果 |
| --- | --- |
| 初回 `天気予報 鎌倉` | 実lookup相当のfixtureを1回以上実行。検索語と照合用keywordsが一致。専用取得だけで検索済みにならない |
| 登録完了後の同じキーワード | lookup0、取得先1サイト/1tool。子要約＋メイン回答2モデル呼出し。値を26→27に変更すると27を回答。author/review0、新版作成0 |
| facts=27、モデルsummary/claims=26や命令文 | hostが27の投影を生成し、26や自由文を親へ送らない。元資料が27なら経路の故障扱いもしない |
| 新規台帳が容量不足 | 通常検索/検査/回答を継続し、学習だけskip。架空fenceや未確認activeを作らない |
| cached取得と通常lookup取得の最中にclear | cached権限での結果は採用不可。通常lookupの回答は権限が有効なら保持し、学習だけskip |
| 期限切れ版と有効候補が同時に存在 | 実lookupを省略せず現在policyで再検査 |
| clearの再送と削除後再作成 | 同じrequestIdはepochを再び増やさない。古いstateTokenは新キーへ操作できない |
| 次reviewのQueue受付失敗/approvedのCAS失敗 | draft/jobが終端。回答保持、部分登録0、approved中間state0 |
| 登録前に同じキーワードを再依頼 | preparingをactive扱いしない。候補cacheと成功経路を区別 |
| 鎌倉登録後に静岡市を依頼 | キャッシュmiss、初回lookup。鎌倉URLへの通信0 |
| 静岡という曖昧な対象、市/県の粒度差 | 不確実なキーで登録しない。鎌倉・神奈川県全体の経路を流用しない |
| 明日・絶対日付・時間帯・必要項目の差 | 新依頼ごとに日付を解決。同runで日付を跨いでも束縛は不変。異なる条件を一致させない |
| AAPLの別銘柄/市場/通貨/価格種別 | 別キー。過去の価格・別銘柄の値を採用しない |
| 検索候補はあるが読取り不可/部分取得 | active経路を作らない |
| 取得URL Aが404、検索でBを発見 | Aの結果は不採用。Bを取得・検証し、回答後のreviewを通して新版Bへ。次回はBのみ |
| Aがtimeout、Bも失敗 | 予算内で終了。無限検索・古い値の回答・未検証URLへの切替がない |
| guard拒否/能力停止/取消 | 自動迂回せず終了。検索による権限回復をしない |
| ページ・検索snippet・編集草案に命令sentinel | SystemContext/SKILLへ命令を昇格しない。親への本文・引用・titleの漏れ0。sentinelを含む要約は拒否し固定失敗文へ。構造化factsとhost投影に命令を混入させない |
| 有効候補cacheだけがある再依頼 | fresh ownerのimport観測からread可。実lookup偽装0。他キー/失効/clear済み候補の許可0 |
| reviewer approvedだがrecipeに不正URL/固定SKILL欠落 | hostが拒否。active pointer不変 |
| 改善済み草案に古いreview digestを添付 | 新draftへの流用不可。digest不一致で拒否 |
| 取消rollback後に別rootを取消 | 前回修正した取消の巻き添えが再発しない |
| 登録transactionの途中rollback | capabilities・route・Contextの部分有効化がない |
| キー削除後に同じキーを再登録 | 能力IDが旧版と衝突せず、新版の証拠とContextだけを使用 |
| 同じキーの草案競合/clear/停止とlate完了 | CAS/epoch/incarnation/generationで古い更新を拒否。同じキーを削除・再作成しても旧jobからの復元0 |
| 元回答completed後の証拠検査/保持期限後の説明編集 | pending/ready_for_answer検査を再利用しない。説明編集で取得成功日時や再検索期限を延長しない |
| 元回答の推論がaccepted後のauthor/review | maintenance controlでfresh設定を使用。元のcaptureControlのpending制約を変更しない |
| queue_full/学習容量超過/受付例外 | 回答とticketは正常採用。proof/jobの片方だけ残らず、学習部分だけskippedになる |
| author実行中にinteractive受付 | 先取りを仮定せず待機を記録。author終了後はreviewよりinteractiveを先にclaim |
| 健全な版Aの取得中に版Bを登録 | Aの有効な結果は採用可。停止・clear・Aのdisqualified化なら拒否 |
| 検索失敗A→完全取得B | grant/plan差替え後のBだけを採用・学習。予算リセット0、旧ref利用0 |
| warm jobがQueueで5秒以上待機/取得後writer待機 | 通信開始前・完了後にサイト故障としない。全体期限切れ/取消/attemptは別code |
| disabledキーの14日/30日後の再依頼 | GCで停止設定を消さず、通常回答のみ。明示rediscover/clearまで登録復活0 |
| 保持対象のGCと5000キー更新 | capabilitiesの学習定義も回収。実行中の依存閉包と組込み定義は保持 |
| 復旧後のactive経路と未完了草案 | activeだけ再利用可。未完了はinterrupted、旧executionRefは再利用不可 |
| 取得5秒のdeadline、要約はその後に終了 | 取得成功の資料がattempt期限だけで失効しない。子の採用期限は継続 |
| 5000キー | exact照合、容量/TTL、今回のContextに1経路だけ。全文展開0 |
| 学習packageの一般検索 | 5,000学習定義があっても組込み候補を取得可。route-onlyはFTS/aliasの候補に出ない。静岡のcold検索で鎌倉SKILLが選ばれない |
| 経路停止後の通常検索 | 回答は通常の権限で可能。学習とactiveの自動復元は不可 |
| Settingsのpanel接続と単独domain gate | research-routes UIをsettingsからimportせず、Appのslot経由。settings保存JSONへ経路データを混ぜない |
| UI表示後の削除/版更新/編集失敗 | 永続状態と一致。削除済みcacheを表示し続けない |

通常のモデルによる主張の意味が全面的に正しいことは、これらだけでは証明できない。引用・対象・日時の検査に加えて、liveの回答を人が確認する。fixture、live、実機器音声受入の結果を分ける。

## 15 計測と実行コマンド

計測はlookup/read、Queue待機、coordinator route/select、子のinvoke/summary、メイン回答、author/reviewを分ける。Queue既存のattempt時刻を使い、必要なphase記録を末尾migrationで追加する。runId/jobId/stepId/routeKeyのdigest、status、error code、bytes、msだけを運用ログへ出す。keywords、SKILL本文、ページ本文、Provider生応答、credential、設定はログに出さない。

同じモデル・キーワード・取得元・出力条件でcoldとwarmを比較する。warm正常系の機能条件はlookup0、1サイト、2モデル呼出し。最初の速度目標は同条件baselineの半分以下、直接取得attemptは5秒以内。全体10秒以下は目標として計測するが、モデル待機・生成時間を含むため未計測で達成を宣言しない。最低5 cold/warm組を記録し、少数試験からp95の達成を主張しない。author/reviewのバックグラウンド負荷と、1推論枠で新しい会話が進むことも測る。計測対象の2呼出しはEumenesの子要約とメイン生成であり、取得guard等の内部処理や再試行は別集計する。background実行中とidleの両方でwarm待機を測り、初回回答だけを速く見せるために学習負荷を省かない。

baselineで対象地点に対応していない場合はunsupportedとして記録し、遅延0秒として扱わない。登録時に取得元が変わった比較はsourceChangedと明示し、モデル工程省略だけによる短縮とは主張しない。現在の東京・AAPLと、今回の鎌倉・静岡市の所要時間を直接の前後比較にしない。

着手前baselineは既存のcapabilities、tool-runtime、agent-runtime、web-research、dialogue。実装後は新research-routes、利用側capabilities/tool-runtime/agent-runtime/web-research/queue/inference/larm/dialogue/voice-dialogue/settingsのgateを順次実行し、最後に全体gateを実行する。verify lockのため並列に実行しない。

```sh
bun run verify -- --domain research-routes
bun run verify -- --domain capabilities
bun run verify -- --domain tool-runtime
bun run verify -- --domain agent-runtime
bun run verify -- --domain web-research
bun run verify -- --domain queue
bun run verify -- --domain inference
bun run verify -- --domain larm
bun run verify -- --domain dialogue
bun run verify -- --domain voice-dialogue
bun run verify -- --domain settings
bun run verify:all
EUMENES_LIVE_RESEARCH_ROUTES=1 bun run verify:live -- --domain research-routes
```

live runnerは既存と同様に一時DBの隔離backendを起動し、認証付きAPIから入力する。通常DB・設定をコピーしない。鎌倉cold→登録完了→同じ依頼warm、静岡市cold→warm、AAPL cold→warmを実LARM＋実Webで確認する。草案完了待ちは測定上のwarm準備として分け、初回回答の所要時間へ混ぜない。別地点のmissと、warmのlookup0/1サイト、対象・値・日付の一致を確認する。実サイトの消失を人工的に起こせないため、404/timeout/サイト変更は故障注入fixture E2Eで検査し、実取得成功と記録しない。

結果は `spec/verification/research-routes/README.md`、生出力はGit対象外の `verification-reports/research-routes/` に記録する。全工程・実取得の範囲・残る対象を明記する。完了後に本計画と実装チェックリストを `spec/.archived/` へ移し、参照リンクを修正する。実機器3往復未実施なら音声MVPの完成を宣言しない。

### migrationと変更の所有者

末尾migrationはresearch-routesの台帳/epoch/health/操作重複防止、capabilitiesのcapability_itemsへのroute-only属性と学習由来識別、agent-runtimeのhost action、agent_tasksのacquisition_plan_json/acquisition_binding_json、agent_reportsのsafe projection/binding列、web-researchのattempt timeoutを各所有domainが公開する。applicationは並びの結合だけを行う。inferenceのmaintenance controlが既存request列を使える場合は不要なschema変更を増やさない。旧DB upgrade fixtureでは適用済みchecksum・既存revision hash・通常検索・通常回答が不変であることを確認する。列追加対象へのINSERTは明示column listへ変更する。特に既存agent_reportsの4値INSERTを放置せず、旧経路（追加列null）もupgrade後に試験する。

各gateは終了code=0と全工程成功、API fixtureは表の観測条件一致が合格。liveは鎌倉/静岡市/AAPLのcold/warm全組で対象・値・日時の一致、cold実lookup、warm lookup0/1サイト/2モデル、warm登録job0が機能合格。速度目標は機能合格と別に達成/未達を記録する。失敗は原因を修正して該当gateを再実行し、コード変更後の全体gateもやり直す。同じlive失敗の盲目的な再試行はせず、原因修正後に1回再実行し、未解決なら残る対象を明示する。

## 16 引継ぎ時の確認

実装担当は、検索語と照合キーが同じSearchSpecから作られること、初回検索を本当に実行すること、別地点/銘柄の成功経路を流用しないこと、同じ地点のwarmでは1サイトの最新値を取得すること、故障時に再検索して検証済み新版へ切り替わることを確認する。

登録時だけauthor/reviewを行い、手動編集も同じ検査を通す。SystemContext・SKILL・recipeの参照版が揃い、1000以上の登録を全件プロンプトへ展開しないことを確認する。子からメインへの要約境界、取消・削除・権限・保持期限の検査を維持する。

本書は未実装の計画であり、API名・テーブル・handler・速度目標は今回追加する契約である。既存のテスト件数を今回の成功値へ転記しない。
