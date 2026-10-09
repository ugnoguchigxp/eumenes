# 取得先学習・動的SKILL 実装チェックリスト

2026-10-09。実装前。Sonnetを含む実装エージェントが、設計を作り直さず小さな単位で実装するための手順書。[設計の正本](research-route-learning-implementation-plan-2026-10-09.md)と[レビュー記録](verification/research-routes/plan-review-2026-10-09.md)を先に読む。

## 実装状況(2026-10-09 更新)

T00〜T24はfixture・単体・結合・browser(fixture)で実装し検証済み。T00の静岡市は実サイトの市単位資料が見つからず**未対応**(`verification/research-routes/source-feasibility.md`)。T25は実行スクリプトと文書を追加したが**live gate未実施**(実LARM/実Webで鎌倉・静岡市・AAPLを確認していない)。そのため本書・正本はarchiveせず、音声MVP・city対応完了は宣言しない。全体gate(`verify:all`)は別作業のworld/timers/queue未完了差分で停止しており、本機能のdomain gateは個別に通過(`spec/verification/research-routes/README.md`)。

## 作業の進め方

T00〜T25を以下の依存順に進める。各作業は「変更→所有するfixture→domain gate→完了チェック」の単位。gate失敗のまま後続へ進まない。新domainのgateはT01で登録してから使う。別domainの既存非関連失敗はbaselineと比較し、勝手に周辺改修しない。

1作業の変更は原則1つの公開契約または1つの状態遷移に限定する。testで使うfixture/helperは同時に追加する。既存ファイルを丸ごと置換せず、新しいportはoptionalにして既存呼出しの互換性を維持する。未接続時は通常経路または明示的な失敗とし、機能成功を偽装しない。

各作業が終わったら、この表のチェックと検証記録を更新する。コードのcommit/pushは、その時点のユーザー指示に従う。本書だけで他チャットへの連絡やproduct DBの読取りを許可しない。

| 作業 | 主に所有するdomain | 先行作業 | 完了 |
| --- | --- | --- | --- |
| T00 baseline・実資料確認 | application/検証 | なし | [x] |
| T01 domain入口・入力契約 | research-routes | T00 | [x] |
| T02 キーワード・日時束縛 | research-routes | T01 | [x] |
| T03 台帳migration・repository | research-routes | T01 | [x] |
| T04 照合・状態・失効判定 | research-routes | T02,T03 | [x] |
| T05 型付きfactsと根拠検査 | research-routes | T00,T02 | [x] |
| T06 親向け安全な投影 | research-routes | T05 | [x] |
| T07 不変学習定義・索引除外 | capabilities | T01 | [x] |
| T08 ID指定prepare・能力GC | capabilities | T07 | [x] |
| T09 maintenance control | inference | T01 | [x] |
| T10 草案と登録transaction | research-routes | T03,T05,T07,T08 | [x] |
| T11 author handler | research-routes | T09,T10 | [x] |
| T12 review・修正・終端 | research-routes | T11 | [x] |
| T13 汎用plan/bindingとadopted証拠 | agent-runtime | T04,T06,T08 | [x] |
| T14 route/candidate許可 | tool-runtime | T04,T08,T13 | [x] |
| T15 host stepとcold検索 | agent-runtime | T13,T14 | [x] |
| T16 warm取得と子要約 | agent-runtime | T15 | [x] |
| T17 取得attempt timeout | web-research/tool-runtime | T14 | [x] |
| T18 失効・再検索・plan差替え | agent-runtime/research-routes | T16,T17 | [x] |
| T19 回答採用observerと結合 | dialogue/application | T12,T16,T18 | [x] |
| T20 管理操作・重複防止・API | research-routes | T10,T12,T19 | [x] |
| T21 GC・clear・再起動 | research-routes/application | T08,T18,T20 | [x] |
| T22 共通client・CLI | client/CLI | T20 | [x] |
| T23 設定panel・SSE・card | research-routes/agent-runtime/settingsのWeb | T22 | [x] |
| T24 fixture API/browser E2E | application/Web | T19,T21,T23 | [x] |
| T25 全gate・live・記録 | 横断検証 | T24 | [ ] |

## 凍結する契約

以下は追加予定の契約であり、既存APIが既に提供しているという意味ではない。repository以外から経路SQLを発行しない。型はcontractsからexportし、Zod strict schemaも同じmoduleで定義する。

### 検索キー

`SearchSpec` は共通の `{keyVersion:1, keywords, scope:"local:owner", language, region, timeZone}` と次のunion。ja/JP、en/USだけを許可する。

