# 取得先学習・動的SKILL 実装計画の文書レビュー

2026-10-09 JST。対象は[実装計画](../../research-route-learning-implementation-plan-2026-10-09.md)。既存コードは `0492c6bf44cfbb6328fdf899e05570068ef9c004`。Sonnet向け[実装チェックリスト](../../research-route-learning-implementation-tasks-2026-10-09.md)も対象に追加した。本記録は設計レビューであり、将来の機能を実装・試験した結果ではない。

修正前の計画には、ドメインの業務配置、回答後の推論、任意学習の障害分離、キャッシュURLの許可、削除・更新時の参照に不足があった。そのまま実装すると既存の契約に抵触するため、計画を修正した。優先度は実装前に解消する必要の大きさを表す。

## 指摘と反映

| ID / 優先度 | 修正前の問題・根拠 | 計画へ反映した内容 |
| --- | --- | --- |
| R01 / P1 | research-routesを依存なしにし、サイト固有のauthor/reviewをagent-runtime、登録の業務をapplicationへ置いていた。既存 `docs/domains.md` と `scripts/domains.ts:13` のruntime責務に対し、サイト業務が混在する | 経路domainがauthor/review・検査・登録の業務と試験を所有。依存はcapabilities/inference/queue。agent/tool/dialogueは自分のportを受け取り、applicationは公開操作の接続だけを行う |
| R02 / P1 | 回答後にcaptureControlを再利用する計画だった。`api/domains/inference/service/index.ts:121` のallowedはpending限定、`:294` のcaptureControlは親とそのdeadlineを必須にする | fresh settingsから独立したmaintenance controlをcaptureするhost専用契約を追加する計画。既存pending制約・receipt採用・LARM限定を維持 |
| R03 / P1 | 回答完了後も既存ticket検査を使える前提だった。`api/domains/agent-runtime/service/index.ts:863` はready_for_answer限定、`:934` のcompleteでstate/revisionが変わる | completed/consumed/data epoch/report digestを検査する別のhost公開操作を定義。元回答のdeadlineと学習の期限を分離 |
| R04 / P1 | proofとjobを回答採用transactionへ直接追加すると、任意学習のqueue_fullで回答までrollbackする。`api/domains/queue/service/index.ts:120` は満杯でthrow、`api/domains/dialogue/service/index.ts:465` 以降が必須の採用処理 | 必須採用後のSAVEPOINTでproof/jobを同時受付。学習例外はその部分だけrollbackし、回答を保持。通知・メモリー副作用はcommit後 |
| R05 / P1 | generationだけではキー削除後に同じキーを作り直した際のlate完了を防げない。削除する台帳と旧draftの期待値が同じ初期値になり得る | 全削除epoch、キー再作成incarnation、停止generationを分離し、CAS/grant/proof/draftに束縛 |
| R06 / P1 | 旧経路を失効させても、同runのprepared package/grantを維持したまま再検索する契約だった | 通常検索planへの公開差替えと旧grant解放を定義。owner/deadline/step/累積予算を維持。代替Bの完全な証拠を先行Aの失敗と分ける |
| R07 / P1 | 同一capability itemへ経路新版を登録すると、健全な旧版の実行までgeneration不一致で失効する。`api/domains/capabilities/service/index.ts:108` と `:124` | 経路版ごとに独立した不変能力ID。健全な旧版の実行は継続でき、停止・clear・失敗版の採用だけを拒否 |
| R08 / P1 | active URL用grantだけでは、候補cacheの過去runのURLを今回のreadへ使えない。`api/domains/tool-runtime/service/index.ts` の実行参照はowner/期限付き | 候補のscope/spec/TTL/provenanceをhost検査し、新owner用の検索観測と許可をimport。実lookupを偽装せず、他キー・clear済み候補を拒否 |
| R09 / P1 | authorのcontextRuleをSystemContextの正本にすると、自由文とrecipeの完全な一致をhostが保証するという無理な契約になる | Contextは検証済み構造化値から固定rendererで作成。recipeはhost固定、author/reviewerは権限を変更できない。自由文の意味の検査限界も明記 |
| R10 / P2 | 容量上限が経路DBだけで、capabilitiesの動的定義・索引が無制限に増える。実行中版の具体的な保護・回収操作もなかった | 学習定義・索引・草案・proof・操作行を総量へ含める。非終端draft上限、TTL、100件ずつのsweep、公開能力GC、依存閉包の保護を定義 |
| R11 / P2 | SearchSpecの概略型だけではpurposeとtargetの組合せ、既定値、市場未確定、日跨ぎの判定が実装者任せになる | discriminated union、閉じた項目集合、既定値・並べ替え・有限文法、受付時RequestBindingを定義。複雑な依頼や未確定対象は通常経路へ戻す |
| R12 / P2 | interactive優先により新会話が待たないように読めた。`api/domains/queue/repository/index.ts:154` はclaim順序、runnerは実行中jobを先取りしない | 最大30秒の学習step待機が発生しうることを明記。step間で枠を返し、background実行中/idleの両方を計測。Queue全体の先取り変更は初版外 |
| R13 / P2 | 取得5秒を受付時に始めるとQueue待機だけでサイト故障になる。共有取得の全利用者へabortが波及する危険もある。`api/domains/web-research/service/index.ts:119` と `:395` | host attemptTimeoutMsをWeb runへ保存し、execute開始から計測。全体/採用deadlineと分離。共有取得から期限切れ利用者だけ離脱 |
| R14 / P2 | 登録時に「挙動fixtureを検査」とだけあり、本番でテストrunnerを動かすのか、追加モデル推論をするのか未定だった | 純粋な構造化登録scenario validatorを定義。モデルの意味評価と安全なhost判定を区別し、モデルfixture/liveは開発・受入gateへ分離 |
| R15 / P2 | URL手動変更のproof取得jobが未定義。説明編集でも元proof/会話が失効すると操作できず、期限延長にもつながり得る。APIの重複防止行・410の保持条件も不足 | 初版の編集は同じrecipeの説明のみ。構造変更は再検索へ。edit/adoptionの証拠を分離し、登録証明を継承して取得期限は延長しない。操作台帳、scope、非同期拒否、回収後404を定義 |
| R16 / P2 | settings画面から経路panelを直接importすると、research-routes→inference→settingsと循環する。既存 `web/src/domains/settings/index.tsx:80` はServiceTestsのrender slotを持つ | AppからrenderResearchRoutes slotへpanelを注入。経路の画面・queryは自domainが所有し、settings保存JSONへ混ぜない |
| R17 / P2 | full key digest・incarnation・revisionを能力IDに連結すると101文字上限を超え得る。削除後のr1再利用も衝突する。`api/domains/capabilities/service/index.ts:61` のID検査 | 新登録ごとの32桁version UUIDを能力IDに使い、key/版/incarnation対応は台帳が保持。旧定義hashを変更しない |
| R18 / P2 | 試験ケースは多いが、所有domain、実DB/fakeの使い分け、時計・競合制御、migration変更の所有が曖昧だった | 層別の試験表、clock/ID/timer/barrier、公開操作を使う一時SQLite/API E2E、各domain所有migrationとupgrade検査を追加 |

