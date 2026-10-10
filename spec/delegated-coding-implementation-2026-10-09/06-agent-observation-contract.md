# 外部コーディングエージェントの発言・終端を監督へ渡す実装計画

作成日: 2026-10-10 JST。改訂: 同日午後、承認ゲート（SEC-11）実装後の現行コードへ再照合し、復旧質問・新世代再開を [計画07](07-recovery-question.md) へ分離。状態: 2026-10-10にfixture範囲を実装済み（記録は [実装・検証記録](../verification/delegated-coding/agent-observation-contract.md)。live・LARM経路・実配送は未実施）。現行コード照合とレビューの結果は [レビュー記録](06-agent-observation-contract-review.md) に記載する。本書の fixture/live 受入は未実施。

本書は計画02 C5と計画03 S2/S6の差分を定める。全体の実行・権限・工程・報告台帳は計画01〜04を正本とし、別のタスク状態や監視基盤を作らない。今回の文書作成では実装しない。改訂部分の再レビュー（10節）を処置し、ユーザーが実装へ進む段階で着手する。

## 0 要約

本書で追加する事実は次の表だけ。詳細と根拠は5〜7節、受入はA1〜A25。

| 事実 | 値 | 直接CLI 0.155.1での実際 |
| --- | --- | --- |
| messageKind / classificationReason | commentary / final_answer / unknown と固定理由 | 常にunknown（phase_not_provided）。commentary/finalは型にだけ予約 |
| contentPresence / sourceTruncated / sanitizedBytes / retainedBytes | 空か、保存時切詰め、byte数 | すべて計測可能 |
| turnOutcome / terminalEventSeq | unconfirmed / completed / failed / cancelled / conflict | turn.completed/turn.failedだけから確定。errorはterminalにしない |
| processStarted | true / false / unknown | worker所有のspawn確認から |
| captureState / captureIssues / reportLimitations | 採取の完全性と、文章の損失・分類制約を別々に | 既存evidenceCompleteは置換しない |
| observationCoverage / excerptTruncated | 一観測内の取得範囲 | 観測間で合算しない |
| 報告状態 | 公開文章4値・明示final4値 | 明示finalは常にunidentifiable |

本書の打切りはhold・blocker報告まで。選択肢付きの復旧質問、その回答による中止・新世代再開は計画07が担当し、計画07が未実装でも本書の受入は成立する。

## 1 目的と受入の意味

監督が「何が確認済みで、何がまだ分からないか」を、文章の口調ではなく公開契約と実行証拠から判断できるようにする。

- 発言の所属、発言種別、turnの終端、processの終了、報告・証拠の欠落、作業の検証結果を別々に渡す。
- 最終回答はエージェントの報告であり、完了条件を満たした証明にはしない。
- 最終回答が識別できない、または回答が空でも、成果物が存在する可能性を残す。「報告欠落」「実行結果不明」「検証失敗」を一つの失敗にまとめない。
- 公開された途中報告を監督の観測に使う。報告を受け取っただけで現在の実行を終わらせたり、次のturnを開始したりしない。
- 新しい事実と不明点を既存のtask-reportsへ渡し、会話側が進行中であることを説明できるようにする。会話配送の完成は計画04の受入で確認する。

「この計画のfixture完了」「直接CLIのlive確認」「LARM経路の契約確認」「ユーザーへの実配送」を分けて記録する。本書だけで自律コーディング全体の完成を宣言しない。

## 2 調査基準と既存機能

調査HEAD: `bc8cc6c24e9b9fe327bc545fa1bfe4ab1b6bf8fc`。作業ツリーも含めて確認したため、HEADだけでは調査対象を再現できない。実装前に対象ファイルの差分・digest・採用版を再採取し、本書との違いを確認する。

初回レビュー後、記録した12ファイル中4ファイル（decoder.ts、application/coding-supervision.ts、coding-supervision/service/index.ts、tasks/service/index.ts）が変わった。主因は監督指示の承認ゲート（[改善計画SEC-11](../improvement-plan-2026-10-10.md)）。改訂では次を現行の事実として扱う。

- 承認ゲート: `approval.ts`の`createApproval`が、監督生成の指示を選択肢「承認する/却下する」の質問にし、`Supervisor.pendingApproval`へquestionId・decision・`digest(s.observation)`を保存する。回答は通常のtasks.answerを通り、applicationの`prepareInTransaction`/`dispatch`が`isApprovalAnswer(InTransaction)`で照合してCLI入力へ流さない。
- 観測失敗: `superviseCodingExecution.observe`のcatchは既に`observationFailedInTransaction`を呼び、2回失敗または150秒未成功で`supervision_monitoring_delayed`のholdにする。ただし失敗理由・最後の正常cursorは残さない。
- 全observationのdigest比較: `apply.ts`（stepのintent）、`decisions.ts`（decisionの再観測）、`approval.ts`（承認時/解決時）、`monitor.ts`（step失効）、`steps.ts`（step実行前）。