| purpose | 必須target | requiredFields | timeMode |
| --- | --- | --- | --- |
| weather | `{name, prefecture, granularity:"city"}`。初版の識別子表は鎌倉市/神奈川県、静岡市/静岡県 | condition必須＋任意maxTemp/minTemp。重複なし・辞書順 | today/tomorrow/absolute。absoluteだけabsoluteDate必須 |
| quote | `{ticker, market, currency, priceKind:"regular"}`。初版は確認済みAAPL/NASDAQ/USD | asOf/currency/market/price/priceKindの固定配列 | latestのみ |

初版のキー生成で受け付ける文法は全体一致。次の形を個別の有限ルールとして実装する。

- `天気予報 <地点> [今日/明日/ISO日付] [最高気温/最低気温/最高気温 最低気温]`
- `<地点>の天気[を教えて]`、`<地点> [今日/明日]の天気 [最高気温/最低気温]`
- `<地点> ISO日付 の天気`
- `株価 AAPL [NASDAQ] [USD]`、`AAPLの株価[を教えて]`

地点aliasは鎌倉→鎌倉市、鎌倉市→鎌倉市、静岡市→静岡市。静岡だけはambiguous、それ以外の未確認地点、引用、比較、複数対象、追加指示、realtime/historicalはunsupported。unsupportedで今回の学習を作らない。ticker文字を正規化の途中で削除しない。

weatherのkeywordsは「天気予報」＋地点表示名（鎌倉/静岡市）＋明日または絶対日付（todayは省略）＋要求気温名。quoteは「株価 AAPL NASDAQ USD regular」。元の異なる表現でもこの固定rendererを経由して同じqueryとキーを作る。入力の空白はNFKC/trim/連続空白統一。省略値はhash前に補完し、canonical JSONは全object keyを辞書順に並べ、配列の順序は保持する。意味が異なる検索語を後から同じhashへ寄せない。

`RequestBinding` は `{specDigest, requestAtMs, expectedDate:string|null, validationPolicyVersion:1}`。weatherはAsia/Tokyoの受付時の対象日、quoteはexpectedDate=null。今回のbindingは同runで変更不可。未知のpolicyを過去のpolicyとして扱わない。

### 保存・状態

`epoch` は全clear、`incarnation` はキーの作成、`generation` はdisable/rediscover、`versionId` は登録版、`controlVersion` は管理上の状態変化を識別する。warm成功日時だけの更新ではgeneration/controlVersionを増やさない。

keyは `(epoch,key)`、候補は `(epoch,key)`、経路版は `versionId` PRIMARY KEY＋UNIQUE(incarnation,revision)。版の参照には数字のrevisionだけを使わない。active pointerはversionIdで、同じepoch/key/incarnationの版であることを公開activate操作で確認する。

研究経路domain内のFKは、候補/版/proof/draft→key、health→version、adoption draft→proof、edit draft→base version。draftのproofはorigin=adoptionでだけ必須。key→active版の循環FKと他domainへのFKは作らない。削除順はdraft→proof→health→版→候補→key。保持対象を参照する行は先に消さない。

現在の組込みseedは `builtin/web-research.ts` が旧SKILL.mdを@1として読む。旧ファイル/旧定義は編集せず、SKILL.v2.md、skill:web.research@2、package:web.research@3/package:web.lookup@3を追加する。fallback/coldはpackage:web.research@3、新学習packageはprofile:web.research@1＋skill:web.research@2＋動的SKILL＋1tool。明示URL用package:web.read@2を変更しない。一般catalogの旧hashを守り、validationPolicyVersion=1の必須共通SKILLは@2へ固定する。

照合結果はresearch-routesのcontractで以下を定義し、applicationでruntime所有portの型へ変換する。

```ts
type RouteLookup =
  | { kind: "direct"; versionId: string; recipe: RouteRecipe; fence: RouteFence }
  | { kind: "candidate"; candidateDigest: string; fence: RouteFence }
  | { kind: "lookup"; reason: "new_key" | "no_candidate" | "expired" | "source_failure" | "rediscover" | "policy_changed" | "capacity"; fence: RouteFence | null }
  | { kind: "disabled" }
  | { kind: "unavailable"; code: string };
type RouteFence = {
  key: string; epoch: number; incarnation: string; generation: number;
};
```

lookupのfence=nullはcapacityだけ。新キーの作成に容量が必要で、台帳が満杯なら通常lookup/回答だけ進め、observed proof保存・学習をskipする。pure facts検査は台帳なしでも使える。

