# 自律エージェント基盤の改善調査・設計案

作成日: 2026-11-05。状態: **調査済み・設計案。P0（基準測定のfixture計測基盤）だけ実装・受入検証済み。P1以降は未着手、本番採用なし。**

文書レビュー: 2026-11-05、3観点のレビューと修正後の再確認を完了。確認した範囲で実装・受入を妨げる未解決指摘なし。

状態の経緯:

1. 作成時は「実装・採用は未承認、未着手」であり、実装による設計検証も行っていなかった。
2. 同日、利用者がP0だけをClaude Code／Codex SDKへ委譲して実装することを承認した。
3. P0のfixture計測基盤を実装し、受入検証を行った（r1の後、親レビューのR1〜R5を修正したr2で受入。正本配置後に最終確認）。結果は[P0報告](verification/agency-shadow-p0-p1/p0-report.md)。
4. P0のコード変更はAgencyの`eval/initiative`だけで、製品runtime・SystemContext・権限・設定・依存・配布物は変更していない。P1は結果確認待ちで未着手。実モデルの意味評価・holdout・live計量・製品反映は未実施。

作成時の利用者依頼は、調査結果の文書化と実装計画の具体化までだった。本書の作成は、実装・実モデル測定・外部担当への送信・本番反映を許可しない。各単位の実施には、それぞれ利用者の明示依頼が要る（P0は依頼済み）。P0・P1の依頼単位と採否基準は[実装依頼・受入計画](agency-shadow-p0-p1-implementation-request-2026-11-05.md)を正本とする。

## 1. 目的・制約

Eumenesが経験と関心に基づく有用な行動を継続し、不要な発話・調査と利用者の介入を減らし、実際の結果から判断の改善を検証できるようにする。DeepSeekの構造への移行は目的にしない。

- 意味・関連性・意図の継続・行動価値は既存AgencyのLLMが判断する。ホストは参照、権限、予算、保存、実行、取消、契約を強制する。
- 既存のObservation Ledger、wake、Memory、World、会話feed、調査担当、SQLiteの単一writer、queue、checkpoint、receipt、評価機構を優先する。
- Eumenes／Agencyはソースコードを直接編集しない。将来の改善作業はClaude Code／Codex SDKへ渡す。分析と候補作成、本番採用の権限を分離する。
- コード変更・権限緩和を自己判断で本番反映しない。外部担当も承認された候補作業領域だけを変更し、本番のソース・設定には書き込ませない。
- GitHubのIssue／PR／worktree自動管理、DeepSeek Harness、coding専用Worker、Agencyの置換、新しいイベントバス・汎用キュー・Mandateサービスは対象外。
- 語句・正規表現・固定辞書による意味判断の代替を追加しない。専用処理は外部契約・安全制約に必要な最小範囲に限る。

## 2. 調査の正本と証拠

