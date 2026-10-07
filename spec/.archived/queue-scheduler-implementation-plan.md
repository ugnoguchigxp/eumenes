# Queue・Scheduler 実装計画

作成日: 2026-10-07（Asia/Tokyo）
対象: Eumenes `/Users/y.noguchi/Code/eumenes`
状態: 実装前。本文の設計と初期値は本計画の採用案であり、稼働・検証済みを意味しない。
読者: Claude等、この会話を読まずに実装を引き継ぐエージェント。

## 1. 依頼と判断の前提

Eumenesの同一リポジトリ内に、汎用の`queue`と`scheduler`を独立ドメインとして実装する。別リポジトリ、別DB、独立したキューサーバーにはしない。Bun backendが所有する既存SQLiteと単一Writerを共有し、各ドメインは公開契約で接続する。

製品構想の正本は[ SAAAの全体コンセプト ](https://chatgpt.com/space/page_9fc5877949748191b556705128f6a2f5)。本計画はその実装契約であり、コンセプトの複製・変更ではない。特に第2章の所有境界、第3章の実行と通知の分離、第4章の会話優先、第6・7章の継続処理、第12章の有限jobによる背景整理を踏まえる。

EumenesはTypeScript主体の常駐Personal AIを目指す。現在の音声対話の後に、Memory、Personal World、委任仕事、ツールチェーン、自己改善を接続する。これらが共通して必要とする永続受付、待機、実行、取消、復旧を先に成立させる。将来機能の全実装を今回の完成条件にはしない。

### 実装者への開始指示

1. 現在のユーザー指示、適用される`AGENTS.md`、本計画を読む。`initial_instructions` MCPが利用可能なら会話で未実行のとき一度だけ実行する。利用不可ならその事実を記録し、本文の契約から進める。
2. 作業中変更と実装の現状を確認する。調査時のcheckoutには`.git`がなかったため、Git管理を前提にしない。Gitがある場合も既存差分を上書きしない。
3. 第3節のファイルを読み直し、第12節のP0から順に進む。ファイル名が変わっていれば責務で追跡する。
4. 通常の実装上の細部は本文と既存構成に合わせて判断する。完了後は実装範囲、実行した検証、未検証事項を記録する。
5. 別Codexチャットへの送信、worktree作成、commit、push、公開はこの計画から許可されたと解釈しない。SAAAリポジトリは参照専用とする。

成果物・実装記録は`spec/`へ置く。`docs/`を再作成しない。製品コード実装はこの計画を使う次の作業で行い、計画書の作成だけで実装済みにしない。

## 2. 今回の範囲と完成形

### 実装するもの

- `queue`: 永続Job、実行試行、原子的claim、重複防止、容量制限、実行枠、有限再試行、期限、取消、復旧、参照API。
- `scheduler`: 一回予約、固定間隔、発火履歴、停止・再開、期限超過方針、重複発火防止、Queueへの原子的登録。
- 時刻・ID・待機・起床を注入できる実行ループ。通知欠落時の再確認、終了時のdrain。
- 最初の本番利用者として既存`dialogue`を接続し、文字入力とASR確定文字列のLLM処理を共通Queueで実行する。
- ユーザーが明示登録する予約対話を一回・周期実行の実利用経路とする。保存済みプロンプトから対話runを作り、結果は通常の履歴へ保存する。自動音声再生はしない。
- Hono APIと型付きclientによる予約作成・照会・停止・再開・取消、Job/試行の照会。新規の管理画面とCLIの予約コマンドは後続。
- ドメイン境界検査への登録、隔離SQLiteでの単体・契約・結合・復旧試験。

### 今回に含めないもの

- Redis、PostgreSQL、外部Queue、分散worker、別プロセスから製品DBへ接続する実装。
- 任意JavaScript、shell、URLを登録して実行する仕組み。登録済みの型付きhandler/targetだけを扱う。
- Goal/Task全体の計画、一般DAGエンジン、Memory/World本体、通知outbox、状況推定、自己改善本体。
- Cron式、RRULE、タイムゾーン付き毎朝指定、カレンダー同期。固定24時間間隔を「現地時刻の毎朝」と表示しない。
- 生PCM、ASR partial、録音ファイルの永続Queue化。TTS合成・再生の全面移行。
- SAAAの旧Qwen/Ornith二段構成、5 Provider構成、Rust/Tauriの移植。
- 全体リファクタリング、認証方式の変更、本番DBのコピー・初期化、既存Provider設定の変更。

定期処理はbackendプロセスが起動している間に動く。端末のsleepやbackend停止中の時刻どおりの実行は保証しない。復帰後に第8節の規則で追いつく。OSによる常駐起動の設定は別工程とする。

## 3. 調査時点の現状と変更箇所

以下は2026-10-07に確認した状態。実装開始時に再確認する。

| ファイル | 現状 | 必要な変更 |
| --- | --- | --- |
| `api/infrastructure/sqlite/index.ts` | flockによる単一Writer所有、WAL、書込64件上限、同期transaction callback | この所有方式を維持。Job実行中にtransactionを保持しない |
| `api/application/server.ts` | migrationは配列順の番号。dialogue/voice復旧後に起動 | 既存migration末尾への追加、handler登録、復旧、ループ起動、終了順序を組み立てる |
| `api/domains/dialogue/service/index.ts` | run保存後に`void process(runId)`。activeはメモリMap | 即時実行をQueueへ置換。回答採用・取消の業務判断を維持 |
| `api/domains/dialogue/repository/index.ts` | run台帳、revision条件付き遷移。起動時に未完了を一律interrupted | Jobとrunの対照復旧、原子的な状態更新。既存SQLの所有は維持 |
| `api/domains/conversation/service/index.ts` | `appendInTransaction`と`messagesInTransaction`を公開 | 既存の同一transaction内操作を利用。必要なら入力までの履歴取得契約を追加 |
| `api/domains/voice-dialogue/service/index.ts` | ASR→dialogue→TTS。dialogueを500ms間隔・最大60秒待機 | Queue待ちを考慮した待機期限と取消整合。起動復旧で古い音声runを再生させない |
| `api/application/app.ts` | 共通認証・Origin検証、各controller登録 | 同じ認証下へ新controller追加。エラー分類を追加 |
| `client/` | transportとドメイン別client | queue/scheduler client追加。backend専用型をbrowserへ流さない |
| `scripts/domains.ts`・`scripts/boundaries.ts` | ドメイン依存と公開入口の検査 | queue/scheduler追加、実際の依存を明記、循環検出を確認 |
| `scripts/verify.ts`・`scripts/test-domain.ts` | ドメイン別lint・型検査・テスト、全体gate | 新ドメインを同じ経路で検証。`--affected`は現在未実装 |

注意: 現在の`closure()`は循環を再帰途中で止めないため、依存を追加する前にvisited/visitingを使う循環検出へ修正し、循環fixtureで確認する。これは新ドメインの境界保証に必要な範囲の変更とする。

## 4. ドメインと依存方向

| 所有者 | 所有する状態・判断 | 所有しないもの |
| --- | --- | --- |
| queue | Job、attempt、claim owner、lease、実行枠、待機理由、再試行時刻 | 会話本文、モデル選択、ユーザー目標、通知の判断 |
| scheduler | 予約定義、予約revision、次回時刻、occurrence、停止・再開 | 処理の業務内容、Jobの実行結果、任意の権限付与 |
| dialogue | 入力・履歴組立て、回答採用、run、予約対話target | 共通QueueのSQL・lease・定期タイマー |
| voice-dialogue | 音声セッション、ASR/TTSの調停、音声世代と割込み | Jobの再試行アルゴリズム、汎用Scheduler |
| application | 依存注入、handler/target登録、起動と終了 | 回答採用や予約対話の変換ロジック |

依存は`scheduler → queue`、`dialogue → conversation / larm / queue / schedulerの公開契約`、`voice-dialogue → audio / larm / dialogue`とする。QueueはSchedulerも業務ドメインもimportしない。SchedulerはDialogueをimportしない。DialogueがSchedulerのtarget契約を実装し、applicationがSchedulerへ登録する。

`scripts/domains.ts`ではcontractsへの依存も明示する。Queue単独検証はDialogue/LARMを取り込まず、Scheduler単独検証はQueueとテスト用targetだけで完結する。

```text
api/domains/
  queue/
    contracts/index.ts       # browserから参照可能なschemaとDTO
    service/index.ts         # 公開操作
    service/runner.ts        # claim、実行枠、lease、wake、drain
    service/registry.ts      # 型付きhandler登録
    repository/index.ts     # SQLと追加migration
    types/index.ts           # backend専用handler/transaction契約
    controller/index.ts
    test/
    index.ts                 # backend公開入口
  scheduler/
    contracts/index.ts
    service/index.ts
    service/clock.ts         # due計算。純粋関数中心
    service/runner.ts
    repository/index.ts
    types/index.ts           # target adapter契約
    controller/index.ts
    test/
    index.ts
```

ファイル名は責務が維持されれば調整可能。不要な空ディレクトリ・class・共通frameworkを作らない。backend専用target契約がSQLite型を含むなら`types`からbackend公開入口へexportし、browser用`contracts`へ置かない。

## 5. 不変条件

1. **受付はcommitで成立する。** 業務入力・run・Jobのいずれかだけが保存される状態を作らない。満杯時は全体をrollbackして明示拒否する。
2. **SQLiteだけが永続状態の正本。** メモリのMap、タイマー、wake通知、UI cacheは正本ではない。
3. **Jobの成功は業務更新と同時に確定する。** 回答保存が失敗・不採用ならJobだけcompletedにしない。
4. **所有権と世代を検査する。** Job ID、owner、attempt番号、generation、lease期限を検査し、遅着結果を採用しない。
5. **実行を厳密に一度だけと保証しない。** 再実行が起こり得る前提で入力を重複排除し、保存・外部操作を冪等にする。外部副作用の結果不明は自動再試行しない。
6. **取消と停止確認を分ける。** abort要求だけで外部実行の停止を証明しない。取消後の回答は不採用とし、実行枠は実際の終了まで解放しない。
7. **予約の発火とJob実行を分ける。** 予約がdispatchedでもJobや依頼の完了ではない。
8. **時刻・Scopeは認可ではない。** handler/targetが受付時と実行直前に現在の入力版・設定・利用条件を確認する。Queueへ入れることで権限を増やさない。
9. **会話優先と背景の継続を両立する。** 新規会話で無関係な仕事を取消しない。背景処理は安全な境界で譲り、途中状態は所有ドメインが保存する。
10. **無材料時はLLM呼出しゼロ。** ポーリング自体に推論を使わない。再試行・時刻到来・設定された確認がなければ待機する。

## 6. Queueの保存・公開契約

### 6.1 データモデル

`queue_jobs`に最低限、以下を持たせる。日時はUTC epoch millisecondsのINTEGER。公開APIの表示用ISO文字列と混在させない。

| 分類 | カラム案 |
| --- | --- |
| 同一性 | `id`, `scope`, `kind`, `payload_version`, `dedupe_key`, `payload_json`, `input_digest`, `generation` |
| 業務への参照 | `subject_ref`（例: dialogue run ID）, `parent_job_id`（任意。一般DAGは作らない） |
| 実行制御 | `lane`, `resource_key`, `concurrency_key`, `state`, `available_at_ms`, `deadline_at_ms`, `max_attempts`, `retry_policy_version` |
| 所有 | `owner`, `attempt`, `lease_until_ms`, `cancel_requested_at_ms` |
| 結果・待機 | `wait_reason`, `error_code`, `result_ref`, `recovery_policy` |
| 履歴 | `created_seq`（安定FIFO順）, `created_at_ms`, `updated_at_ms`, `revision` |

`UNIQUE(scope, kind, dedupe_key)`を設ける。同じkey・同じ正規化済み入力なら既存Jobを返し、異なる入力なら409相当の競合。同じkeyの自動再送で新Jobを作らない。新しい業務実行には新keyを使う。generationは既存実行の失効用であり、重複排除を迂回する番号にしない。

比較対象はschemaで検証・正規化したpayload、payload版、対象、実行条件。JSON key順の差を内容差と扱わない。秘密・本文を通常ログへ出さない。payloadは原則参照中心、最大16KiB。会話本文はmessages/run側に保存し二重正本にしない。

`queue_attempts`: `job_id`, `attempt`, `owner`, `started_at_ms`, `ended_at_ms`, `outcome`, `error_code`。`UNIQUE(job_id, attempt)`。取消や障害の監査は最新Job上書きだけにしない。schemaに状態CHECK、必要な外部キー、ready取得・scope一覧・実行枠照会のindexを作る。

初版では終端Job・dedupe情報・occurrenceを自動削除しない。ページングと件数・DB容量の確認手段を設ける。将来の保持期間導入では、削除により古い受付が再実行されない契約を別途定める。

### 6.2 状態遷移

| 状態 | 意味・遷移 |
| --- | --- |
| `queued` | available_at以降に実行可。claimでrunning、取消でcancelled、期限切れでexpired |
| `running` | ownerが実行中。成功completed、再試行retry_wait、恒久失敗failed、取消要求cancel_requested |
| `retry_wait` | 上限内の一時失敗。available_at到来で再claim。待機中にworker枠を持たない |
| `cancel_requested` | 新たな成果採用を禁止。終了確認でcancelled。不明ならoutcome_unknown |
| `completed` / `failed` / `cancelled` / `expired` / `interrupted` / `outcome_unknown` | 終端。通常claim対象へ戻さない |

資源不足はqueuedの`wait_reason=resource_busy`で表し、失敗attemptに数えない。Job実行中のdeadline到来はabortと採用禁止を行い、終了・不明を決着させてから終端化する。終端後の手動再実行は新keyと元Job参照を持つ別Jobとして所有ドメインから作る。

### 6.3 公開操作とhandler

公開操作の名前は調整可だが、次の意味を満たす。

- `enqueueInTransaction(tx, input)` / `enqueue(input)`
- `get(jobId)` / `list(filter, cursor, limit)` / `listAttempts(jobId)` / `stats()`
- `cancelInTransaction(tx, jobId, reason)` / `cancel(jobId, reason)`
- `registerHandler(definition)` / `start()` / `wake()` / `recover()` / `close(deadline)`

`claim`、lease更新、実行結果のsettleはrunner内部用。HTTPで公開しない。外部向け汎用enqueue APIも初版では公開せず、業務受付または登録済みScheduler targetから登録する。

handlerはkindとpayload schema/版、実行資源、再試行分類、復旧方針を登録する。処理は以下の三段階に分ける。

1. `prepareInTransaction(tx, claim)`: 業務版を検査し、必要な業務状態を更新して実行入力を取り出す。同期処理のみ。
2. `execute(input, { signal, jobId, attempt, generation })`: transaction外で推論・network等を実行し、結果を返す。
3. `settleInTransaction(tx, claim, outcome)`: Queueの所有検査と同一transaction内で業務結果・業務状態を確定する。

handlerを呼ぶ技術的な仕組みはQueueが持つが、callback内の業務SQLは所有ドメインのrepositoryだけが実行する。callbackから`store.write()`を再入せず、`async`callbackも受け付けない。`applied / stale`など明示結果で扱い、`null/false`を無視して完了へ進めない。古い結果は成果保存をrollbackまたは実施せず、現在の取消・終端を保持する。業務更新で例外ならQueue完了もrollbackする。

受付・成功・失敗・再試行・取消・復旧のすべてで、業務runとJobの整合をこの契約で保つ。複数件完了で下流Jobが必要な場合は、所有側callbackが公開`enqueueInTransaction`を使い同時に確定する。

## 7. Queue runner・実行枠・復旧

### claimとwake

同じWriter transactionでready候補選択、資源枠とconcurrency keyの確認、条件付きclaim、attempt作成を行う。実行中・cancel_requestedで同じ`concurrency_key`を持つJobは重ねない。初版のlaneは`interactive`と`background`。同一lane内はavailable_at、created_seqで安定順序にする。再試行上限とpolicy版はenqueue時に保存し、再起動時の設定変更で回数がリセットされないようにする。

同一会話のconcurrency keyには順序保証も適用する。先に受理した未終端Jobがqueued/retry_waitでも後続は追い越さない。lane優先は別のconcurrency key間に適用し、先行予約対話を同じ会話の後続入力が追い越すことは許可しない。このための待ちも観測できるようにする。期限切れの先行Jobは先に決着させ、永久に後続を塞がない。

commit後にwakeする。待機登録→DB再確認→必要なら待機の順を定め、確認と待機の隙間の通知欠落を防ぐ。通知を落としても起動時走査と最大1秒の補助再確認で進む。次のavailable_at/deadlineを考慮して待ち、空Queueでbusy loopにしない。タイマーだけでJobの存在を表さない。

### 実行枠と初期設定

以下は初期運用値。設定はschema検証し、テストでは短縮する。実測前に性能保証として扱わない。

| 項目 | 初期値・方針 |
| --- | --- |
| 未完了Job | 全体1,024、background最大768、scope最大128。cancel_requestedも数える |
| 予約定義 | active/paused合計256 |
| LLM資源枠 | `larm.llm`全体1。会話と予約対話で共有 |
| 同一会話 | `conversation:<id>`で1件 |
| lease / heartbeat | 30秒 / 10秒。更新失敗で成果採用を止める |
| retry | handlerで明示許可した失敗のみ。既定maxAttempts=1（初回を含む）、上限3 |
| backoff | 初期1秒、指数増加、最大30秒、jitter注入可能。deadline/attempt上限で終了 |
| 対話の全体期限 | 受付から180秒を初期案。既存LARM内部timeoutとは別 |
| 終了drain | 10秒。その後は採用権を失効し、復旧可能な状態を残す |

interactiveを次回claimで優先する。backgroundは実行可能で前景需要がないときに進め、最古待機を計測する。高優先度だけで長期飢餓を隠さない。前景が連続している間の背景進捗保証はしない。

実行中backgroundの強制プリエンプションは初版で一般化しない。短い有限Jobに分ける責任は所有ドメインに置く。対応handlerに限り協調的yieldを追加できるが、abortを送っただけで資源枠を再利用しない。予約対話も実行中はLARMの実行期限まで枠を占有し得るため、前景の最大待ちを測定・報告する。

### 復旧

同じプロセスでleaseが切れた場合、旧handlerへabortし、owner/attemptを失効させる。ただし実際のPromiseが未決着なら同じ資源枠で次を開始しない。停止不明を単なる空き枠として扱わない。プロセス再起動でも外部サービス側の処理停止までは証明されない。

handlerごとに`replay_safe`または`interrupt`を宣言し、既定はinterrupt。replay_safeでもattempt・deadline上限を越えて再開しない。外部副作用を伴うhandlerは今回登録しない。将来対応では操作IDと照会による照合が必要で、結果不明の無条件再送を禁止する。

- 保存済みqueued/retry_waitは有効性確認後に継続可能。
- runningは復旧方針に従い再試行待ち、interrupted、outcome_unknownへ遷移。旧ownerの完了は拒否する。
- cancel_requestedは再実行しない。業務的な採用停止と外部結果の不明を記録する。
- 未登録kind・未対応payload版は明示失敗とし、黙って捨てたり無限再試行しない。
- 容量不足・Writer満杯で状態確定できなければ新規claimを止め、書込み可能になるまで有限backoffで再確認する。エラーを握り潰して進捗を偽らない。

## 8. Schedulerの保存と時刻契約

### データモデル

`scheduler_schedules`: `id`, `request_id`, `input_digest`, `scope`, `target_kind`, `target_version`, `target_payload_json`, `state`, `revision`, `mode`, `anchor_at_ms`, `interval_ms`, `next_due_at_ms`, `misfire_policy`, `grace_ms`, `overlap_policy`, `created_at_ms`, `updated_at_ms`。

`request_id`を一意とし、作成再送は同入力なら同予約、異入力なら409。`state`はactive/paused/cancelled/completed。cancelledは再開不可、completedは一回予約の発火処理が決着した状態でありJob成功ではない。設定更新はrevision条件付きとする。

`scheduler_occurrences`: `id`, `schedule_id`, `schedule_revision`, `scheduled_at_ms`, `state`, `job_id`, `subject_ref`, `reason`, `created_at_ms`。`UNIQUE(schedule_id, schedule_revision, scheduled_at_ms)`。stateはdispatched/skipped。実行成否は参照先Job/runから取得し、occurrenceへ別の完了正本を作らない。

### 登録済みtargetによる発火

Schedulerは登録済みtarget adapterを使う。targetは入力schema、作成時検証、同期`materializeInTransaction(tx, occurrence)`を持ち、業務状態とQueue Jobを作成してIDを返す。Dialogueのtarget実装はDialogue内に置く。

一つのWriter transactionで予約のstate/revision/dueを再検査し、targetの業務保存、Queue登録、occurrence記録、next_due更新を行う。どれか失敗すれば全部rollback。commit後にQueueをwakeする。occurrenceだけ確定してJob作成が失われる構成にしない。登録targetへ任意のコード・URLを渡して実行しない。

### 時刻と取りこぼし

- `once`: 明示された一つのUTC時刻。APIはoffset付きISO入力を検証してepochへ変換し、offset無し日時を拒否する。
- `interval`: `anchor + n × interval_ms`の固定周期。intervalは1分以上、上限365日。前回完了時刻を基準にずらさない。UTCで計算し、ローカル暦やDSTの意味は持たせない。
- `misfire_policy=coalesce`を既定にする。複数周期を過ぎたら、最新の到来時刻について一件だけ作り、next_dueは現在より未来へ進める。過去全周期をループ登録しない。
- `misfire_policy=skip`は`grace_ms`（既定5分）を過ぎた発火をskippedとし、次回へ進める。一回予約ならcompleted。集約して飛ばした区間・件数を記録し、長期停止で履歴を無限生成しない。
- `overlap_policy=skip`を初版の唯一の方式にする。同予約の以前のJobが未終端なら当該回をskippedにし、次回へ進む。並列実行・後追い蓄積は初版では対応しない。
- Queue満杯はskipではない。予約をdueのまま保持し、理由を記録してbackoff。容量回復時点のmisfire規則で再判定する。
- clockが後退してもoccurrence一意性で再発火しない。前進・sleep復帰はmisfire規則に従う。日時計算のoverflowを検証する。
- pauseは以後の発火を停止する。resumeでは周期予約は未来の最初の周期へ進め、停止中分を実行しない。一回予約は元の時刻を維持してmisfire規則に従う。
- cancelは将来の発火を止める。既に登録されたJobは自動取消ししない。利用者は該当Job/runへ別途取消を要求できる。この違いをAPI説明と応答に明示する。

予定時刻、grace、misfire、予約版の更新はCASで行う。変更と発火が競合した場合は先にcommitした版に従い、古い版のtransactionは再検査で停止する。初版の更新操作はpause/resume/cancelに限定し、周期・本文の変更は旧予約取消と新規作成で扱う。

Schedulerは新規登録・resumeのwakeと次のdue時刻、最大1秒の補助再確認で起床する。一tickあたり最大32件。過去分を処理し尽くすまでWriterを占有しない。

## 9. Dialogue・Voiceへの接続

### 通常入力

`dialogue.submit()`の一transactionでユーザーメッセージ、run、`dialogue.generate` Jobを作り、commit後にwakeして202を返す。`void process()`経路は削除し、同じrunを新旧二経路で動かさない。requestIdとutteranceIdの重複防止を維持し、同じIDに異なる本文・会話が来た場合は409にする。

Job payloadはrun IDを中心にし、本文はrun/messageから解決する。`prepareInTransaction`でrunをrunningへ進め、実行に用いるrun revisionと対象runまでの履歴を取得する。run DTOにはJob参照とdeadlineを追加し、待機側が固定回数のpollingだけに依存しないようにする。

現在の「会話の全履歴を取得」だけでは、待機中に届いた後続入力が先の回答へ混ざる。初版は会話ごとのrun受付順序を保存し、対象より前のrunの入力と採用済み回答をrun順に組み、最後に対象runの入力を置く。先行runが未終端なら第7節の順序保証により待つ。失敗・取消runは保存済み入力だけを残し、存在しない回答を補わない。

例えばAの実行中にB/Cを受理した場合、AへB/Cを渡さず、BへはAの採用済み回答を渡しCを渡さない。Aの回答がBの入力より後に保存されてもBから除外しない。物理的なmessage保存時刻だけで履歴を切らない。必要ならrunに単調な受付sequenceを追加する。既存行はcreated_atと安定したtie-break順で移行し、同時刻を時刻文字列だけで比較しない。会話の表示順変更は今回の必須範囲にせず、モデルへ渡す履歴と保存原文を区別する。

回答保存、run completed、Job completed、attempt終了を同じtransactionで確定する。業務revisionとQueue所有権の両方を確認する。失敗・再試行時のrun状態はQueueのsettleと同時に更新し、retry_wait中は公開runをqueuedとして扱えるようにする。

cancelはrunを採用不可にする更新とQueue取消要求を同時にcommitしてからabortする。既存APIのcancelledは「今後この回答を採用しない」を維持し、外部推論の停止確認はJob/attemptに別記する。completed済みrunへのcancelは完了を消さない。

### 予約対話

登録target `dialogue.prompt`はconversationId、text、期限等をschema検証する。予約登録は明示的なHTTP操作だけとし、モデルが自動で予約を作るToolは今回実装しない。

発火時にoccurrence IDから安定したrequest IDを生成し、通常受付と同じ公開保存操作でrun/Jobを作成する。通常入力はinteractive、予約入力はbackgroundをホスト側で固定する。HTTP入力で任意の高優先度・resource keyを指定させない。

予約入力は発火した時点で履歴へ追加する。runに`source_kind=manual|voice|schedule`と`schedule_id/occurrence_id`の参照を持たせ、今ユーザーが発言した内容と区別できるDTOを返す。本文生成・LARM呼出し・回答採用をSchedulerに複製しない。

### 音声と再起動

ASR/TTSは既存の経路を維持し、ASR finalからのDialogue JobだけQueueへ接続する。生音声は永続化しない。音声セッション停止・世代変更は関連runだけを取り消し、他会話や予約を一律取消しない。

現在の60秒ポーリング待ちはQueue待機＋既存推論timeoutと整合しない。Dialogueのterminal待機を、DB再確認とAbortSignal・全体deadlineを持つ公開操作へまとめてVoiceが使う。CLIの`--wait`も180秒の初期run期限と整合させ、待機終了と取消確認を区別する。期限でVoiceを失敗にする際は関連runの取消も要求し、後から古い回答が採用されないようにする。

起動時はworker開始前に音声session/turnを復旧し、失効した音声turnに紐付くqueued/running runとJobも整合してinterrupted等へ進める。音声の残ったJobだけを再開しない。通常文字入力・予約のqueuedは継続、実行途中のDialogue Jobは初版`recovery_policy=interrupt`とする。既存のJob未導入runは従来どおりinterruptedにし、履歴から新Jobを自動生成しない。

## 10. HTTP・clientと観測

| 操作 | 初版API案 |
| --- | --- |
| Job照会 | `GET /api/jobs/:id`, `GET /api/jobs`, `GET /api/jobs/:id/attempts` |
| Job取消 | `POST /api/jobs/:id/cancel`。所有handlerの取消契約を必ず通す |
| 集計 | `GET /api/queue/status`。lane別待機・実行・失敗件数、最古待機、実行枠、最終走査時刻 |
| 予約作成・照会 | `POST /api/schedules`, `GET /api/schedules`, `GET /api/schedules/:id` |
| 予約操作 | `POST /api/schedules/:id/pause`, `/resume`, `/cancel`。expectedRevision必須 |
| 発火履歴 | `GET /api/schedules/:id/occurrences` |

認証・Origin・loopback契約は既存と同じ。一覧はcursor付き、既定50・最大100。入力不正400、認証401、存在なし404、ID内容衝突・revision競合409、Queue/Writer容量超過503。未知targetは400とし、資格情報・内部例外stackをレスポンスに含めない。

新clientは`client/queue.ts`と`client/scheduler.ts`から既存transportを利用する。API DTOのschemaは各ドメインcontractsから参照する。予約の状態とJobの結果、取消要求と停止確認を混同しない。

最低限、Job/occurrence/runのIDを相互に辿れるようにする。受付commit時間、受付からclaimまで、実行時間、最古待機、再試行回数、取消決着時間を取得できる記録を残す。ログ本文にプロンプトや資格情報を複製しない。専用監視サービス・グラフ画面は今回作らない。

## 11. migration・起動・終了

現在のmigrationは配列のindex+1がIDである。既存のconversation/dialogue/voice migrationの内容・順序を変更しない。Queue、Scheduler、Dialogue関連付け・受付sequence等は必要な順に新規migrationとして末尾へ追加する。公開exportも「既存migrationを書換え」ではなく追加分を区別する。migration方式全体の刷新はしない。

新規DBと、既存3 migration適用済みの隔離DBの両方を検証する。二度目の起動はno-op、途中失敗はtransaction rollback。履歴・設定を初期化しない。

起動順序:

1. 設定検証、Writer排他取得、migration。
2. Queue/Schedulerを未起動状態で作成。Dialogue/Voiceとhandler/targetを登録。
3. 業務側の旧run・音声失効処理、Queueの整合復旧、Schedulerのdue再計算。復旧全体が失敗したらworkerを開始せずエラーを報告する。
4. Queue/Schedulerを起動し、同じappへHTTP受付を接続する。重複startでループを増殖させない。

終了順序:

1. 新規HTTP受付・新規schedule発火・新規claimを停止。
2. Voice停止と実行中handlerへのabort。正常完了可能なtransactionを決着させる。
3. drain期限内でhandler Promiseの終了を待ち、Job/run/attemptを整合して保存。
4. 期限超過ならowner失効・interrupted/outcome_unknownを保存し、遅着callbackのDB書込みを遮断する。失効済みattemptに新規処理を重ねない。
5. LARMのcloseを含む外部終了処理にも期限を設ける。store.closeで残るWriter処理を完了し、接続を閉じ排他を解放する。

SIGINT/SIGTERMの二重受信は同じ終了処理へ合流する。終了中に新規runを受理したまま放置しない。復旧試験はisolated DBと子プロセスで行い、実行中のユーザーbackendを停止しない。

## 12. 実装順序と完了条件

### P0: ベースラインと契約の固定

- 第3節の現状を確認し、既存Dialogue/Voice/SQLite試験とAPIレスポンスを記録。
- `spec/queue-scheduler-progress.md`を作成し、各段階の状態、検証コマンド、既知の失敗を記録。
- 実装前の対話受付・開始時間をfake LARMで測る。実モデルの性能と混同しない。
- migration追加順、handler同期transaction契約、設定schemaを確定する。

完了: 既存状態と追加変更の区別が記録され、未知の既存失敗を新変更の成功で隠さない。

### P1: Queueの保存契約

- queueのcontracts/repository、migration、enqueue、dedupe、容量、claim、attempt、settle、cancelを実装。
- 新ドメインを検証設定へ登録し、循環検出を修正。
- 同期transaction callbackによる業務保存の原子性をfake所有ドメインで検証。

完了: 複数claim、同一ID再送、内容衝突、容量拒否、古いowner、callback例外でのrollback試験が成功。

### P2: Queue runner

- handler registry、wake、補助再確認、lease、資源枠、有限retry、deadline、closeを実装。
- FakeClockと制御可能なhandlerでlost wakeup・lease・取消・再試行・drainを検証。
- Queue単独テストにLARM・Dialogueを依存させない。

完了: 通知を落としても有限時間内に再開し、idleでhandlerを呼ばず、cancel未確認で枠を再利用しない。

### P3: Dialogue・Voice統合

- 直接process起動をQueueへ置換し、通常受付・取消・成功・失敗・復旧を原子的にする。
- 会話履歴の対象入力境界、同一会話順序、runとJobの対応を実装。
- VoiceとCLIの待機期限を整合し、音声session失効からJobへの復旧・取消を接続。
- server起動/終了を変更。

完了: 既存テキスト・音声fixtureが成功。二重回答ゼロ、後続入力の混入なし、取消後の遅着結果不採用、旧DB復旧成功。

### P4: Schedulerと予約対話

- 予約定義・occurrence・due計算・pause/resume/cancel・target registryを実装。
- Queue登録とoccurrence/next_due更新を同一transactionへ載せる。
- Dialogueの予約targetを登録し、一回/周期のbackend実行経路を通す。

完了: 仮想時刻で周期、停止・復帰、clock後退、重複tick、容量不足、overlap、版競合を再現でき、予約一回につき業務run/Jobが一件。

### P5: API・clientと操作契約

- 第10節のAPI、client、schema、エラー対応を実装。
- 認証、Origin、ページング、未知target、重複作成、revision競合の契約試験。
- 予約を登録→起動→履歴確認→pause/resume→cancelするAPI結合例を実装記録へ残す。

完了: ブラウザを開かずAPI/clientから利用可能。予約状態と実行結果を識別でき、内部handlerの直接呼出し口がない。

### P6: 障害・移行・統合受入

- transactionの前後、claim後、結果保存前後でプロセスを停止する隔離復旧試験。
- fake LARMで通常会話と背景予約の競合を測定し、前景待ちと背景滞留を記録。
- 新旧DB、認証、API/client、音声fixture、終了処理をまとめて検証。
- 実LARM・マイク・スピーカーの確認は環境がある場合だけ別記録。未実施をfixture成功で補わない。

完了: 第13節の必須ケースと対象gateが成功し、未確認の実機条件が明記される。P1だけを「Queue/Scheduler導入完了」としない。

## 13. 必須テストと検証コマンド

| 対象 | ケース | 期待結果 |
| --- | --- | --- |
| 受付 | 同じID同内容 / 同じID別内容 | 一件に収束 / 競合拒否。run・message・Jobの片保存なし |
| 容量 | Job満杯、Writer満杯 | 明示拒否。受理済みを消さず、Schedulerは復旧後に再判定 |
| claim | 同時wake、同じ資源・会話の複数候補 | ownerは一つ、資源上限・会話順序を維持 |
| 原子性 | 業務保存または下流enqueueが失敗 | 成功Job・片方だけの成果を残さない |
| 通知 | commit後のwake喪失、重複wake | 補助走査で再開、二重claim/回答なし |
| retry | 一時障害、恒久障害、未対応版 | 許可された一時障害だけ有限retry |
| 取消 | queued/running/完了直前、signal無視handler | 採用停止、遅着不採用、未終了の枠を再利用しない |
| lease | heartbeat失敗、旧ownerの遅着 | 旧結果不採用。生存旧実行と新実行を重ねない |
| 復旧 | queued/running/cancel_requested、旧DB未完了run | 方針どおり再開/中断。不明副作用を再送しない |
| 会話 | A実行中にB/C入力、同時刻の入力 | Aに後続入力が混ざらない。履歴選択順が決定的 |
| 音声 | TTS中の新発話、session停止、再起動 | capture継続、対象runだけ取消、古い音声再生なし |
| 時刻 | once/interval、未来、clock前進・後退 | 予定前実行なし、位相維持、二重発火なし |
| misfire | 長期停止、grace内外、coalesce/skip | 一件集約またはskip。過去分の無限蓄積なし |
| 予約操作 | tickとpause/cancel/resumeの競合 | commit順・revisionどおり。cancel済み予約は復活しない |
| overlap | 前回Jobがqueued/running/retry/cancel_requested | 新回はskip。既存Jobの状態を改変しない |
| 予約原子性 | materialize中の失敗、commit直後の応答喪失 | rollbackまたは同occurrenceへ収束。Job欠落/重複なし |
| API | 認証・Origin・不正payload・revision競合 | 対応status。許可されていないhandlerは起動不可 |
| shutdown | 長い推論、二重signal、DB close後の遅着 | drain期限内終了方針、遅着書込みなし、次回所有取得可能 |
| 境界 | Queue/Schedulerの単独型検査、意図的循環fixture | 不要業務依存なし、循環は明示エラーで停止 |

時間試験は実時間の長いsleepに依存させず、FakeClock、注入timer、手動resolveできるPromiseを使う。プロセス終了・Writer排他だけは短い子プロセス試験を使い、作成物をcleanupする。テストは外部モデル資格情報なしで成立させる。

現行スクリプトを使うコマンド（ルートで実行）:

```sh
# P0: 既存利用者の基準
bun run verify -- --domain dialogue
bun run verify -- --domain voice-dialogue

# P1/P2以降: scripts/domains.tsへ登録してから実行
bun run verify -- --domain queue
bun run verify -- --domain scheduler

# P3/P4以降: 依存元も必ず検証
bun run verify -- --domain conversation
bun run verify -- --domain dialogue
bun run verify -- --domain voice-dialogue

# 統合時: application/client/cli/scriptsの変更も含む
bun run verify:all

# 実環境が準備された場合のみ。必須fixtureの代わりにしない
bun run verify:live -- --domain larm
```

`--domain`は選択ドメインのテストを実行し、依存closure全体のテスト合格を保証しない。Queueだけの成功をDialogue/Voiceの成功として報告しない。`verify:all`は現状、Playwrightも呼ぶため、fixture/configの有無をP0で確認する。既存の不足・失敗は記録し、対象API結合試験を確実に実行する経路を用意する。全体gateが失敗したまま全体成功とは書かず、テスト削除・skip・チェック緩和で成功にしない。

現行`verify:live -- --domain larm`には`LARM_BASE_URL`、`LARM_CONTROL_TOKEN`、`EUMENES_LIVE_ASR_WAV`が必要で、録音ファイルによるASR/LLM/TTSの個別操作を確認する。Queue/Scheduler経由の統合試験、ブラウザの録音・再生、実際の割込み受入の代わりにはならない。

検証は同一workspaceで並行実行せず、現在のverify lockを尊重する。今回の変更に必要な試験を正規の検証経路へ登録し、意味のない全体build反復は行わない。

## 14. 引継ぎ・完成報告

実装者は`spec/queue-scheduler-progress.md`に以下を残す。

- P0〜P6の完了/未完了、実装した公開契約、追加migration順。
- 起動方法、API/clientの一回予約・周期予約・停止/取消の使用例。
- 実行した検証コマンド、実際に実行されたケース、成功・失敗・未実施。
- 前景遅延・背景待機の実測と未検証の性能条件。
- 新規DB/旧schema DBの結果、再起動・取消・drainの観測結果。
- 残る範囲: 暦時刻指定、Task Runtime、Memory/World接続、通知配送、一般的な協調yield、保持期間。

判断に迷う場合は第5節の不変条件と各台帳の所有を優先する。通常の命名やファイル分割は実装者が決めてよい。別DB/別サービス化、任意コード実行、外部副作用の自動再送、認証変更など本文の境界を変える必要が生じた場合は、理由と代案を具体化してユーザーへ相談する。

## 15. 参照資料

- [SAAAの全体コンセプト](https://chatgpt.com/space/page_9fc5877949748191b556705128f6a2f5): 製品方針の正本。
- 参照専用: `/Users/y.noguchi/Code/SAAA/docs/plans/eumenes-initial-prompt.md`: Eumenesの単一Writer・ドメイン・音声MVP契約。
- 参照専用: `/Users/y.noguchi/Code/SAAA/src-tauri/src/task_queue.rs`: 永続Jobとclaimの実装例。モデル名や会話固有分岐は移植しない。
- 参照専用: `/Users/y.noguchi/Code/SAAA/src-tauri/src/schedule/README.md`: dueと認可、発火と実行、通知保留の区別。
- Eumenesの実装入口は第3節。SAAA側の`docs`は参照先のパスであり、この作業で削除する対象ではない。