候補は現世代・完全一致・24時間以内だけ。expired/source_failure/policy_changedは候補があってもlookup。rediscoverはgenerationを変え、active pointerと旧候補を利用不可にする。disableでは通常回答だけ行い、候補保存も学習も行わない。disabledキーはidle GCで削除せず明示操作まで保持し、5,000キー上限に数える。失効版に戻す自動タイマーは設けない。

state導出の優先順はdisabled/suspended/expired/active/preparing/unregistered。draftの非終端はqueued/authoring/reviewingだけ、終端はactivated/rejected/interrupted/superseded。画面やQueueの別stateを経路stateへコピーしない。

### 検証と親への返却

resolveはroot/question/requestAtMsからの提案で、読取り許可ではない。child作成後にbind操作を呼び、runtimeがparent/root/cancel epochの一致を確認してから新ownerのpackage/grantを準備する。rootの実行参照はコピーしない。

agent-runtimeに追加する `AcquisitionPlanPort` の観測入力はowner/binding token、tool/引数digest、lookup provenance、今回visibleなsource、finishのopaque facts。sourcesは既存のsourceId/url/body/basis/fetchedAt/truncatedから必要分だけを渡す。weather/quoteのschemaとparserをruntimeへimportしない。

research-routesは独立して資料を解析し、子のfactsと比較する。内部facts最大4KiB、根拠最大400文字、snippet/truncatedは学習不可。検査結果はvalid/source_unusable/report_invalid/policy_unavailable。

validでは検証済みfactsからsummary/claims/limitationsを固定rendererで生成する。agentへcanonicalReportPatch（summary、claimsのtext/evidence、limitations）も返し、report_jsonに保存する。evidenceはfactsの検証済みsourceId/quoteで作り、元の不一致claimの引用を流用しない。claimsは既存の `{text, sourceIds}`、sourcesは既存のhost metadata、coverage/verificationも従来の形。数値・日付・対象・weather conditionラベルだけが投影に入る。未検査の自由文を移さない。safe projection JSON/digestとbindingはagent_reportsの末尾migrationで保存し、prepareAnswerではこちらを読む。元の引用は子の内部reportに留める。一般調査の既存parentProjectionは変更しない。

observed proofは初回/再探索の子のfinish/receipt採用と同時保存し、非公開。正常directのwarmではproofId=nullでreport/projectionだけを返す。回答採用でadoptedへ変更し、登録を許可する。warmは利用日時更新だけでproof/draft/登録jobは0。adoption由来の草案は元runのcompleted/consumed/report digest/data epochをactive化まで再検査。edit由来は健全なbase版の登録証明を再検査し、元会話の保持期限や元推論deadlineを引き継がない。

### 公開操作とhandler

以下のメソッドをresearch-routesのpublic indexからexportするserviceへ置く。Transactionメソッドは同期処理のみ。モデル・HTTPは必ずQueue executeで呼ぶ。

| 操作 | 入力と結果 |
| --- | --- |
| `lookupInTransaction` | db/spec/binding → RouteLookup。clock注入、current epochを検査 |
| `storeCandidatesInTransaction` | db/fence/spec/lookup provenance/hits → stored/skipped。最大5件/8KiB |
| `recordObservationInTransaction` | db/fence/binding/owner/取得とfinish → valid(proofId:string\|null,canonicalReportPatch,projection)/source_unusable/report_invalid/policy_unavailable |
| `recordAdoptedProofAndEnqueueInTransaction` | db/proofId/ticket情報 → recorded(draftId)/skipped(code)。呼出側SAVEPOINT内 |
| `recordRouteUseInTransaction` | db/owner/versionId/fence/採用時刻 → updated/stale。warmだけ |
| `activateInTransaction` | db/draftId/expected fence/baseVersionId/review digest → activated(versionId)/superseded。同じwriterで能力登録・版追加・draft終端 |
| `editInTransaction` | db/認証scope/requestId/stateToken/instruction → accepted(draftId)/conflict。base版/登録証明を束縛 |
| `disableInTransaction` / `rediscoverInTransaction` | db/認証scope/requestId/stateToken → 更新DTO/conflict。draftとgrantを失効 |
| `clearInTransaction` | db/認証scope/requestId/expectedEpoch → epoch/論理削除件数。同じ再送は保存済み結果 |
| `sweepInTransaction` | db/保持参照/limit=100 → removed/hasMore。能力はcapabilitiesの公開GCで処理 |