| 対象 | 調査時の版・位置 | 適用範囲 |
| --- | --- | --- |
| Eumenes | `056afd43115c0ae7df91449ad62baa0000d73c60` | ローカル正本。実装時には現在版との差分を再確認する |
| 本体採用Agency | `e7b4096d5bd56b8a32dd8bd93a65a519f8393b3f`、0.1.3 | [配布manifest](../vendor/agency/manifest.json)。隣接最新版と混ぜない |
| 隣接Agency | `79c0418d3a27ec2f3ae878e74a48c251d4fe6add` | `../eumenes_agency`。以下のリンクは本書からの相対位置で記す |
| DeepSeek | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` | [公開参考実装](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4)。実行環境・指示は導入しない |

主要な証拠を次にまとめる。文書の構想と実コードの存在、既存の測定記録と今回の再検証を区別する。

| ID | 根拠 | 確認事項 |
| --- | --- | --- |
| E01 | [Agency runtimeの組立て](../api/application/agency/runtime.ts)、[Host](../api/application/agency/host.ts) | 本体はF、関心形成、機会付き更新、調査能力を接続済み。会話・訂正のfeed、定期reviewを扱う |
| E02 | [wake](../../eumenes_agency/src/domains/agency/wake.ts)、[Ledger](../../eumenes_agency/src/domains/experience/ledger.ts) | 重複観測、起床印、冷却、日次上限、委譲中抑止。external.eventはrecallと同じ終了対象の検査を持たない |
| E03 | [調査入力](../api/application/agency/research.ts)、[開始・採用](../api/domains/dialogue/service/agency-state.ts)、[永続記録・権限照合](../api/domains/dialogue/repository/agency.ts) | 読み取り能力の限定、実在するIntent／workRef／epoch／期限、実行対応を確認する |
| E04 | [checkpoint](../api/application/agency/checkpoint.ts)、[復旧](../api/application/agency/recovery.ts)、[返却](../api/application/agency/returns.ts)、[queue復旧](../api/domains/queue/service/runner.ts) | 実行前保存、同一ticketの照合、一度だけの返却採用、失効、replay_safeと結果不明の区別 |
| E05 | [選択runtime](../../eumenes_agency/src/application/runtime.ts)、[participation](../../eumenes_agency/src/domains/agency/participation.ts) | select後の予約がcandidate、attempt、workRef、活動予算、冷却に影響する。送信抑止だけではShadowにならない |
| E06 | [台本再生](../../eumenes_agency/eval/scenario.ts)、[比較](../../eumenes_agency/eval/compare.ts)、[initiative](../../eumenes_agency/eval/initiative/run.ts)、[受付fixture](../../eumenes_agency/eval/initiative/research.ts) | 仮想時計、複数条件の比較、本体受付を使う一時DB・模擬担当がある。replayScriptの既定成功receiptはShadowに使わない |
| E07 | [trace](../../eumenes_agency/eval/trace.ts)、[context-eval](../scripts/context-eval/cli.ts) | traceはprompt・出力を保存する実験用。context-evalは会話contextの評価経路であり、Agency評価へそのまま適用できるとは限らない |
| E08 | [音声受渡し](../api/application/agency/speech.ts)、[Live受付](../api/domains/live-voice/service/index.ts)、[Live出力](../api/domains/live-voice/service/outputs.ts) | 受付はboolean。Liveのsentは送信前に保存され、外部受付・実発話・再生の証明ではない |
| E09 | [Agency進捗](../../eumenes_agency/docs/agency-next-progress.md)、[self research設計](../../eumenes_agency/spec/self-research-design.md)、[本体自己改善設計](harness-self-improvement-design-2026-10-31.md)、[README](../README.md) | P5-bの候補生成と承認ゲート、改善循環全体の未完成を区別。古い「本体未接続」は現在のコードで補正する |
| E10 | [修復bundle](../api/domains/capabilities/bundles/terminals-screen.bundle.json)、[SDK実行](../packages/coding-runner/src/sdk-engine.ts)、[永続依頼](../api/application/work/codex-task-runner.ts) | Claude Codeへの分析／承認後実装とCodex SDKへの既存経路。SDKへの委譲だけでは本番書込み禁止を保証しない |
| E11 | [自律接続の実施記録](agency-autonomy-integration-2026-11-02.md)、[追加の実モデル評価](../../eumenes_agency/eval/results/initiative-luna-followup-20261104/summary.md) | 過去版での実調査・返却の記録と、少数の合成判断試験。長期運用品質の証明ではない |
| E12 | [本体LLM port](../api/application/agency/llm-port.ts)、[推論組立て](../api/application/agency/assembly.ts)、[配布生成](../../eumenes_agency/scripts/pack.ts) | 会話prefix・native schema・control／session identityの追加、欠落usageの0埋め、候補配布物の生成・検査。Shadowでは入力固定・隔離・実測の区別が必要 |

### 2.1 DeepSeekの構想と実装の区別

[README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/README.md)は研究用プロトタイプで、紹介記事の構想には未実装があると明記している。以下の4設計はコードを確認した。一方、改善仮説→比較評価→採用→切り戻しの自動循環は確認できていない。

| 設計 | 実装の根拠 | 確認した動作・限界 |
| --- | --- | --- |
| Subscription | [001-domain](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/001-domain.md)、[intake.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/intake.ts)、[tickets.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/tickets.ts) | Threadから購読Ticketへ冪等に文脈を配送。文脈用と依頼継続用を区別。人が停止したTicketは再開しない。購読は権限を増やさない |
| Mandate | [002-authorization](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/002-authorization.md)、[model.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/model.ts)、[policy.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/policy.ts) | 許可の由来・Policy版・actor・scopeを保存し再開前に検証。ただしscopeの自由文やWorker指示自体はOSの隔離境界ではない |
| Observe | [policy.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/policy.ts)、[assessment.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/assessment.ts) | inferred候補の肯定的評価をwould_acceptとして記録し受理を抑止。明示依頼・既存購読の継続まで止める全体Shadowではない |
| Durable Effects／Outbox | [003-execution](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/003-execution.md)、[007-architecture](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/007-architecture.md)、[effects.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/effects.ts)、[outbox.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/outbox.ts) | SQLite副作用予約、commit後実行、再試行、世代照合、配信記録。Feishuは冪等キー、GitHubはmarker確認。外部作用のexactly-once全般を保証するものではない |

## 3. 差分と採用判断

| 設計 | 既存で満たすもの | 不足するもの | 価値・リスク | 提案する判定 |
| --- | --- | --- | --- | --- |
| Subscription | E01–E04の観測・Intent・Interest・起床・返却・保存 | Memory／World等の変化から継続対象への参照と接続、終了状態ごとの取扱い | 継続・重複調査削減。誤結合、撤回後の復活、到着だけによる過剰起床に注意 | 部分採用。既存feedとwakeを拡張。新規bus／サービス不要 |
| Mandate | E03–E05の承認・能力・期限・出所・失効検査 | 発行時のポリシーID／版・制限と実行の対応を固定する記録 | 監査・再開に有用。古い記録を現在の権限として使う危険 | 部分採用。既存実行記録を拡張。新権限体系不要 |
| Observe | E06–E07の台本、比較、トレース、本体受付fixture | 実運用資料の隔離入力、予約前の共通評価、判断と検証却下と抑止の別記録 | 判断品質を実行前に測れる。模擬成功・状態汚染・追加費用を防ぐ必要 | 採用候補。P0・P1で測定し、初期は1判断単位に限定 |
| Outbox | E04・E08のcheckpoint、queue、照合、返却採用、結果不明での再発話抑止 | Live出力とticketの安定した対応、送信試行と受付・再生の区別 | 二重発話と誤った成功経験を防ぐ。無条件再送は逆効果 | 部分採用。既存Live出力を拡張。汎用queue不要 |

## 4. 最小変更案

### 4.1 イベントと継続対象の関連付け（P4）

最初に[既存update指示](../api/domains/dialogue/contexts/agency/update.context.toml)と提示資料を利用する。既存Intentの更新、既知結果の利用、新情報なしの調査反復抑止は既に指示されている。新しい意味分類器は作らない。

不足する永続参照だけ、Intent／Interestの任意のwatchRefsとして補う案。ホストが提示した資料・対象の不透明な識別子からLLMが選び、ホストが参照の存在・scope・版を検証する。Candidateは親Intentの参照を使い、独立した購読状態を持たせない。イベントIDは出所・版・変更から安定して作り、同じイベントと対象の適用を重複させない。既存Observationの本文・関連付けを後から書き換えない。

接続先は会話feed、Memory／Worldの公開操作、調査返却。新規資料の意味的な関連付けは既存updateの有界な入力で判断し、到着だけで直ちにselectしない。複数feedのcursorとsnapshotは既存writerで整合させ、復元epoch・忘却を守る。

| 対象・状態 | イベントを受けた場合 |
| --- | --- |
| Intent: proposed／adopted | 文脈を取り込み、既存gateの範囲で起床。実行権限は別検査 |
| Intent: held | 再開条件をLLMが評価。到着だけで再実行しない |
| Intent: completed | 結果の再利用・訂正資料にする。元Intentは自動再開しない |
| Intent: abandoned、Interest: faded | 自律起床・実行を抑止。古い根拠で作り直さない |
| Interest: dormant | 文脈は保持。到着だけで外向き行動を起こさない |

watchRefsは新しい版の変化を受ける対象の識別、evidenceは判断根拠に使った特定版の参照とし、混用しない。購読中でも読取り権限がなければ本文を渡さず、訂正・撤回・忘却は既存の失効経路を先に適用する。Interestの状態だけで関連する全Intentを自動終了・再開せず、各Intentの根拠と状態を既存updateで判断する。

変更候補: Agencyのmodel／interest／proposals／settle／wake／snapshot、本体のagency host／host-types／checkpoint、公開portの組立て。正確な契約はP1の測定後に別途合意する。

### 4.2 権限の由来の記録（P2）

dialogue_agency_workにホスト生成のAuthorityStampを追加する案。新しいMandateサービスは作らない。記録は、ポリシーID・版、実在するgrant参照、発行時のIntent／Candidate／Ticketの版、観測参照、能力版、対象・出力先、予算、期限、実行ID。秘密や再利用可能な権限トークンは複製しない。

実行・復旧・再試行・委譲・結果採用は発行時の上限と現在の許可の両方を満たす。現在の許可拡大で旧実行の範囲を広げず、縮小した場合は新規実行と遅延結果の採用を止める。Intentの存在や関連イベントは許可の代わりにしない。

変更候補: research.ts、dialogueのagency-state.ts／repository/agency.ts、既存research-control.tsへの接続。既存の能力・失効検査は再利用する。

### 4.3 判断と実行予約の分離（P1）

coreの共通経路は「観測更新・候補提示→選択→既存core gateの評価」。autoだけが既存の「予約→保存→ホスト最終検査→実行」へ進む。observeはcore評価を返して止める。ホストの最終受付を未検査なら受理可能と断言せず、fixtureでの比較結果を別記録する。評価記録の保存完了をautoの前提に追加しない。offは評価枝を起動しない。B0／B1／B2／Fの実験条件とは別軸とし、P0・P1は採用済みFを固定する。

ParticipationAssessmentという実行権限を持たない評価結果を返す案。公開された実行可能tokenや後で再生可能なcommit APIを増やさず、autoの確定は既存の直列処理内で行う。評価と実行間で版・epoch・期限・許可が変われば既存どおり拒否する。

最初は判断機会直前のsnapshotを複製し、入力・時計・gate情報を固定した1判断単位のShadowとする。AgencyのJSONだけでなく、llm-portが追加する会話prefixを含む実際のmessages・native schemaも固定する。内部更新は複製に閉じ、実行予約・attempt・workRef・活動予算消費・発話冷却・ActionReceipt・製品のAgency状態への書戻しを行わない。推論のcontrol receiptと使用量記録は既存inferenceで管理し、行動の成功receiptと区別する。評価のdecision／session identityとmeterは本体と分離し、実費・呼出し・tokens・時間を別途計上する。

実環境資料を受ける枝は期限・対象・予算を限定した明示起動のみ。P1は既定の本番autoを変更せず、全製品の自律行動を停止する運用設定・UIや、常駐する別状態系は追加しない。観測枝が副作用を起こさないことと、既存の本体側行動まで停止することを混同しない。

長期の反実仮想評価は初期範囲外。行動しなければ得られない結果や利用者の反応を模擬成功で補わず、共通の観測履歴での1判断比較と、後続の限定試用を分ける。

### 4.4 発話の復旧境界（P3）

SpeechRouterへticket由来の安定キーを渡し、既存live_voice_outputsのoutputRefを返す案。同一キーの二重受付を止める。queued、送信試行、外部受付、実発話、ブラウザ再生を別の事実として扱い、sentを配信確認に使わない。

| 障害・停止位置 | 受入条件 |
| --- | --- |
| Ticket保存後・調査開始前 | 同じroot／ticketで照合し、二重起動しない |
| 外部成功後・receipt未保存 | 実行先の冪等性・照会で確認。確認不能なら結果不明で保留し再送しない |
| 返却採用中 | 採用済み印・Observation・snapshotを同じwriterで確定 |
| 音声受渡し後・receipt前 | outputRefで照合。再発話しない |
| Intent終了・権限撤回後 | 復旧時も実行・結果採用を拒否 |

相手側が確認・冪等再送を提供しなければexactly-once配信を主張しない。生成・受付・配信の完了をIntentの目標達成に置き換えない。変更候補はspeech.ts、recovery.ts、Liveの公開受付・出力記録。既存queueは維持する。

### 4.5 自己改善の循環（P5以降）

P5-bの障害観測と候補生成、既存の外部担当への依頼、評価成果物を接続する。候補→比較評価→承認された期限付き試用→採用／棄却→悪化時の切り戻し→次の仮説、を記録する。訂正・実行失敗も根拠に含め、障害コードが同じというだけで改善効果を断定しない。

候補ごとに基準版・候補digest・根拠・固定評価条件・結果・承認・試用期限・切り戻し先を保持する。既存実験のmanifestと結果から始め、最初から専用domain／台帳サービスを作らない。SystemContext文面、行動／ツール選択の指示・提示資料を先に比較し、権限・予算・成功条件の緩和は対象外。

[DeepSeekのプロンプト版管理](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/004-prompts.md)から変更履歴と採用元の記録を参考にする。評価・試用中の版は固定し、実行途中に最新指示へ切り替えない。切り戻しは承認された外部担当・公開操作が行い、実施済み外部作用まで取り消せたと扱わない。

## 5. 優先順位・依存と採否

| 単位 | 目的 | 依存・完了条件 |
| --- | --- | --- |
| P0 | 基準版、比較資料、指標、欠測・失敗の扱いを固定 | 最初に実施。全試行を再現・集計できること。判断品質の合格とは分離 |
| P1 | 同じ判断とgateで外向き作用だけを抑止する | P0後。判断同等性、隔離、安全性、追加負担を測定。[詳細計画](agency-shadow-p0-p1-implementation-request-2026-11-05.md) |
| P2 | 実行権限の由来・発行時上限を追跡 | 自律範囲を広げる前に完了。失効・縮小・再開・委譲の拒否試験 |
| P3 | 音声の受渡しと結果不明を照合 | 既存の権限検査を維持して単独検証できる。P2導入時は照合記録を接続。各停止位置で二重受付・無条件再送0 |
| P4 | イベントと継続Intentの関連付け | P1で候補を比較。autoでの試用はP2後。重複・遅延・撤回・忘却を確認 |
| P5 | 改善候補の比較から採否・切り戻しを接続 | P1・P2後。候補1件の全工程と悪化時の復帰を記録 |
| P6 | 限定試用から実効性を確認 | 対象単位のfixture・結合検証後。利用者負担、成果、遅延、費用の条件で採否 |

実装済み、固定試験合格、実モデル測定済み、試用可、本採用を別々に記録する。採用・不採用・保留を測定から提案し、最終採用は利用者が決める。結果を見て期待値・閾値を弱めない。未実施や欠測は0点・0費用・成功へ置き換えない。

## 6. 寄与と実証の限界

| 改善 | 寄与する対象 | 期待する効果（今回未実証） |
| --- | --- | --- |
| イベント参照 | 関心の継続、自発調査 | 既存の問いを続け、Intentの乱立・重複調査を減らす |
| 権限記録 | 自発行動、安全な自己改善 | 再開・委譲・採用を監査し、許可範囲の拡大を防ぐ |
| Shadow | 自発発話・行動、自己改善 | 不要な働きかけと有用な行動の取り逃しを、実行前に比較 |
| 配信照合 | 自発発話、経験からの更新 | 受渡しを成功経験に誤変換しない |
| 評価と採否の接続 | 自己改善全体 | 提案で終わらず、悪化・不採用の結果も次の仮説へ戻す |

E11の追加試験は4場面×2回。停止・解決済みの4判断はモデル自身がwaitした一方、働きかけを期待した4判断の2件は参照不備で却下された。少数の合成例であり、統計的な改善・実運用の有用性・長期の反復抑止は確認できない。過去版の実調査成功を最新配布物の受入へ流用しない。

## 7. 調査時の検証と今回の文書化

2026-11-05の先行調査で次を実行した。改善案の実装効果を測った結果ではない。

- Agency `bun run verify`: 795 pass、0 fail、23 skip、1 todo（819件・62ファイル）。隣接ソースの固定検証。
- 本体 `bun run verify -- --domain dialogue --domain agent-runtime --domain tool-runtime --domain queue`: backend 878 pass、Web単体32 pass、失敗0、静的検査成功。[実行報告](../verification-reports/runs/2026-11-05T06-39-03-533Z-72106889-9f5e-499b-82d2-292a6f536604/report.json)。報告はローカル生成物で、checkout外への共有時は別途添付が必要。
- DeepSeekの実行試験、新機能の実装試験、今回の実モデル比較、ブラウザE2E、実機器受入は未実施。

作成時の文書化と文書レビューでは、設計書・依頼書・索引だけを変更した（以下はその時点の記録。P0の実施結果は冒頭の状態と[P0報告](verification/agency-shadow-p0-p1/p0-report.md)による）。製品ソース・設定・DB・依存・配布物は変更せず、サーバー操作・外部担当への送信・実装は行わない。文書リンクと差分を検査し、実行動作を変えないため製品verifyは再実行しない。レビューで見つけた矛盾と修正・再確認は[依頼書のレビュー記録](agency-shadow-p0-p1-implementation-request-2026-11-05.md#8-文書レビュー記録)に残す。

## 8. 残作業

- [x] 4設計のコード調査、既存機能との差分、追加不要な部分を記録。
- [x] 最小変更、責務、状態、リスク、依存と検証方法を整理。
- [x] P0・P1の外部担当向け依頼と計測・採否条件を具体化。
- [x] 利用者による設計・暫定測定条件の確認と実装依頼（2026-11-05、P0だけ。P1は結果確認後）。
- [x] 外部担当によるP0実装・基準測定（fixture lane、r2で受入、正本配置後に最終確認。[P0報告](verification/agency-shadow-p0-p1/p0-report.md)）。
- [ ] 承認されたP1実装と比較（P0の結果確認待ちで未着手）。
- [ ] 別途許可された実モデル／実環境の測定、採用・不採用・保留の判断。