## 再レビューと実装粒度の改善

前回の18件を反映した文書を再読し、実装の具体的な順序と既存の保存・要約・初期登録処理まで照合した。追加20件を以下に記録する。過去の指摘表は当時の修正内容を残しており、API/状態の最終契約は今回の正本とチェックリストを使う。

| ID / 優先度 | 再レビューで見つかった問題 | 最終契約と確認する試験 |
| --- | --- | --- |
| R19 / P1 | 採用observerが正常warmでもproof/author/reviewを作り得て、検索省略後も学習負荷が続く | warmは利用日時のみ更新。登録job/新版0。T16/T19、A03/E01 |
| R20 / P1 | 版の主キー(key,revision)では旧版保持中の削除・再作成が衝突。clearの物理削除も長いwriter占有になり得る | keyはepoch+key、版はversion UUID＋incarnation内revision。即時epoch失効、100行ずつ回収。T03/T21、D01/D04 |
| R21 / P2 | key.stateとdraftが別々に進むと再起動やreview失敗後もpreparingが残る | stateは永続列からbackendで導出。健全版と編集状態を分離。T04/T21、D02/D04 |
| R22 / P1 | 引用やfactsが正しくてもsummaryだけ違う値や命令を含められる。既存verify-reportは引用の実在を確認するだけ | 検証factsからsafe projectionを生成。未検査自由文を親へ移さない。T05/T06/T16、V01/V02/A03 |
| R23 / P1 | 子が値を誤読しただけでサイトを故障扱いする可能性 | 資料の独立抽出と子facts比較を分離。source_unusable/report_invalid/policy_unavailable。T05/T18、V01/A04 |
| R24 / P2 | 経路期限切れでも24時間候補cacheを使って実検索を省略でき、policy変更時も古い検査条件に戻せる | cold/candidate/directの閉じたlookup union。期限・故障・policy変更は実lookup。初版unsupportedの自動学習は外す。T02/T04/T15、K02/D02/A02 |
| R25 / P1 | APIの整数期待revisionは削除後r1との違いを判別できない。clearで操作receiptを消すと再送が新データを再削除する | stateToken/expectedEpoch、24時間の操作receiptをclearから分離。T20、H01 |
| R26 / P1 | author後のreview受付失敗、approved後の登録失敗で草案・jobが非終端に残り得る | 最大1修正、120秒、次job受付失敗も終端。approvedは同settleでactivatedへ。false/nullの更新を成功扱いしない。T11/T12、L01/L02 |
| R27 / P1 | 子の検証結果がmemoryにしかないと、親のprepareAnswerが元summaryを再投影する。観測proofの生成と回答採用も未定義 | safe projection/digest/bindingをagent_reportsへ保存。observed proofは非公開、回答採用でadoptedへ。T10/T13/T19、D03/A01/E01 |
| R28 / P1 | 一般FTSのLIMIT後にroute-onlyを除外するだけでは5000学習定義が組込み候補を押し出す | 学習SKILL/packageを索引へ入れず、alias/listもLIMIT前にfilter。T07、C01 |
| R29 / P2 | 作者のJSONだけをreviewしてからhostがSKILL/Contextを追加すると、確認内容と実際の指示が違う | 最終rendered SKILL/Context/spec/recipe/policy/base版のdigestをreview。登録時に同じ内容を採用。T10/T12、D03/L02 |
| R30 / P1 | キー作成段階の容量不足でfenceを発行できず、取得・回答まで失敗し得る | capacityはfence=null、純粋検査と通常lookup/回答は継続、学習だけskip。T04/T19/T21、D02/E01/D04 |
| R31 / P1 | rootのplan/参照を新childへコピーするとowner不一致か、他taskの許可を流用する | root提案→runtimeが親子関係検査→child bind→新owner prepare/grant。親採用時もcached権限を確認。T13/T14、A01/R01 |
| R32 / P2 | expired GET=410では管理画面がstate/停止/再検索を表示できず、詳細本文と一覧DTOも混在していた | 現存キーGET=200＋expired、利用不可本文null。summary一覧と詳細を分離、回収後404。T20/T22/T23、H01/H02/U01 |
| R33 / P2 | task表の大きな工程だけではSonnetに複数契約の設計判断が残る | 26作業にファイル・契約・固定試験ID・依存・完了条件を付与。T13/T19/T20/T24は小工程へ分割。契約を両文書で一致させる |
| R34 / P2 | render slotのdirty共有や新settingsのgate漏れ、起動順に実装判断が残る | Appでdirtyを別々にOR集約。settings gate追加。port接続/Queue復旧後にrunner開始。T19/T21/T23、E01/D04/U01 |
| R35 / P1 | disabledキーをidle GCすると同じ依頼が新キー扱いとなり、停止設定が自動復活する | disabledキーは明示rediscover/clearまで保持し容量に算入。T04/T21、D02/D04 |
| R36 / P1 | 旧SKILL.mdの直接編集はseedのskill@1のbodyまで変えてhash衝突する。既存builtin/web-research.tsがファイルを読む | 旧ファイル/旧package@2を保持し、SKILL.v2.md/skill@2/package@3を追加。必須SKILLのpolicyを固定。T07/T15、C01/A02 |
| R37 / P1 | agent_reportsへ列を追加すると既存4値INSERTが列数不一致で通常調査まで失敗する | 明示column listへ変更し、旧経路NULL列と旧DB upgradeを試験。capの属性列はcapability_itemsへ追加。T03/T07/T13、D01/C01/A01 |
| R38 / P2 | 共有abortでattempt timeoutが利用者取消に化け、再検索せず終了する。取得完了後writer待機まで5秒に含める恐れ | attempt/root deadline/cancelのerror codeを分離。guard/parse完了でattempt timer終了。T17/T18、W01/A04 |