author/review job kindは `research.skill-author` / `research.context-review`。payloadは `{draftId, step:"author-1"|"author-2"|"review-1"|"review-2"}`、version=1、scope=research-routes:owner、lane=background、resourceKey=inference.llm、maxAttempts=1、recovery=interrupt、concurrencyKeyはdraftId。subject/dedupeKeyはdraftId+step。120秒deadlineはdraft受付時から固定。

author JSONはname（1〜64文字）/description（1〜256文字）/body/contextRule/recipeのstrict object。recipeはhostが固定したものとbyte canonical一致。authorのbodyを固定rendererで最終SKILLへ組み込み、Contextもhost rendererで作る。review JSONは `{decision:"approved"|"rejected", code, problems, draftDigest}`。codeはschema/scope/policy_conflict/instruction_injection/context_overflow/unsupportedのenumまたはnull。approvedはcode=null/problems=[]、rejectedはcode必須/problems=1〜8件（各300文字）。review対象は最終SKILL/Context/spec/recipe/baseVersion/policyで、host計算digestと一致させる。rejectは草案全体で1回だけauthor再作成可。変更後は再reviewが必要。

author/reviewのsettleで次jobの受付・公開操作の戻り値を必ず確認する。Queue満杯や契約不正を、非終端草案のままjob completedにしない。approvedはreceipt採用・能力登録・CAS・draft activatedを同じtransactionで確定。rollbackならpartial登録なし。取消/clear/再起動はinterrupted、CAS競合はsuperseded。


### runtimeへ渡す汎用port

AcquisitionPlanPortの型はagent-runtime/contractsが所有する。ルート検索はrootの提案、bind以降がchildの実行。applicationがresearch-routesのDTOを変換する。実装時にサイト固有の型をagentへ持ち込まない。

| メソッド | 必須入力 / 出力 |
| --- | --- |
| resolveInTransaction | db/{rootRunId,coordinatorTaskId,question,requestAtMs} → unmatched/clarification(question)/search-first(proposalToken,query,language,region)/candidate(proposalToken)/direct(proposalToken,packageRevisionId)/unavailable(code) |
| bindInTransaction | db/{proposalToken,childOwner,deadline} → bindingToken/packageRevisionId/initialAction。runtimeがchildのparent/root/cancel epochを確認してから呼ぶ |
| validateInTransaction | db/{bindingToken,owner,stage:"prepare"\|"finish"} → allowed/rejected(code)。stageごとの権限とpolicyを確認 |
| recordObservationInTransaction | db/{bindingToken,owner,visibleSources,lookupProvenance,report,facts} → valid(proofId nullable,canonicalReportPatch,safeProjection)/source_unusable/report_invalid/policy_unavailable |
| validateAdoptionInTransaction | db/{bindingToken,owner,projectionDigest} → allowed/rejected(code)。cached権限はclear/disable/disqualifiedで拒否、通常lookupは学習fenceだけの失効で回答を取消さない |
| releaseInTransaction | db/{bindingToken,owner} → released/stale。DBで失効を確定、メモリー参照の解放はcommit後 |

initialActionはhost lookup/candidate import/direct invokeのunion。recipeの固定tool/inputと、runtimeで発行する実行参照を分離する。proposalTokenとbindingTokenはhost発行UUIDで、モデル/APIには生成や上書きを許可しない。tokenの参照先はagentの永続bindingに持ち、grantとしての再発行・使用はtool-runtimeのowner/期限検査を通す。Tokenが再起動で残っても旧メモリーexecutionRefは復活させない。

### 管理API

schemaは全てstrict、認証/Origin検査を入力の詳細検査より先に通す。

| 操作 | schema / 成功結果 |
| --- | --- |
| list | cursor optional/limit 1..50 → `{items:RouteSummaryDTO[],nextCursor,epoch}` |
| show | key 64 hex → RouteDTO（draft ID/state/errorCodeを含む） |
| edit | `{requestId:UUID,expectedStateToken:64hex,instruction:1..2000文字}` → 202 `{draftId}` |
| disable/rediscover | `{requestId:UUID,expectedStateToken:64hex}` → 200 RouteDTO |
| clear | `{requestId:UUID,expectedEpoch:非負整数}` → 200 `{epoch,deletedKeys}` |