| 確認した場所 | 現状 | 本書で扱う差分 |
| --- | --- | --- |
| `packages/coding-runner/src/contracts.ts` | executionId/generation/seq、turnFinished、childrenStopped、evidenceComplete、exitCodeを保持 | 種別・正式な終端結果・欠落理由を表す契約を追加 |
| `packages/coding-runner/src/decoder.ts` | agent_messageは共通message。turn.failedとerrorは共通error。本文を32,768文字で切詰め | 不明分類、失敗終端の区別、保存時の切詰めの可視化 |
| `packages/coding-runner/src/worker.ts` | 実行ごとの専用pipe、終了イベントの永続化、process group停止確認がある | 追加事実を同じ永続化順序に組み込み、失敗と採取欠落を分離 |
| `api/domains/coding/service/index.ts` | 実行・世代・権限・cursor・digestを検査し、古いreceiptや欠番を拒否 | 新しい事実の矛盾・後退を検査。既存の照合を再利用 |
| `api/application/coding-supervision.ts` | unavailableCodingWorkflowは証拠参照・抜粋を空で返す。本番の操作workerは未接続。承認回答をprepare/dispatch前に分岐。catchで観測失敗を数える | 読取り観測だけを公開操作で接続。catchへ固定code・最後の正常cursorを追加。available=falseとexecute拒否を維持 |
| `api/domains/coding-supervision/service/approval.ts` ほかdigest比較箇所 | 承認待ちを全observationのdigestで失効判定 | 共通の意味digestへ置換し、読取りだけで承認・decision・stepを失効させない |
| `api/domains/coding-supervision/service/prompt.ts` / `policy.ts` | CLI完了文を証拠としない。検証・独立レビュー・Git receiptをhostが要求 | 新しい不明・欠落事実を入力へ渡す。既存の成功条件を緩めない |
| 計画03 / task-reports | 観測、重複排除、予算、報告outbox、監視遅延を実装済み | 追加事実を既存fingerprintと報告に反映。通知基盤を新設しない |

上の相対表記は変更対象を示す。実際の根拠は [decoder](/Users/y.noguchi/Code/eumenes/packages/coding-runner/src/decoder.ts)、[contracts](/Users/y.noguchi/Code/eumenes/packages/coding-runner/src/contracts.ts)、[worker](/Users/y.noguchi/Code/eumenes/packages/coding-runner/src/worker.ts)、[coding](/Users/y.noguchi/Code/eumenes/api/domains/coding/service/index.ts)、[組立て](/Users/y.noguchi/Code/eumenes/api/application/coding-supervision.ts)、[監督契約](/Users/y.noguchi/Code/eumenes/api/domains/coding-supervision/contracts/index.ts)、[policy](/Users/y.noguchi/Code/eumenes/api/domains/coding-supervision/service/policy.ts)。

## 3 参考実装の適用範囲と実際の形式

参考の [wire.ts](/Users/y.noguchi/Code/deepseek-harness/packages/subagent/subagent-codex/src/wire.ts) はCodex app-server 0.153.4向け。runTurn、handleNotification、collectOutput、observePendingTurnId/commitTurnIdと [関連テスト](/Users/y.noguchi/Code/deepseek-harness/packages/subagent/subagent-codex/tests/subagent-codex.spec.ts) から、次の判断境界を参考にする。

1. 発言を受信したことと、対象turnの正式な終端を確認したことは異なる。
2. 対象外のthread/turnや、対応未確定の通知は確定結果へ混ぜない。
3. 明示された最終回答と途中報告を分ける。途中報告を最終回答の代用品にしない。
4. 開始応答前の通知は、対応を確認してから採用する。