根拠を照合した主な既存箇所は `api/domains/agent-runtime/service/verify-report.ts`、`service/index.ts` のfinish/prepareAnswer、`repository/index.ts` のagent_reports、`api/domains/capabilities/builtin/web-research.ts` と `service/index.ts` の索引、`api/domains/web-research/service/index.ts` の共有取得、`api/domains/queue/types/index.ts` のhandler終端契約。

## 既存機能との整合

経路domainは取得先学習という業務を持つ上位domainとした。能力の不変登録、汎用runtimeの参照・予算、Web通信のguard、会話の回答採用、Queue資源管理を既存domainに残している。下位domainが経路SQLやapplicationを読む構造にはしない。

Webの設定統合も、既存のサービス試験panelと同じAppからのrender slotを使う。Web/CLIは認証付きAPIを通し、DBを直接開かない。動的SKILLとContextをsettingsの可変JSONへ混ぜない。

capabilitiesの参照hash、control推論のLARM限定、SQL writer、prepare/execute/settle、採用時の再検査、SSEを再取得の合図にする仕組みを継承する。追加する公開APIやport、migrationは計画へ明示しており、現時点で既存APIが提供済みとは扱っていない。

## テストしやすさ

検索キー・日時・検証・Context投影はモデルも通信も不要な純粋関数で試験できる。永続化は本物の一時SQLiteで検査し、SQLを写したmockによる見せかけの合格を避ける。runtimeと学習handlerはfake port/LARM/取得と注入時計を使うため、外部サイトや実時間sleepに依存しない。