RouteSummaryDTOはkey/keywords/target/state/stateToken/activeVersionId/sourceUrl/lastSuccessAt/draftStatus。listはsummary DTOだけ。詳細RouteDTOはskillRevision（revisionId/hash/bodyまたはnull）とcontextProjection（stringまたはnull）を追加する。draftStatusは `{id,state,errorCode}` またはnull。草案のモデル生応答やproofは公開しない。stateTokenはepoch/incarnation/generation/controlVersion/activeVersionIdのhost hash。GETはkeyが現存すればexpiredでも200でstate/draft状態を返し、利用不可の本文欄はnull。回収済みキーは404。新しい管理APIには410を設けない。変更POSTの古いtokenは409、編集可能な版なしは409 route_not_editable。

requestIdはscopeごとにmethod/path/body digestを照合し、同じなら元のstatus/body、違えば409。操作台帳はclearでも消さず24時間保持。state変更とreceipt保存は同じtransaction。cursorはbase64urlの `{lastKey,epoch,scope}` をstrict decodeし、scopeは認証と比較、別epochは409。key ASCでページング。POSTの受付余地なしは429 control_busyで変更前に終了。

## 作業ごとの変更と試験

試験IDはこの別紙の固定ID。試験ファイル名は新規の予定名であり、現時点では存在しないものを含む。所有domainのindexから公開操作を使う。

### T00 — 同条件baselineと実資料の確保

変更/成果物: `spec/verification/research-routes/source-feasibility.md`、Git対象外のbaseline結果。既存lookup/read APIで鎌倉/静岡市/AAPLを検索し、1サイトで対象・時点・必要値を取得できるか確認する。引用400文字/visible範囲での対応も確認する。URL、検索ページとAPIの対応、資料形式、発表時刻、必要な有限表記、guard結果を記録する。Provider応答丸ごとやsecretを記録しない。

完了: 既存capabilities/tool-runtime/agent-runtime/web-research/dialogue gateの結果と、対象ごとの対応/未対応が明確。未対応なら後続のcity対応完了は宣言しない。新しい取得元の表記をfixture化する範囲で解決し、外部API認証や任意コード実行の追加へ広げない。

### T01 — domain入口とcontract

変更: `api/domains/research-routes/{index.ts,contracts/index.ts}`、`scripts/domains.ts`、`test/contracts.test.ts`。domain依存はcapabilities/inference/queue、Web入口も登録。SearchSpec/binding/recipe/fence/lookup/facts/draft/DTO/API schemaを先に定義。schemaは正本の上限・unionを守る。

試験 K01: weather/quoteの型違い、未知field、無効日付、unsupported price kind、過大payloadを拒否。domain gateで型・境界を確認。まだDB/APIを仮実装しない。

### T02 — keyと時計

変更: `service/keys.ts`、`test/keys.test.ts`。有限文法・alias・既定値・query renderer・canonical hash・bindingの対象日を実装。

試験 K02: 鎌倉の2表現は同key/query、静岡市は別、静岡はambiguous。today/tomorrow/absolute/必要項目は別。入力途中の銘柄文字を削除しない。引用/比較はunsupported。23:59受付のrunは0:01でも同binding、翌runは翌日。時計を注入し実sleepなし。

### T03 — 自domainの台帳

変更: `repository/index.ts`、`service/registry.ts`、`test/repository.test.ts`、`api/application/migrations.ts`。正本の8テーブルを追加migrationとして公開。epoch+key、incarnation、versionId、origin別proof、操作台帳と必要index/FKを実装。

試験 D01: 実SQLiteでmigration、同keyの異epoch、同incarnation内のrevision重複拒否、origin別FK、rollback。既存migration checksumが不変。新SQLをapplicationに書かない。proofにもgeneration/binding/projection digestを固定し、採用前の証拠の世代を後から補完しない。

### T04 — 照合と管理state

変更: `service/plans.ts`、`test/plans.test.ts`。lookup union、TTL/policy、状態導出、disable/rediscoverのdomain操作を実装。まだcontrollerは作らない。

試験 D02: direct/candidate/lookup/disabled/unavailable全分岐。候補があっても版期限/故障/policy変更は実lookup要求。編集中も健全activeは利用可。capacityはfence=nullで通常取得を維持。非終端draftが終わればpreparingは消える。warmの時刻更新はtoken世代不変。

### T05 — 資料とfactsの一致

変更: `service/validation.ts`、`test/validation.test.ts`、必要なら既存 `web-research/service/source-text.ts` とその所有test。資料の型付き抽出・有限recognizerを実装。source-textはP0で確認した公開JSON/HTMLの有限な形式から値を抽出して短い正規化資料へ変換する処理だけで、経路の業務判定は置かない。

試験 V01: 対象/粒度/日時/単位/価格種別/値、未来時点・鮮度上限、snippet/truncated/相反値。同じ400文字に根拠があることと独立抽出を確認。正しい資料＋間違った子factsはreport_invalid、資料の時点違いはsource_unusable。未対応表記で緩和合格しない。