現行経路はCodex CLI **0.155.1のexec --json**。installed CLIのversion/helpと [同版の公式イベント定義](https://raw.githubusercontent.com/openai/codex/rust-v0.155.1/codex-rs/exec/src/exec_events.rs) を照合済み。agent_messageにはtext、itemにはid、thread.startedにはthread_idがある。turn.started/completed/failedにturnIdはなく、発言のphaseもない。実CLIでの成功実行は未検証。最新版一般の仕様をこの版の保証にしない。

この経路のmessageKindはunknown、providerTurnIdは不明とする。実行所属は、spawn前に確定したexecutionId/generationとその実行だけのpipeで確認する。sessionはthread.startedと指定resume sessionの一致を別に確認する。session未確認と実行pipeへの所属を混同しない。存在しないturnIdを生成してProviderの識別子として扱わない。

参考元のphase:nullによる末尾文章のfallbackは採用しない。未知のphaseが届く試験でも、採用版・形式で解釈が検証されていなければunknown。phase分類が必要になった場合は、その情報を提供する公開契約の採用を別途レビューする。app-serverへの変更や`--output-last-message`の採用は本書の前提にしない。

参考元の空回答→invalid-result、一時的な単発thread、無人入力への一律対応は移植しない。Eumenesのcontinue・質問受付・委任権限・停止確認を維持する。

## 4 担当層とLARM境界

| 層 | 所有する責務 | 上位へ渡すもの |
| --- | --- | --- |
| LARMのAgent Runtime/Gateway | Provider形式の解釈、native/public ID対応、早着通知の保留、正式なturn終端、cursor再取得、承認・質問の公開契約 | LARMの公開session/turn/cursor/eventと確認状態 |
| 直接CLI用runner adapter | 採用版exec JSONLの解釈、専用pipeとの所属、公開発言だけの正規化 | 確認できた種別・終端・欠落。不明を補完しない |
| runner worker/core | 自分が所有するprocess、停止要求、子process終了、spool永続化、採取上限 | 既存receiptと追加観測事実 |
| coding domain | 実行/世代/権限との照合、永続イベント、証拠digest/cursor、workspace reservation | 採用済みの実行事実・許可された証拠参照 |
| application | 各domainの公開操作を結合。外部読取りはtransaction外、採用は単一writer内 | 固定した観測snapshot |
| coding-supervision | 工程・次の行動・完了条件の判断、予算、証拠への要求 | host検査対象の判断と既存報告 |

上流の [LARM Agent Service](/Users/y.noguchi/Code/local-llm/agent_runtime/service.py) と [AgentEvent](/Users/y.noguchi/Code/local-llm/agent_runtime/events.py) にID対応・開始中の通知保留・terminal処理がある。Eumenesへnative protocolを再実装しない。`message.completed`は一つのmessageの終了であり、最終回答やturn成功を意味しない。現行公開message契約に途中/最終の意味分類はないため、LARM経由でも分類の保証がなければunknownにする。

現在のEumenes [LarmPort](/Users/y.noguchi/Code/eumenes/api/domains/larm/contracts/index.ts) はModel/ASR/TTS用であり、外部coding Agent APIの接続portではない。本書でLARM coding接続を新設しない。LARM経路の試験は公開契約のfixture照合までとし、その本番統合とProvider processの停止証明は別工程の依存として残す。SSE切断・cancel受付・release受付からProvider process停止を推定しない。

## 5 最小限の追加契約

以下は実装する意味の契約。最終の型名・配置はD1で確定するが、意味と安全条件は変えない。新しい業務状態台帳は作らない。

### 5.1 発言と所属

messageイベントの既存executionId/generation/seq/payloadRef/payloadDigestを使い、許可された小さなmetadataを追加する。

| 事実 | 値・規則 |
| --- | --- |
| messageKind | commentary / final_answer / unknown。採用版の公開契約が保証した分類だけ設定する |
| classificationReason | explicit_contract / phase_not_provided / phase_unsupported / legacy_unknown。自由なProvider値は保存しない |
| contentPresence | nonempty / empty。空白だけの文章もempty。本文は別の非公開evidenceに置く |
| sourceTruncated | 正規化して保存する時点で本文を切ったか。既知ならboolean、旧証拠で確定不能ならunknown |
| sanitizedBytes / retainedBytes | 秘密除去後のUTF-8 byte数と、保存したUTF-8 byte数。生のProvider本文や除去前の全文は残さない |

本文の既存上限32,768はUTF-16 code unitによる上限であり、32,768 bytesとは呼ばない。上限を増やさず、surrogate pairを途中で切らないprefixを保存する。sanitizedBytes/retainedBytesはその前後で別途計測する。無効なUnicodeを公開messageとして受け取った場合は固定protocol異常codeにし、置換文字によって完全な原文保存を装わない。

本書の範囲で分類を保証する公開契約はない。CLI 0.155.1用adapterと旧v1投影はunknownだけを出し、commentary/final_answer/explicit_contractはschemaに予約するだけとする（後で追加するとprotocol更新が再び要るため）。adapterのcapability機構・明示分類を出すadapterは実装しない。受信JSONに想定外のphaseが付いても分類を有効にしない。分類を提供する契約の採用は、そのadapterを追加する別計画でレビューする。

監督へ渡す発言参照にもseqとkindを残す。予約値が将来届いても誤用しないよう、監督側の発言選択関数だけは全種別を扱い、純粋関数の単体試験で確認する。明示的なfinalがある場合はfinal参照と途中報告参照を別々に選ぶ。unknownの末尾発言は「最新の種別不明発言」であり、finalにはしない。空の明示finalも隠さずemptyとして残す。過去の途中報告を空finalの代わりに採用しない。

対象外・世代不一致・取消後の発言は監督入力と進捗報告に採用しない。停止照合に必要な運用事実は既存の取消処理で扱い、発言本文を新しい世代に移さない。

### 5.2 turn、process、証拠

| 事実 | 値・規則 |
| --- | --- |
| turnOutcome | unconfirmed / completed / failed / cancelled / conflict。直接CLIは明示turn.completed/turn.failedだけから確定。一般error、process終了、停止要求からterminalを作らない |
| terminalEventSeq | 正式なturn終端を採用したseq。unconfirmedはnull。矛盾する終端はconflictとして採用を保留 |
| process | 既存state / childrenStopped / exitCode / reasonを再利用。未起動停止、停止要求中、所有groupの停止確認、終了結果不明を区別して投影 |
| processStarted | true / false / unknown。所有workerが実際のspawnを確認したらtrue、CLI起動intent前の停止を確認できればfalse。起動intentだけが残る場合や旧情報不足はunknown。PIDを公開契約へ出さない |
| captureState | complete / incomplete / unknown。正規化済みイベントと保存証拠の採取・永続化・cursor・digestの完全性。元のProvider文章の全量保存という意味ではない |
| captureIssues | 部分行、行上限、保存上限、保存障害、欠番、digest不一致、不正な公開イベント構造を許可した固定codeで表現 |
| reportLimitations | source_truncated、legacy_source_unknown、classification_unknown、context_excerpt_truncated等。公開文章の損失・分類制約をcaptureIssuesとは別に表現 |
| observationCoverage | 採用済みeventSeq上限、読取り対象のseq範囲、未取得参照があるか。参照未取得を本文なしとしない |
| excerptTruncated | 監督文脈へ入れる抜粋の切詰め。sourceTruncatedとは独立 |

既存のturnFinishedは当面「正常turn終端を確認した」意味を維持し、失敗turnでtrueに変更しない。既存のevidenceCompleteはGit/continue等が利用する保守的な適格性gateとして維持し、今回の追加情報だけでfalseをtrueへ戻さない。失敗時にevidenceComplete=falseでもcaptureState=completeとなり得る。この違いをschema説明・報告・試験に固定する。

正常turn・停止・権限等とは別に、証拠の適格性gateが参照する値は既存のevidenceCompleteである。captureStateを代わりの成功gateにしない。captureIssuesに列挙した採取/保存/整合性障害はcaptureState=incompleteとし、既存の適格性をfalseへ落とす。実行失敗・非0終了の既存失効規則も維持する。一方、計画どおりに公開文章を切ったsourceTruncated、抜粋の省略、phase不提供、v1の元文章不明だけでは、evidenceCompleteやcaptureState=completeを変更しない。保存された範囲自体を検証できない旧証拠はcaptureState=unknownとし、必要な整合性照合ができなければ適格性を確定しない。

この区別により、長い報告でも正常な実行と成果物を独立に検証できる。ただし、切れた発言を全文証拠として使わず、エージェントの文章はどの場合も作業成功の証明にしない。

completed後にfailedが到着する等の矛盾は、最後の値で上書きしない。conflictを保存し、queued decisionと後続操作を失効させる。正式終端の内容をprocessの終了コードで置き換えない。workerの正常終了だけでも完了条件は成立しない。

### 5.3 報告の有無と作業の検証

報告状態は採用済みmessage metadataから導出し、別の永続台帳を作らない。

- 公開文章: nonempty_observed / empty_only / none_observed / not_fully_observed。
- 明示的最終回答: observed / missing / unidentifiable / not_fully_observed。
- missingを確定できるのは、最終回答を識別できる契約で、対象turnが終端し、イベント・参照を必要範囲まで確認した場合だけ。現行execではunidentifiable。
- none_observedとempty_onlyは成果物なし・作業失敗を意味しない。欠落した本文を想像して要約しない。
- 作業の検証結果は既存のchecks/review/conditionsMet/snapshot receiptから導出する。not_checked、確認済みpass、確認済みfail、結果不明を報告上区別する。エージェントの発言をチェック結果へ転記しない。

正常turn終端・process停止・必要証拠の適格性・snapshot・委任権限が揃えば、空報告でも既存のrun_checks等の工程へ進める。最終回答を識別できないことだけで工程を禁止しない。検証未実施は検証失敗と表示しない。

## 6 永続化、互換性、読取り接続

### 6.1 保存順序とprotocol

新しいmetadataとreceiptをstrict schemaで追加するため、runner protocolは`eumenes-coding/2`へ協調更新する。spec、probe、MCP引数、client/server、Git共有契約のversion利用箇所も列挙して更新する。旧serverとの混在は明示version不一致として新しい起動・継続・変更操作を拒否する。

各イベントは正規化本文とmetadataを永続化した後にreceiptのseqを進める。終端事実だけ先に公開しない。process_exitedを保存してから最終receiptを公開する既存順序を維持する。終端も証拠も同じcursor/digest検査の対象にする。

v1のspool、spec、receipt、metadata、DB内JSON、未完了decision/stepを消さない。v1専用readerを残し、閲覧・停止照合に必要な既存事実を読む。古い本文のdigestやspecDigestを新しい型に合わせて再計算しない。v1/v2の区別は既存spec versionを正本とし、v1の未知情報はlegacy_unknownで投影する。v1の過去発言を分類したり、切詰めなしと断定したりしない。

v1の扱いはD0で実測した未完了・継続価値のあるv1実行の有無で決める。本番の操作workerは未接続でavailable=falseのため、該当がなければ次段落の正常終端投影（A22前半）は実装せず、v1は閲覧・停止照合とcontinue拒否だけにする。該当があれば次段落を実装する。どちらを選んだかと実測値をD0の記録に残す。

v1のturn投影は保存された正常終端の根拠を残す。spec/receiptの実行・世代・digestが一致し、receipt.seqまでのイベント取込みと必要なpayloadDigestを検証でき、turnFinished=trueと`turn_finished / turn_completed`が対応し、errorイベント・矛盾終端がなければturnOutcome=completed、terminalEventSeq=該当seqとする。errorがある場合はturn.failedか一般errorか判別不能なのでunconfirmed、欠落/不一致もunconfirmedと固定理由で保留する。発言分類・元文章の切詰めはlegacy_unknownのまま。

このv1 completedとprocess停止、evidenceComplete、現在snapshot、権限、Workflow実行可否等の既存条件が成立すれば、移行後にrun_checks等の指定工程へ進める。旧decision/stepは再送せず、新しい観測から作る。captureStateは保存された正規化証拠の整合性を検証した範囲で決定し、元文章不明だけで正常な旧実行を不適格にしない。

coreのcontinue判定で読むprevious receiptもv1/v2 readerを明示して通し、strict schemaの一般例外で停滞させない。本書ではv1 sessionからのcontinueを自動・手動とも固定code `coding_legacy_continue_unsupported`で拒否する。通常のv2 session継続は従来の指定session契約を維持する。拒否時は既存の自由入力質問（escalate）を出さず、停止確認後に固定codeのholdとblocker報告にする。自由入力の回答は通常continueへ変換され、同じ拒否を繰り返すため。旧実行で追加編集が必要な場合の中止/新世代再開の選択は計画07が担当する。本書は失敗後の自動修復workerを追加しない。

更新時は新規着手を止め、旧workerの停止または終了を照合してからv2へ切り替える。v1実行の自動continue・不明な起動の再送はしない。停止が確認できなければ更新を保留する。v2 readerがv1実行のstop/readを扱えるfixtureを必須にする。稼働中workerの版を無断で差し替えない。

DBの初期migrationを編集せず、必要なら各domainのnamed migrationでJSON版の互換読取りを追加する。古いqueued decisionは変更操作を再送せずsupersededへ移す。旧観測の未知フィールドは成功値で埋めない。rollbackは新規着手無効化と対応するreaderでの閲覧・停止に限定し、v2 spoolをv1 executableで読む運用はしない。

### 6.2 監督へ渡す読取り

coding domainに採用済みイベントとreceiptを一緒に読む公開snapshot操作を用意する。上位domainがcodingのSQLやspoolを直接読まない。発言参照の選択は決定的に行い、LLMで分類しない。

1. transaction内の公開読取りで、対象task/authority/execution/generation、採用済みcursor、receipt、必要な参照を固定する。
2. transaction外でcoding.readEvidenceを通して、許可された参照を有界に読む。返されたdigestを固定したイベントと照合する。既存の読取りはoffset/limit 4〜65,536 bytes、UTF-8境界を再利用する。
3. writer transaction内でtask revision、authorityEpoch、executionGeneration、latest execution、意味のあるreceipt変化、参照digestを再確認する。取消・交代・終端変化なら古い観測を棄却して読み直す。heartbeat時刻だけで本文観測を捨てない。
4. observationの保存と必要なreport作成を既存の公開操作で行う。excerptだけでなく、分類・欠落・終端・証拠参照を必須文脈として渡す。

イベント取込みは既存の100件/256 KiB、20 batchでのQueue継続を再利用する。発言の文脈選択は最新の種別不明発言、最新の途中報告、明示finalを上限内で選び、選ばなかった文章があることを示す。evidenceRefs最大20件、excerpt最大16,000文字を維持する。本文の追加読取りは一観測最大4回のRPC・最大4参照・合計64 KiBを初期上限とし、残りはnot_fully_observedと参照で渡す。JSON契約が期待する公開textだけを扱い、reasoning、stderr、コマンドの生出力、Provider object全体を新たに保存しない。

read_evidenceのtruncatedは「保存された本文の範囲読取り」であり、元本文の切詰めを検出した値ではない。全区間の取得で解消できる抜粋と、失われていて再取得できないsourceを区別する。

範囲取得の完了は、同一payloadDigestについて取得区間を集約し、区間の和が`[0,totalBytes)`を覆ったことから判定する。現行truncatedはoffset非0でもtrueなので、最終chunkのtruncated=falseを待たない。最終chunkの取得だけでは先頭部分の欠落を解消しない。sourceTruncatedはcoverage完了でも変化しない。

coverageは一回の観測内で集約し、過去の観測の区間とは合算しない。最大約96 KiBになり得る本文を64 KiB枠で全量取得する必要はなく、常にnot_fully_observedとなることを許容する。必要箇所は別の有界inspect_moreでoffsetを指定して読めるが、それを過去と合算した「全量取得済み」とは表示しない。参照ごとのdigest/totalBytes/取得区間を既存Observation内に保存し、別のcoverage台帳は作らない。明示finalの存在や空/nonemptyがmetadataで確認済みなら、その事実は保持し、本文抜粋の未取得と区別する。

読取りを接続してもunavailableCodingWorkflow.available=falseとexecute拒否を残す。source未接続時はunavailable/unknownを返し、空文字列を「報告なし」の確定値にしない。registered checks/review/Git・隔離launcher・tokenizerを完成したことにはしない。

### 6.3 採用に失敗した観測も伝える

base.observeが欠番・digest不一致・protocol不一致で失敗すると、Workflow.observeへ到達せず、現行catchは`observationFailedInTransaction(db, taskId)`で失敗回数を数えるだけになる。理由も最後の正常cursorも残らないため、監督は「ネットワーク一時障害」と「回復不能な整合性障害」を区別できない。

既存の失敗カウンタ・monitoring_delayedのholdはそのまま使い、差分は次に限る。coding domainがエラーを固定した許可codeへ正規化する公開操作を持ち、catchはそのcodeと最後の正常cursor・対象execution/generation/authority・確認時刻を`observationFailedInTransaction`の追加引数として渡す。監督はこれをObservationへ観測障害の事実として保存し、7.3の診断入口に使う。自由な例外文字列、採用不能イベント、Provider本文を保存・採用しない。新しい失敗台帳は作らない。

applicationは正常な観測と観測障害を区別してsupervisionへ渡す。最後の正常snapshotに「その後の取込みが未確認/不完全」を付ける。古い本文を今回の新しい報告と表示しない。取消・世代交代が先行した障害も旧実行に属する事実としてのみ記録し、現在の世代のholdや報告を更新しない。一般の未分類障害はunknown固定codeとし、監視障害の既存ログ方針に従う。

## 7 監督の判断、途中報告、諦める条件

### 7.1 既存のgateを維持する

正常終端、process停止、証拠適格性、権限、現在snapshot、チェック、独立レビュー、Git receiptの条件を維持する。new turnOutcomeがunconfirmed/failed/cancelled/conflictの場合、最終回答があっても変更・continue・commit/push・finish_candidateを許可しない。

空回答はhostの実行失敗にせず、報告上の不足として扱う。正常終端とその他のgateが成立すれば、既存の完了条件を検証する。失敗後の成果物を新しい実行として修復・再検証する復旧workflowは本書に含めず、結果不明から自動編集へ飛ぶ経路を作らない。

読取りのinspect_moreは変更操作のStepReceiptと区別する。現在はvalidateReceiptに加え、applyDecisionのworkflow.available/policy検査、step準備のstepCurrent、workflow.executeにも依存する。observeInTransaction/currentのstopped/hold条件によって、異常状態ではモデル判断自体が起動・採用されない。検査を一箇所緩める方法では解消しない。

D3/D4で、監督contractsに読取り専用のObservationReadPortを定義し、applicationがcodingの公開操作へ接続する。入力はhostが固定したtask fence、対象execution/cursor、許可されたevidence参照と範囲。出力は観測または固定code付きunavailable/取得失敗とする。外部shell・変更・質問回答・Git操作をこのportに持たせない。正常経路のWorkflow.observeも同じreaderを使う。

モデルのinspect_moreはapplyDecision内で変更用available/policy検査より前に読取りintentへ分岐し、変更用StepIntent/StepReceipt/workflow.executeへ送らない。hostの異常診断はbase.observeの固定code付き失敗・process終了時の未確認turn・監視異常を入口とする。モデルを呼べないhold/未終端/available=false/tokenizer未接続でも、このhost入口から読取りを実行できる。

読取りintentと異常照合の予算予約をwriter内で保存し、transaction外の専用Queue handlerで実行する。handlerはgrantのread、参照所有権、対象の世代/権限、期限、容量、digestを検査するが、正常turn・停止済み・変更workerのavailable・チェック定義を前提にしない。結果採用には6.2のfence再検査を行う。監視異常の理由は結果と一緒に残し、読取り成功だけで正常turnや変更許可へ昇格させない。source自体が利用不能ならunavailableとして終了する。

変更用gateは元のまま残す。新しい事実がないtickでモデル呼出しを増やさず、追加読取りだけのために判定用LARMを占有しない。

### 7.2 進捗とユーザーへの説明

明示commentaryは途中報告として、unknownは「種別不明の公開発言」として監督の観測へ残す。文章が「完了しました」でも成功にしない。途中報告から業務上の進捗を断定せず、「エージェントから○○という報告を受けた」と確認範囲を示す。

新しく確認できた事実・未確認事項・次の確認条件を既存task-reportsのfacts/limitations/evidenceRefsへ投影する。毎回のモデル内部思考や生の本文を通常ログ・汎用APIへ出さない。監督への本文は非公開evidence契約を使う。

通常の報告間隔、重複排除、節目・終端・監視異常、会話配送の方針は計画03/04を維持する。この変更で5分間隔を黙って短縮しない。今回の契約は途中報告を意味付きで残せるようにするもので、発言ごとの会話通知を約束しない。新しいheartbeatだけを進捗として報告しない。

fingerprintには発言seq/分類、終端、processの意味状態、欠落、検証snapshotを含める。壁時計・再照会時刻・lease更新だけで新しい判断やlastProgressAt更新を起こさない。全体のeventSeq/cursorは所属・順序検査に残すが、heartbeatだけのseq更新を意味の変化にしない。

意味を比較するsemanticObservationDigestを一箇所に定義し、fingerprintと、2節に列挙した全observationのdigest比較5箇所（apply.tsのstep intent、decisions.tsの再観測、approval.tsの承認時保存と解決時比較、monitor.tsのstep失効、steps.tsの実行前比較）を置き換える。D4で`digest(s.observation)`の残存0件をgrepで確認する。

含めるもの: execution/generation/authority、意味のある発言seqと種別・contentPresence、正式終端、process停止状態、captureState/captureIssues、観測障害code、snapshot、質問、証拠参照のpayloadDigest。

含めないもの: 時刻・heartbeat位置・lease、observationCoverageの取得区間、抜粋本文とexcerptTruncated。抜粋とcoverageは同じpayloadDigestの本文をどこまで読んだかであり、意味の事実ではない。含めると、host診断やinspect_moreの読取りだけで、承認待ちのユーザー承認・queued decision・stepが失効する。

新しい発言・終端・停止・欠落・snapshotでは従来どおり失効させる。保存した生の観測範囲とfenceの順序検査は別に維持する。会話が続いても背景タスクの寿命を変更しない。

task-reportsのfacts上限6件/各300文字に投影する際は、失敗/未確認・停止状態・検証結果・欠落を優先し、抜粋量が増えてもこれらを黙って削らない。limitationsへ固定codeを渡し、詳細は参照可能な非公開観測に残す。自由文章のfactsだけを安全判定に使わない。

### 7.3 調査を続ける上限

既存の60秒観測、2回の観測失敗または150秒未成功によるmonitoring_delayed、判断30秒・最大回数・修正2回・同じblocker一回を維持する。進捗なし5分を自動killの根拠にしない。

追加の異常照合は「executionId/generation/authorityEpoch/異常code」をkeyに最大2回、同じexecutionId/generation/authorityEpochの全異常codeを通じた合計上限4回、一回の外部読取り期限5秒を計画値とする。成功した監視tickや再起動で回数を戻さず、同じ異常を新しいeventSeqだけで別物にしない。cursorの通常paging/Queue継続はこの異常再試行とは別。新たな終端・停止・digest確認が得られた場合だけ診断結果を更新する。

消費は読取りintent保存時にcode別・合計両方の枠を同じwriter transactionで予約し、失敗・timeout・crash・取消後も返却しない。handlerはmaxAttempts=1/recovery=interruptを使い、不明な実行をQueueの再試行で上限外に増やさない。通常の稼働監視やpagingにはこの診断枠を使わない。診断が止まっても、最後の不足情報と停止監視は残す。

code別2回または合計4回で解消しない、採取欠落が回復不能、矛盾終端、照合の根拠がない場合は、既存hold/reportに確認済み事実と制約を記録し、自動診断・修復を止める。単なるsource本文切詰めはこの回復不能異常の対象にしない。実行を勝手に再起動せず、未停止なら所有workerへの既存停止/lease処理を続ける。通常の稼働・停止監視はタスク期限まで既存の仕組みで継続し、停止未確認の台帳・worktreeを削除しない。

正式失敗/矛盾終端、process終了後のturn未確認、回復不能な整合性障害、legacy continue拒否で進めない場合は、**process停止確認済み かつ（診断上限到達 または 回復不能/続行非対応の確定）**で打ち切る。このとき既存の自由入力質問（escalate）は出さない。自由入力の回答は通常continueへ変換され、同じ失敗・拒否を繰り返すため。代わりに、固定codeのholdと、確認済み範囲・未検証範囲・権限・残予算を含むblocker報告を一回だけ作る。task/execution/generation/authorityと阻害状態をdedupe keyにし、異常codeが交互に変わっても同じ阻害状態では報告を重ねない。停止未確認の間は、不足報告と停止監視を続ける。

選択肢付きの復旧質問と、その回答による中止・新世代再開は[計画07](07-recovery-question.md)が担当する。計画07の実装までは、ユーザーは既存のtask取消で中止できる。

## 8 受入試験

各ケースで「渡す事実」「許可する次の行動」「禁止する行動」をassertする。期待文章の完全一致や実装と同形のテストだけで済ませない。exec fixtureはphase/turnIdなしを標準とする。commentary/finalの明示分類は本書の範囲でadapterが出さないため、A1/A2の明示分類部分は監督側の発言選択関数の単体試験だけで確認し、契約fixtureは作らない。

| ID・ケース | 監督へ渡す情報 | 次の行動・禁止事項 |
| --- | --- | --- |
| A1 途中報告だけで接続断 | execならunknown（選択関数の単体試験ではcommentaryを途中報告として扱う）。turn未確認、processは独立に観測、接続断をlimitationsへ | 照会・既存cursorで再取得・停止照合。報告をfinalや完了にしない。RPC取消をCLI停止にしない |
| A2 発言の後にturn.failed | 発言は保持（execはunknown、選択関数の単体試験では明示final）、正式失敗終端、process停止の確認状態、検証未実施/既存結果を別々に渡す | 読取り診断・停止照合・不足報告。finalで失敗を上書きせず、変更/Git/完了へ進まない |
| A3 process exit 0、正式turn終端なし | exit 0と停止確認は既知、turnOutcome=unconfirmed。報告分類は取得能力に従う | 有界照合後hold。正常turnを捏造せず、自動continue・再起動をしない |
| A4 turn.completed、回答空 | completed、実際のprocess停止、公開文章empty_only/none_observed。execのfinalはunidentifiable | 他のgateが成立すれば指定検証へ。空報告だけでfail_candidateにしない。成果物も別に確認 |
| A5 開始応答前に通知 | 対応未確認の情報は監督入力外。対応確定後に対象分だけ採用 | LARMは上流の保留/対応契約をfixtureで検査。execはstart RPC返却前の専用pipeイベントをimmutable spec所属で扱う。app-server用bufferを移植しない |
| A6 別実行・古い世代・取消後 | 採用外。停止照合に必要な事実だけ旧実行に残す | 現行fence/cursor検査で棄却。報告・判断・新しい成果物の成功根拠へ混ぜない |
| A7 phaseなし/null/未知/不正型 | unknownと固定理由code。exec0.155.1の想定外phaseもunknown | 口調・位置でfinalにしない。未知の分類だけで作業失敗にしない。message構造自体が壊れた場合は別のprotocol欠落として扱う |
| A8 33,000文字/UTF-8境界/抜粋上限 | sourceTruncatedとretainedBytes、抜粋のexcerptTruncated、再取得可能範囲を区別 | 失われたsourceを全量証拠としない。範囲読取りのtruncated解消だけでsource完全扱いにしない |
| A9 正式completed後にfailed/重複terminal | 同一内容の重複はdedupe、矛盾はconflict。decision失効 | 後着で成功へ戻さない。process終了だけでも矛盾を解消しない |
| A10 最終回答で成功宣言、チェック失敗 | エージェントの報告とhostの検証失敗を別に表示 | 完了/Gitを拒否。チェック削除・独立レビュー省略を許さない |
| A11 本文取得中の取消・世代交代・終端変化 | 読取りsnapshot不採用、旧参照を新しい観測に入れない | writerのfence再検査。二重判断・後続変更を作らない |
| A12 heartbeatだけ、新しい文章なし | lastObservedAtだけ更新。進捗・fingerprintは変化なし | 60 tickで不要なモデル呼出し0回。進捗報告を増やさない |
| A13 v1履歴・旧worker・更新中断 | 確認できる既存事実、legacy_unknown、source切詰め不明 | 閲覧・停止を維持。digest不変。version不一致で新規副作用を拒否 |
| A14 証拠参照が未取得・保存quota超過・欠番 | not_fully_observedまたはcapture不完全と理由。本文なしとは区別 | 保存障害でも所有group停止。参照がないことを正常な空報告にしない |
| A15 LARM message.completed・SSE切断・cancel受付 | message終了とturn終端・process停止を別に渡す | message完了をfinalにしない。上流のID/cursor/terminalを消費し、native state machineを二重実装しない |
| A16 再照合2回不成功・再起動 | 診断上限と未確認事項をhold/reportへ。消費回数保持 | 自動診断・修復を打ち切る。停止監視を維持。再起動で再試行予算を復活させない |
| A17 available=false・tokenizer未接続・hold中 | 読取りの取得結果またはsource unavailable。正常turnを要求しない | host診断とinspect_moreが変更用policy/executeに入らない。変更用execute呼出し0回 |
| A18 base.observeの欠番/digest不一致 | 最後の正常cursor、固定異常code、その後は未確認。採用不能イベントは入力外 | catchから読取り診断と不足報告へ到達。古い世代の障害で現在のholdを変更しない |
| A19 複数rangeで保存本文を取得 | 同一digestの区間coverage。64 KiB内の本文は最終chunkがtruncated=trueでも全区間で取得完了 | 先頭未取得を完了にしない。sourceTruncatedは保持。v1の約96 KiB本文は観測ごとにnot_fully_observedで、別観測のrangeを合算しない |
| A20 未起動停止・spawn intentだけ・起動後停止 | processStarted=false/unknown/trueと停止確認を別々に渡す | exitCode=nullだけで未起動と断定しない。旧receiptの不足はunknown |
| A21 heartbeat/cursor更新中のpending decision/step | semanticObservationDigest不変。新しい意味eventや終端では変化 | heartbeatだけでsupersededにしない。新しいfinal/失敗/停止/差分では従来どおり失効 |
| A21b 承認待ち中のhost診断・inspect_more | 抜粋・coverageだけ増え、意味digest不変 | pendingApprovalがexpired/再判断にならず、承認後に元の指示を適用。新しい発言・終端では従来どおり再判断 |
| A22 v1 completed/一般error/continue要求 | （6.1で正常終端投影を採用した場合）正常終端のevent/receipt/digest一致ではcompleted。error混在はunconfirmed。continue拒否は固定code | 投影採用時は実行環境等が成立するfixtureでrun_checks可能。どちらでも旧strict parse例外で停滞せず、continue拒否は停止確認後に固定codeのholdとblocker報告。自由入力質問を出さない |
| A23 長い公開発言と保存障害 | 40,000文字の発言はsourceTruncated=trueだが、正常保存ならcaptureState=complete、evidenceComplete不変。quota/欠番はincomplete | 長文・legacy_source_unknownだけでrun_checksを禁止しない。保存障害はgate拒否。作業成功は常に別証拠 |
| A24 診断打切り | 停止確認と上限/回復不能確定を根拠に固定codeのholdとblocker報告一件。確認済み/未検証範囲・権限・残予算を含む | escalateの自由入力質問0件、continue/prepare 0回。同じ阻害状態・交互の異常codeで報告を重ねない。未停止なら打ち切らず停止監視を継続。質問・回答は計画07のR1〜R5 |
| A25 異常code交代と予算 | code別2回、実行/世代/権限ごと合計4回、再起動後も保持 | 欠番/digest不一致が交互に届いても合計4回以下。Queue crash/retryで枠を復活させない |

fixtureは一時DB/spool、fake clock、fixture process、公開契約のmockを使う。通常のCLI session、製品DB、認証、実remoteを流用しない。Provider公開契約との互換性をfixtureだけで証明したことにはしない。

## 9 実装工程・変更対象・検証

| 工程 | 変更対象・作業 | 完了条件 |
| --- | --- | --- |
| D0 ベースライン | 対象差分/digest、installed CLI、上流契約、既存fixtureの結果を採取。開発・利用中DBとspoolのv1実行件数と未完了数。`digest(s.observation)`の利用箇所 | 実装前の形式・既存挙動と本書との差分が説明できる。6.1のv1正常終端投影の採否を記録 |
| D1 型と互換性 | runner contracts/client/server/core、codingとsupervision contracts/repository。v2/旧JSON読取り、検査表を確定 | 不明・失敗・欠落を表現し、旧閲覧/停止・（採用時）正常終端投影・固定continue拒否とstrict version拒否を先に通す |
| D2 正規化と永続化 | decoder/worker、event/receipt投影。UTF-8/切詰め/正式terminal/採取欠落 | A1〜A9/A13/A14をrunner・codingで確認。保存順序とprocess停止の既存fixtureを維持 |
| D3 読取り接続 | codingの公開snapshot/観測障害codeの正規化、applicationの正常経路とcatchから`observationFailedInTransaction`への固定code・cursor受渡し、ObservationReadPort。容量・digest・fence再検査 | 空のfallbackと未取得を区別し、A11/A14/A17〜A20。available=falseとexecute拒否を維持 |
| D4 判断・報告・打切り | supervisionのobservation/policy/prompt/意味digest（5箇所の置換）/report。有界読取りhandlerと診断消費、打切りhold・blocker報告のdedupe | A2〜A4/A10/A12/A16/A17/A21/A21b/A22〜A25。`digest(s.observation)`残存0件。通常CLI入力/承認/取消/開始の回帰も確認。報告が成功条件を変えず、同じ事実で不要な推論・通知が増えない |
| D5 回帰と運用 | coding-runner.md、coding-supervision.md、計画02/03/04の差分、fixture検証記録 | 下記domain gateとverify:all。実装済み/検証済み/未接続を分けた記録 |
| D6 live | 計画02の隔離・認証・本番接続が受入済みの環境に限り、固定版の実出力と停止を確認 | 実出力とmetadata/監督入力/報告が一致。別のlive記録。未配備なら未実施を明記 |

D1〜D4の各工程終了時に、確認できたこと・残る不明点・次工程を短く報告する。複数ラウンドになるレビュー/調査も、一度の回答をタスク完了と混同せず、継続前に状況を伝える。

検証コマンド:

```sh
bun test packages/coding-runner/test
bun run verify -- --domain coding
bun run verify -- --domain coding-supervision
bun run verify -- --domain task-reports
bun run verify:all
```

application結合試験は `api/application/coding-supervision.test.ts` 、`api/application/delegated-tasks.test.ts`、`api/application/coding-tasks.test.ts` とcodingの既存結合試験を利用する。本書はtasks domainを変更しない（変更が必要になれば計画07の範囲かを先に判断する）。公開DTO/clientを変更した場合はその利用側も実行する。inference/LARMの公開契約・依存を変更した場合だけ、そのdomain verifyを追加する。新しいlive専用コマンドが未登録なら既存コマンドがあると記載せず、D6で登録方法と実行条件を別途確定する。

プロトコル/移行/取消/保存順序の必須fixture不合格、未処置の重大なモデルレビュー指摘があれば次工程へ進めない。full gate失敗は変更由来と既存baseline由来を分けて記録し、未実施・失敗をpassとして扱わない。live依存が満たされなくてもfixture工程までの実装は可能だが、production拒否を解除しない。

## 10 範囲外と実装開始前のレビュー

本書はLARM Provider adapter、Codex app-server移行、新しいCLI、認証/課金設定、隔離launcher、チェック/Git worker全体、会話配送/音声/UIの新機能を実装しない。公開契約だけを読み、生Provider応答・内部思考の保存へ広げない。既存の別Codexチャットへメッセージを送らない。

Opus 5.5とAstraには本書だけでなく、指定の現行コード、参考wire/test、LARM公開契約を提示する。別モデルの結論を無条件に採用せず、場所・条件・影響・受入ケースで再確認する。名前付きモデルが利用できなければ未実施とし、別モデルを同じ名前のレビューとして扱わない。

レビューで確認する事項:

1. 既存機能の再提案（承認ゲート・観測失敗カウンタを含む）、LARMとの責務重複、下位domainから上位への依存がないか。
2. execで得られないphase/turnIdを前提にした箇所がないか。
3. turn正常終了/失敗終端/未確認と、process停止、報告の有無、検証の失敗が独立しているか。
4. 空回答・unknown分類でも成果物確認が可能で、失敗/欠落時のGit gateが緩まないか。
5. 読取りの上限・取消競合・fingerprint・移行・打切り条件が実装可能か。
6. 意味digestから抜粋・coverageを除いても、新しい事実で承認・decision・stepが失効するか。
7. 上記A1〜A25を通しても、参考元の一時thread・無人質問処理や生出力保存を持ち込んでいないか。

2026-10-10午後の改訂（0節・2節・5.1・6.1・6.3・7.2・7.3・8節・9節と計画07の分離）は、前回の最終レビュー版digest `40609a62…`以降の変更であり未レビュー。改訂差分と、承認ゲート関連コード（approval.ts、queries.ts、application/coding-supervision.ts、tasks/service/progress.ts）を提示して再レビューする。

必須修正は計画へ反映し、採用しない指摘には根拠を残す。レビュー済みの最終版digestとモデル実行の成否を記録する。重大・中の未処置指摘0件、軽微指摘も処置・採否記録済みを実装開始の条件にするが、将来の不具合がないことを保証したとは記載しない。