回答採用後の生成、Queue満杯、削除後の同キー再作成、旧新版の同時実行、共有取得timeout、候補importはAPI結合試験へ含めた。サイト変更は故障注入E2E、取得元の実際の表記とモデル品質はliveとして別に記録する。純粋な検証だけで自由文の意味や完全なprompt injection耐性を証明できるとは扱わない。

## 文書の最終確認

- 既存 `scripts/domains.ts` のgraphへ計画のresearch-routes依存を加え、既存closure関数で再走査。初回は21 domain、今回の作業末尾では並行変更のtasks/goals/worldを含む24 domainで循環なし。agent-runtimeの依存は変更不要。並行変更の実装コードは本レビューで編集していない。
- 文書のローカルリンク、見出し番号、コードfence、表の列数、末尾空白、旧契約の残存を確認。チェックリストT00〜T25の重複/欠落・先行依存・循環・試験ID参照も確認。
- 修正対象は計画、26作業のチェックリスト、本記録のみ。実装コードの変更・機能試験・live取得は行っていない。以前の363/94/16件の成功値を今回の成功値へ転記していない。

前回レビュー後に追加の不整合を発見したため、上記20件を反映し、契約・工程・試験の対応を再点検した。最終の再読では追加の必須修正を見つけていない。未知の問題が存在しない保証ではなく、実サイトの取得可否と速度はT00/T25で判定する。

初版でURLの自由編集・全サイト対応・意味類似の経路転用・Queueの先取りは行わない。ユーザーが求める、初回検索、同キーワードで最新値の1サイト取得、地点ごとの独立、故障時の再検索と取得成功後の新版登録は維持している。全体10秒以下や実機器音声MVPの完成は未検証。