### T06 — 検証値を親向け要約へ変換

変更: `service/projection.ts`、`test/projection.test.ts`。canonical factsから既存projection形を生成し、conditionは有限ラベルへ変換。内部reportと公開cardも同じcanonical値へ置換する。登録Context用rendererも同domainに置く。

試験 V02: facts=27、model summary=26やsentinelでも投影は27だけ。quote/title/body/命令文を投影へ入れない。report_jsonの主張も27で、証拠は検証済みfactsの引用。Contextには今回の1経路だけ。自由文を捨てる理由と一般調査不変を試験する。

### T07 — 学習定義の登録契約

変更: `capabilities/contracts/index.ts`、`service/learned.ts`、capability_itemsのdiscovery_mode/originを追加するmigration、`test/learned.test.ts`。route-only/学習由来の属性、ホスト固定namespace、不変ID登録、閉包・固定依存・bytesの検査を追加。

試験 C01: ID/hash衝突、schema mismatch、必須SKILL欠落、16KiB超を拒否。5000件の小さな学習定義を登録しても組込み候補は得られ、学習SKILL/packageはFTS/alias/listのLIMIT前に除外される。旧revision JSON/hashは不変。

### T08 — ID指定prepareと公開GC

変更: capabilitiesのserviceと `test/prepare-learned.test.ts`。候補検索なしのprepareを既存共通検査へ接続。GCは明示された学習由来route-onlyの非保護版だけ削除。

試験 C02: 停止/再開・hash・owner・必須依存検査を省略しない。健全なAのprepare後に独立IDのBを登録してもAは有効。組込み/保護依存をGCが消さない。rollback後にメモリー参照を公開しない。

### T09 — 回答終了後のcontrol推論

変更: inferenceのcontracts/service、`test/maintenance-control.test.ts`。optionalの `captureMaintenanceControlInTransaction` を追加。現在snapshot、larm-only/cloudなし、exact、2048 tokens、固有subject、deadlineを使う。

試験 I01: 元回答accepted後もcapture可、元deadlineは流用しない。新設定の失効/取消/late receiptは拒否。通常captureControlはpending親必須のまま。fake LARMで確認。

### T10 — 草案受付と原子的登録

変更: research-routesのregistry、`test/registration.test.ts`。observed/adopted proof、adoption/editの草案、版/証明/digest、capabilities公開登録とactive CASを実装。

試験 D03: 未採用proofから登録不可、同key非終端1件、束縛proofの差替え不可。cap登録後に故障注入すると全rollback。旧review digest、異epoch/incarnation、disqualified baseを拒否。説明編集で取得時刻/30日期限を延長しない。

### T11 — authorの1step handler

変更: `service/authoring.ts`、固定profile/SKILL、`test/authoring.test.ts`。source本文なしの構造化入力、固定recipe、maintenance control、maxAttempts=1のhandlerを作る。

試験 L01: 許容JSON、8KiB/2048 tokens、recipe改変、秘密/任意操作、取消/late settle。正常結果はreceipt採用後だけ保存。次review enqueue満杯は草案終端、元回答は保持。

### T12 — reviewと1回だけの修正

変更: `service/reviewing.ts`、固定profile/SKILL、`test/reviewing.test.ts`。最終SKILL/Contextのdigestでreviewし、純粋な登録scenario validatorも呼ぶ。approved時に同じsettleで登録・activatedへ進める。

試験 L02: author-1→review-1、reject→author-2→review-2、author契約不正で修正権を使った後の追加修正拒否。最大4推論。Queue満杯/取消/120秒/再起動でdraft/jobが終端。approved中間state・部分登録・古いdigest流用0。

### T13 — 汎用runtimeのport/binding

変更: agent-runtime contracts/service、追加migration、`test/acquisition-plan.test.ts`。opaque root提案→child binding、host/model origin、progress mode、agent_tasksの提案/binding JSON、agent_reportsのsafe projection JSON/digest/binding保存、port入力の最小観測を追加。completed/consumed/data epoch/digestを確認するhost用adopted証拠公開操作も作る。

試験 A01: portなしは従来経路。weather schemaをagentへimportしない。get/validate adoptedは完了時のrevision変更で失敗しないが、report削除/取消では拒否。projection形は既存互換。追加列があるagent_reportsへのINSERTは明示column listへ変え、portなしの旧経路がNULL列で動くことも確認する。cached権限は親の採用時にも再検査し、clear/disable後の結果を拒否。通常lookupの学習fence失効は回答の取消と分ける。fault前の同URL proofを後から再登録へ使わない。

T13は次の小工程を順に完了する: **T13a** root提案とchild bindのcontracts/所有者試験、**T13b** safe projection保存とprepareAnswer/採用時検査、**T13c** completed/consumedの証拠公開操作。各小工程でagent-runtime gateを実行する。他のTはT13cまで完了してから進める。

### T14 — 今回ownerのURL許可

変更: tool-runtime contracts/service、`test/cached-source.test.ts`、applicationのadapter接続。route/candidateのhost grantと候補importを追加。生成・使用時にport照合し、各ownerに新しい参照を発行。

試験 R01: 別owner/キー/世代/URL、旧grant、停止・clearを拒否。候補importの元query/provenance/TTLを確認し、実lookupを偽造しない。新キーの初回をimportで代用不可。予算上は候補importをlookup allowance1回として数え、実HTTP lookup件数とは分ける。

### T15 — LLM枠を持たないcold host step

変更: agent-runtime `service/route-step.ts` とservice接続、`test/route-step.test.ts`、組込み `SKILL.v2.md` と `builtin/web-research.ts` の新revision追加。resolve、host lookup、候補import、普通のworker取得へ遷移。未登録をforecast/quote hintだけで完了させない。旧SKILL.mdの変更で@1のbody hashを書き換えない。

試験 A02: first実lookupのquery=spec.keywords、stepIdの重複で二重取得0、host stepに偽inference receipt0、親の待機で推論枠保持0。JSON修正や取消でも予算/ordinalをリセットしない。

### T16 — warmの1toolとfinish

変更: agent-runtimeのhost step/worker context/finish、`test/warm-route.test.ts`。direct package prepare→新owner参照→1tool→子finish→facts検査→safe projection→親ready。sourcesを表示可能範囲へ再確認してから採用。

試験 A03: lookup0/tool1/子要約1回。通常のroot採用と合わせて2モデル。26→27で27を回答。子のbody/title/quoteが親へ渡らない。facts/reportの修正はサイト失効と区別。

### T17 — 取得の5秒と採用期限

変更: ToolAdapter host option、web-researchのrun追加列/service、`test/attempt-timeout.test.ts`、application/toolchain.ts。attemptTimeoutMsを保存してexecute開始から計測。

試験 W01: Queueで5秒待っても実取得前にfaultにしない。5秒成功の資料を要約時に失効させない。他利用者が残る共有取得をabortしない。HTTP試行1回。通常呼出しの既定timeoutを変更しない。web_attempt_timeout/web_deadline_exceeded/web_cancelledを分け、共有controllerのabortで元の理由を上書きしない。guard/parse完了後のwriter待機はattempt期限で失効させない。

### T18 — 旧planから代替planへ

変更: research-routesのfailure操作、agent-runtimeの `replaceAcquisitionPlanInTransaction`、`test/rediscovery.test.ts`、port adapter。故障版disqualified→旧grant失効→通常package→実lookup→別URL→新factsの順。

試験 A04: A404→B成功、A timeout→B失敗、guard/能力停止は迂回なし。旧late結果0、予算とowner維持。Bの完全proofをA失敗だけでpartialにしない。切替rollbackで他rootを巻き込まない。

### T19 — 回答と任意学習の障害分離

変更: dialogueのobserver port/settle、application/research-routes.ts・toolchain/serverのcomposition、`api/application/research-routes.test.ts`。必須回答採用後のSAVEPOINTでadopted proof/draft/jobを確定。warmは利用時刻のみ更新。

試験 E01: cold→回答採用→登録job、warm→登録job0。queue_full/容量/observer例外でも回答完成、proof/draft/job部分受付0。元run削除/取消でlate学習は拒否。必須ticket/receipt不正は通常どおり回答不採用。

compositionではcapabilitiesを作成/seedし、SourceAdoptionPortが後でagent/dialogueを参照するclosureを用意してresearch-routesを作る。続いてroute portを受け取るtool-runtime/agent-runtime、observerを受け取るdialogueを作り、closureの参照を確定する。未確定の参照は明示unavailableで拒否し、constructor内で相手のserviceを実行しない。全handler登録・復旧が終わるまでrunnerをstartしない。これによりservice同士の組立てで循環待ちを作らない。

T19は **T19a** applicationのport/handler配線と起動順、**T19b** dialogueの採用後SAVEPOINT、**T19c** cold/warm/受付失敗のAPI fixtureの順。aでは通常の既存回答が動くこと、b/cでは任意学習が必須回答を巻き込まないことを確認する。

### T20 — 管理APIの競合と再送

変更: research-routes controller/contracts/service、application/app/router、`test/controller.test.ts`。list/show/edit/disable/rediscover/clear、stateToken、epoch cursor、操作台帳を接続。

試験 H01: 認証/Origin、strict input、404/expired=200、stale 409、同request再送、異bodyの同ID。clear再送で新登録を消さない。編集は説明だけ、構造変更は同期拒否またはdraft rejected。停止から通常回答で勝手にactiveへ戻らない。

T20は **T20a** GET/list/summary DTO/cursor、**T20b** stateTokenと操作台帳共通処理、**T20c** edit、**T20d** disable/rediscover/clearの順。同じoperation receiptの仕組みを各endpointへ複製しない。

### T21 — 回収と起動復旧

変更: research-routesのmaintenance、application起動/終了接続、`test/lifecycle.test.ts`。現在epochだけを可視にし、旧epochを100行ずつ物理回収。TTL/bytes/保護参照をcapabilities公開GCへ渡す。未完了author/reviewはinterrupted。port接続/Queue復旧を終えてからrunnerを開始する。

試験 D04: clear中の同key再作成、5000キー、64MiB、保護対象だけで満杯、旧draft late、再起動新参照。operation receiptをclearで消さない。disabledキーをTTLで消して自動復活させない。掃除jobはreplay_safe、外部取得/モデルjobは自動replayなし。

### T22 — APIだけを使うclient/CLI

変更: `client/research-routes.ts`、`client/index.ts`、CLI、対応test。全管理APIを型付きmethodとしてexportし、CLI list/show/edit/disable/rediscover/clearへ接続。editはファイル入力。

試験 H02: HTTP method/path/schema/409・expired状態表示、requestId再送。CLIはshowのstateTokenとlistのepochから操作し、DBを開かない。clientはbackendのcontracts以外をimportしない。

### T23 — panelと永続progress

変更: Web research-routes入口/panel/tests、SettingsPage render slot、App接続、queryKeys/SSE、agent card。dirtyはAppで個別管理。

試験 U01: 読取/編集/停止/次回検索/clear、草案失敗でも旧active表示、版競合、削除後query消去、SSE invalidate。設定保存で経路のdirtyが消えない。settingsからresearch-routesの直接import0。定期ポーリング0。

### T24 — 結合のfixture E2E

変更: `api/application/research-routes.test.ts`、`tests/browser/research-routes.spec.ts`。隔離backend、fake LARM/Webを認証APIから操作。内部SQLiteを直接変更して失敗を作らず、fake取得とbarrierで故障/競合を作る。

試験 E02: 鎌倉cold→登録→warm値更新、静岡市miss→cold、AAPL cold→warm、404→B、clear late、Queue飽和回答保持。各runの実lookup/tool/model/登録jobを数え、画面のstateと親投影も確認。

T24は **T24a** 鎌倉cold/warmの1組、**T24b** 別地点/株価/故障・競合、**T24c** browser操作の順。最初にAPI fixtureを通し、browserで同じ内部状態の再実装をしない。

### T25 — 最終gateと実取得

変更: `scripts/research-routes-live.ts`、`scripts/verify-live.ts`、検証README、domains/logging/README。正本のコマンドを順次実行し全gateを通す。liveにはexplicit flagとbackend側のLARM credentialが必要で、fixture fallbackは不可。

完了: 実LARM/実Webで鎌倉・静岡市・AAPLのcold/warm、最新値/日付/対象、warm登録job0を確認。最低5組の同条件計測は比較対象ごとに記録し、sourceChanged/unsupportedを分ける。全体10秒は速度目標、機能合格と別欄。登録待ちは初回回答時間へ混ぜない。実サイトの404はfixtureのみ。実装・fixture・live・実機器音声の状態を分けて報告。

## 最終受入と引継ぎ

全Tが完了し、正本の回帰表と全gate・liveを満たした時にだけ実装完了とする。途中で止まる場合は最後に完了したT、失敗している試験ID、未接続port、未達live対象を記録し、次担当が同じ事実から再開できるようにする。

完了した後は正本と本チェックリストを一緒にspec/.archivedへ移し、相互リンクとレビュー記録の参照を更新する。未実装の現在は移動しない。画面/CLIの操作仕様、ログへ出せるmetadata、残る速度評価をdocsへ反映する。実機器3往復を行うまでは音声MVPの完成とは書かない。
