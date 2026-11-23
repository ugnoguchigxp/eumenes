# 登録目標の実装手順と受入

2026年11月23日。Sol 6.2 max が担当する実装の順序と受入条件。対象は隣り合う `eumenes_agency` と `eumenes`。以下の「新設」は今回追加する入口を示す。目的・許可範囲・製品の合格条件は本家の設計、モデル入出力のフィールド名は Agency の判断契約を正本とする。各段の実行結果は検証記録から確認する。[本家の設計](registered-goal-autonomy-2026-11-23.md)・[Agency の判断契約](../../eumenes_agency/spec/goal-decision-contract-2026-11-23.md)・[実装・検証記録](verification/goal-autonomy-2026-11-23/README.md)

## 1. 着手順と作業の区切り

両リポジトリの `main` 作業ツリーを確認する。採用中の Agency は manifest の `adoptionSource` に未コミット差分を含む。手元の実装・配布物・既存変更を照合して始める。各段では、下表の試験に期待する観測を先に置き、実装・対象試験・差分確認まで行う。既存のモック用試験は旧契約の回帰に使う。[取込元とファイルハッシュ](../vendor/agency/manifest.json)

| 段 | 作業場所・入口 | その段で引き渡すもの | 完了の観測 |
| --- | --- | --- | --- |
| 1 | Agency。新設 `src/agenda/goal-step.ts` と既存 `src/agenda/index.ts`。 | `decideGoalStep`、入出力型、strict schema、提示参照の検証。 | `test/agenda/goal-step.test.ts`（新設）で4種類の応答と拒否理由を確認。通常 Agenda の発話・計画0回。[型と試験入力](../../eumenes_agency/spec/goal-decision-contract-2026-11-23.md) |
| 2 | Agency。`createGoalStore`、`goalMigrations`、`runtime/agenda/index.ts` と既存の設計生成。 | §2 の保存形式、同期の transaction 操作、設計書から採用する条件と旧形式の読取。 | `test/agenda/goal-progress.test.ts`（新設）で旧データの移行、条件の再送、競合時の片方だけの採用、完了と報告の同時 rollback を確認。[既存台帳](../../eumenes_agency/runtime/agenda/goal-store.ts)・[既存の設計生成](../../eumenes_agency/runtime/agenda/goal-design.ts) |
| 3 | Agency の pack → 本家の vendor → 本家のサービス組立・キュー。段1・2を取り込む。 | 配布物から新入口を呼び、目標を起点に判断・期限・復旧を動かす。 | `api/application/agency/goal-progress.test.ts`（新設）で、アクティブ会話なし・キュー満杯復帰・資料重複到着を通す。作業担当はこの段だけ固定応答にできる。[本家の組立](../api/application/server-services.ts)・[キューの型](../api/domains/queue/types/index.ts) |
| 4 | Agency の目標ツールと本家の会話・入力参照。段2で型を用意し、変更した配布物を再度取り込む。 | 一発話の登録・範囲付き許可、目標／計画参照の検査、質問の再開。 | `api/application/agency/goal-permission.test.ts`（新設）で発話再送時の目標・許可各1件、取消・別人・旧版で実作業0件を確認。[会話ツール](../../eumenes_agency/runtime/agenda/agenda-goals.ts)・[本家側の投影](../api/application/agency/always-on-goal-reply.ts) |
| 5 | 本家の tool-runtime、開発監督、Markdown、Webメモ、子担当。段3・4の台帳と許可を使う。 | §4 の所有者別入口、同じ受付IDの照会、登録済み実行先から返る版付きの結果。 | `api/application/work/goal-supervision.test.ts`（新設）で配送先なしの実行、受付応答喪失、別目標の照会拒否、許可外編集0件を確認。[監督の入口](../api/domains/development-supervision/task.ts) |
| 6 | 本家の成果検証・報告・忘却と、旧／新担当の切替。 | 現物で条件を検査し、部分達成を戻し、完了を一度配送する。 | `api/application/agency/goal-completion.test.ts`（新設）で終了0・出力不一致を未達とし、停止・旧結果・二重報告を検査。段1–5の回帰を再実行。[既存の忘却接続](../api/application/server-wiring.ts) |
| 7 | 本家の隔離した通常 API と実モデル・実行担当。 | §5 の試験と再現記録。 | **初回の実失敗→異なる試行→修正受付後に再起動→同じ仕事の差分を回収→独立検証→報告1件**を追加発話0件で通す。[受入用 README と検査器](verification/goal-autonomy-2026-11-23/check-readme.ts) |

段3で `bun scripts/pack.ts --out <作業用出力先>`、続いて `bun scripts/pack.ts --check <作成したtgz>` を実行する。新しい値 export は `requiredAgendaExports` と `requiredAgendaRuntimeExports` の該当側に加える。本家の取込手順で再生成した正規化 tgz、SHA-256、manifest の採用ソース、`package.json` の file 依存、`bun.lock` をそろえる。本家の試験はインストールしたパッケージを import する。段4のツール契約にも同じ手順を適用する。[pack の検査](../../eumenes_agency/scripts/pack.ts)・[正規化と検証](../vendor/agency/README.md)

## 2. 台帳・ID・transaction の契約

| 値 | 発行元・寿命 | 用途 |
| --- | --- | --- |
| `goalId / goalRevision` | 本家 Goals。改訂で版が変わる。 | 当初の条件と許可の境界。保存時の `ledger_scope` は実際の Goals スコープを使う。画面用に写したプロフィール名で上書きしない。 |
| `progressVersion` | GoalStore。初期値1、採用した状態変更または次の照会予約で加算。 | 推論・キュージョブの比較更新。重複した観測では加算0。 |
| `attemptId` | ホストが一つの手段を予約するときに発行する UUID。 | 新形式では `goal_work.id`。前回の受付が不明な間は次の試行を作らない。 |
| `dispatchId` | 同じ予約で一度だけ発行する UUID。 | 実行先への受付・照会のキー。監督の親の `runId` に渡す。旧 `WorkRequest.operationId` は操作名 `claude-code.request` を表す。 |
| `ownerWorkId / ownerRevision` | 実行先の台帳。受付後に得る。 | `dispatchId` と対応付ける。通知の到着順によらず、所有者・仕事・版を照合する。監督が発行する子作業の操作IDは内部で管理する。 |
| `reportId` | Goals の完了と同じ writer。 | 既存の `goalId:完了後revision` を再利用し、元の試行対象版も payload に保存する。 |

### 2.1 Agency の追加 migration

`agency-goals/0005-progress` を `agency-goals/0004-design-documents` の直後に加える。下記は保存形式の基準 SQL。既存の `goal_work` の principal 単位の一意索引は、旧・新両方の物理実行枠に効く。旧ホストの `workRows`・`activePermit`・報告一覧は `mode='mock'` で絞ってから旧型としてデコードする。新ルートは `mode='goal'` で照合する。[元の migration と読取](../../eumenes_agency/runtime/agenda/goal-store.ts)

```sql
CREATE TABLE goal_progress (
  principal TEXT NOT NULL, goal_id TEXT NOT NULL REFERENCES goals_ledger(id) ON DELETE CASCADE,
  goal_revision INTEGER NOT NULL, ledger_scope TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('mock','goal')),
  progress_version INTEGER NOT NULL CHECK(progress_version >= 1),
  phase TEXT NOT NULL CHECK(phase IN ('ready','dispatch','observing','waiting','needs_user','verifying','completed','withdrawn','superseded')),
  current_work_id TEXT, delivery_conversation_id TEXT, job_id TEXT, due_at_ms INTEGER,
  needs_enqueue INTEGER NOT NULL DEFAULT 0 CHECK(needs_enqueue IN (0,1)),
  state_json TEXT NOT NULL, PRIMARY KEY(principal, goal_id, goal_revision)
);
CREATE INDEX goal_progress_pending ON goal_progress(needs_enqueue, due_at_ms) WHERE needs_enqueue=1;
CREATE TABLE goal_observations (
  principal TEXT NOT NULL, goal_id TEXT NOT NULL, goal_revision INTEGER NOT NULL,
  producer TEXT NOT NULL, ref TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL,
  PRIMARY KEY(principal, goal_id, goal_revision, producer, ref, version),
  FOREIGN KEY(principal, goal_id, goal_revision) REFERENCES goal_progress ON DELETE CASCADE
);
CREATE TABLE goal_scope_controls (
  principal TEXT NOT NULL, scope_key TEXT NOT NULL, generation INTEGER NOT NULL,
  speech_until_ms INTEGER, all_until_ms INTEGER,
  PRIMARY KEY(principal, scope_key)
);
ALTER TABLE goal_permits ADD COLUMN mode TEXT NOT NULL DEFAULT 'mock' CHECK(mode IN ('mock','goal'));
ALTER TABLE goal_permits ADD COLUMN permit_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE goal_permits ADD COLUMN scope_json TEXT;
ALTER TABLE goal_permits ADD COLUMN grant_operation_key TEXT;
CREATE UNIQUE INDEX goal_permits_operation ON goal_permits(principal, grant_operation_key)
  WHERE mode='goal' AND grant_operation_key IS NOT NULL;
ALTER TABLE goal_work ADD COLUMN mode TEXT NOT NULL DEFAULT 'mock' CHECK(mode IN ('mock','goal'));
ALTER TABLE goal_work ADD COLUMN dispatch_id TEXT;
CREATE UNIQUE INDEX goal_work_dispatch ON goal_work(dispatch_id) WHERE dispatch_id IS NOT NULL;
ALTER TABLE goal_reports ADD COLUMN mode TEXT NOT NULL DEFAULT 'mock' CHECK(mode IN ('mock','goal'));
```

新しい書込みは列名を指定する。進行の `state_json` は形式版1、原文条件と内訳、条件別の証拠、待機条件、未解決の質問、次の処理、見直し理由、直近の `lastDecision: {contextId, digest, resultRef}` を持つ。試行の payload は形式版1、対象条件・選んだ手段・許可ID／版・作業先・受付済みの `ownerWorkId`・最終観測版・結果参照を持つ。資料本文は文書の所有元から読む。複数条件に同じ成果が寄与する場合も出典と digest をたどれるようにする。`goal_preparations` の既存 payload にある `startedAt` を初回分析時刻として読む。

### 2.2 公開操作と受付の一意性

以下は GoalStore に加える同期操作。既存の `register/revise/withdraw/complete` の writer 内の本体を transaction 版から呼べる形にして再利用する。transaction を開く従来の関数を別の writer の中から await しない。全操作に所有者・許可スコープを渡す。

| 操作 | 同じ writer で行う更新 | 再送・競合時の結果 |
| --- | --- | --- |
| `registerInTransaction` / `authorizeWorkInTransaction` | Goals と枠の登録、初期進行行、必要なら §4 の許可を保存。保存範囲内で進行を起こす。 | 既存の発言由来の登録キーと同じ操作／引数なら同じID。範囲の異なる同一キーは conflict。 |
| `applyDecisionInTransaction` | 目標版・進行版・`contextId` の根拠が現行か確認。act は許可照合後に試行と受付IDを予約、wait は購読、ask は質問、verify は検査対象を保存。 | `UPDATE ... WHERE principal=? AND goal_id=? AND goal_revision=? AND progress_version=?` が1行のときだけ新規採用。受理済みの再送・衝突・旧版は下記の規則で外部実行0件。 |
| `observeInTransaction` | 所有元の版・現在性を読み、`goal_observations` と試行の観測・次の状態を保存。 | 同じキー・digest は `replayed`。同じキー・異なる digest は conflict。順序を持つ版は最終採用版と比較し、ハッシュしかない文書は所有元の現行 digest と比較。 |
| `completeInTransaction` | 根拠・許可・全達成条件を再照合して Goals を完了。進行・試行を終端にし、元版・完了版付きの報告を挿入。 | 現行目標が既に同じ証拠で完了した再送は元の報告ID。途中で失敗すれば完了・報告をともに rollback。 |

`applyDecisionInTransaction` は直近と同じ `contextId` と正規化出力の digest なら `replayed` と元の参照、同じIDで別の内容なら `conflict` を返す。それ以前のスナップショットは `stale`。比較更新1件を確保してから関連行を書くか、不成立時に関連行ごと rollback する。旧ジョブの取消・終了では、そのジョブ自身が所有する `job_id` だけを消す。

実行権と復旧を担当する本家側は、上記操作と同じ writer でキューを更新する。外部のモデル・runner・ファイル検査へは writer を出てからアクセスする。実行先の親仕事を同じ SQLite に予約できる場合は、その公開受付操作と `ownerWorkId` の記録を一つの transaction にする。

## 3. 起動、結果通知、復旧

本家に `api/application/agency/goal-progress.ts` を新設し、GoalStore、QueueService、設定、推論、能力検索、実行先、検証・報告の port を注入する。純粋な判断は配布版 Agency に渡す。`createAgencyLlmPort` には `independent: true`、正の進行版、推論呼出しごとの新しい `decisionId`、設定済みなら `agency.thinkResourceId` を渡す。会話IDを省いた場合も `request.prompt` が入力になる。`contextId` は同じスナップショットに安定した値を割り当てる。既存の会話連動経路で mock 所有の行を動かす前に、台帳の所有区分を照合する。[推論](../api/application/agency/llm-port.ts)・[現在の会話連動処理](../api/application/agency/always-on-runtime.ts)

キューには `kind: "agency.goal.advance"`、`scope: "agency-goals"`、`payloadVersion: 1`、`lane: "background"` を登録する。payload は `{principal, goalId, goalRevision, progressVersion}`、`subjectRef` は目標ID。重複キーはこの4値の正規化表現、同時実行キーは所有者と目標IDとする。handler の `recovery` は `replay_safe`。すべての段階で再開時に保存済みの版・受付を確認する。推論・参照の一時障害にはキュー上限の `maxAttempts: 3` を設定する。キューの終了行は保持期間後に削除され得るため、長期の一意性は台帳で検査する。[キューの重複照合と保持](../api/domains/queue/service/index.ts)

| 現在の段階・入力 | transaction 内で準備 → 外で行うこと → 結果採用後の状態 |
| --- | --- |
| `ready`・登録／許可内の実行可能な条件 | スナップショットを固定 → `decideGoalStep` → 次の手を保存して `dispatch / waiting / needs_user / verifying`。初回分析時刻と設計版を保存し、初回変更の5分条件には期限を予約する。 |
| `dispatch`・予約済み | 同じ受付ID・現在の許可で親仕事を予約 → コミット後に担当を起こす → `observing`。再開時に受付済みなら元の仕事IDを採用。外部受付が不確かなら照会を予約する。 |
| `observing`・担当の更新／照会期限 | 同じ受付IDから現在の証跡を取得 → 結果版を採用。実行中／不明は次の照会時刻を持つ `observing`、手段の失敗・部分結果は未達条件を持つ `ready`、検証できる成果は `verifying`。 |
| `waiting`・資料、期限、枠の解放 | 登録済みの依存条件と採用済み版を照合 → 該当する目標だけ `ready`。提示済み版の再到着は変更0件。 |
| `needs_user`・質問の返答 | 質問ID／版・本人・未消費を検査 → 返答消費・許可操作・再開を一度だけ保存。`ready`。独立部分が残る間は質問を保持した `ready` を使う。 |
| `verifying`・成果物 | 対象の版と検査を固定 → 再読取・再実行 → 依存版を再照合。部分合格は証拠を残し `ready`、全条件合格は `completed` と報告予約。 |
| 改訂／取下げ／忘却／全停止 | 旧進行を `superseded / withdrawn` にするか、適用範囲の制御世代を更新する。忘却は即時除外と purge。受付済みの停止・照会を記録してから、旧結果を採用しない。 |

1. `registerHandler` はキューの recovery 前に実行する。`prepareInTransaction` で現行版・停止・既存受付を確認し、stale は判断を呼ばずに終える。`execute` は外部I/Oのみ、`settleInTransaction` は比較更新、`afterCommit` は `queue.wake()` と必要な停止通知を担う。再実行可能にするのは、判断・読取・同じ受付を照会する段階。副作用の一意性は担当の受付で担保する。[型とコールバック](../api/domains/queue/types/index.ts)
2. 状態変更で `needs_enqueue=1` を保存し `enqueueInTransaction` を試す。成功時に `job_id` を記録して印を落とす。`queue_full` のみ未投入の印を残し、予期しないエラーは transaction を戻す。新しい結果が来たら進行版を先に進め、将来に予約された旧ジョブを取り消す。`availableAtMs` だけを変えて同じキーを再投入しても古い行が返る。照会継続でも次の期限を保存して新しい進行版のジョブを作る。処理中の旧ジョブは settle 時にも版を比較する。
3. 会話が依頼したメモは `collectAgendaResults` の文書採用と同じ writer で、文書ID・版・所有者と購読先を通知する。目標が直接依頼した Web メモは、Web メモが結果を確定する writer から試行IDで通知する。画面も会話チケットも要らない。別経路の結果は許可区画・購読先の一致で候補を届け、関連性をモデルが否定した文書版を既読にする。監督も親の状態を保存する transaction から同じ観測受付へ通知する。後続のキックは commit 後。イベント喪失時にも実行先を読んで復旧できる。[会話用メモの採用](../api/application/agency/always-on-cycle.ts)・[Web メモの確定](../api/domains/web-note/service/jobs.ts)・[監督の状態更新](../api/domains/development-supervision/reconcile.ts)

成果を返す能力の成功後は、対応する独立検査がある条件を `verificationRequired` として判断入力に含める。該当する判断には新たな `act` を提示せず、対象条件を含む `verify` と根拠参照を検査する。検証を行った段階でこの制約を消費し、不一致なら同じ目標版の通常判断へ戻す。成功した変更や調査文書を受け取ったあと、既に終わった初回診断へ戻り続けないようにする。[判断契約](../../eumenes_agency/spec/goal-decision-contract-2026-11-23.md)
4. 登録・許可・照会の配線は `buildServices` で構成する。子担当は自身の recovery で動き始めるため、現在の目標・許可・停止のガードは各担当の recovery より前に注入する。キュー・開発監督・Webメモ・Claude担当の既存 recovery 後、通常のキュー起動前に未投入フラグ、失われた／終端の job、条件到着済みの待ち、受付済みの仕事、未配送の報告を台帳と照合する。通常運転でも `store.onCommit` の集約通知で未投入があるときだけ空きを再確認する。空きも状態も同じなら書込み0件とし、監視自身の書込みで起動を繰り返さない。[起動順](../api/application/server-lifecycles.ts)・[共有 writer](../api/infrastructure/sqlite/index.ts)
5. `set_quiet` の適用・解除と、既存仕様で発話休止を解除する利用者発言を受けたときに、目標用の所有者・スコープ制御行も保存する。全停止・設定無効を予約、開始、結果採用で再照合する。発話休止は配送に適用する。別の会話の古いチェックポイントで新しい明示指示を上書きしない。[会話側の適用点](../api/application/agency/always-on-ports.ts)

質問・資料待ちに入るとき、担当が物理作業を解放したことを確認して `goal_work.state` を `waiting_user` または `waiting_dependency` に変え、principal の一意索引の枠を返す。担当の親ID・試行IDは保持する。再開時は同じ writer で枠を取り直してから外部作業を許す。受付不明・取消未確定の仕事は照会を優先し、解放済みとみなさない。推論の一時障害・不正な形式は既存キューの `maxAttempts` の範囲内で回復する。枯渇時は原因と待機先を保存し、経路の復旧・設定変更・新資料など再判断できる条件で起こす。同一入力の即時再投入で新しいジョブを作り続けない。

## 4. 許可、実行元、配送先を実コードに結び付ける

### 4.1 一発話での登録・許可

`register_goal` に省略可能な `workPermission`、`update_goal` に `authorize_work / revoke_work` を追加する。従来の引数での登録・改訂・`authorize_mock` は従来の形で解釈する。新しい許可要求の入力は `{quote, workspaceRef, mode, readablePaths, writablePaths, checkRefs}`。モデルは現在の利用者発言から明示範囲を解釈し、画面またはホストが提示した作業先と検査の参照を返す。作業先の実パス・基準コミット、検査コマンドと引数、担当の登録版はホストが解決する。修正先以外のパスは読み取り範囲として照合する。既存の確認が必要な差は保存した質問に結び付ける。[発言の引用と現行の登録キー](../../eumenes_agency/runtime/agenda/agenda-goals.ts)・[本家のツール指示](../api/domains/dialogue/contexts/agency/goal-reply.context.toml)

明示範囲を解決できた登録＋許可は1回の writer で適用する。登録自体は有効で、作業先や権限だけが確定しない場合は目標と不足点を保存して `permissionStatus: "needs_input"` を返し、許可行は0件。`workPermission` 省略時も既存形式で登録に成功する。`grant_operation_key` は許可を与えた発言ID・目標ID・版・操作種別の正規化表現。再送では保存した正規化範囲の digest を比較する。別のメッセージで有効な範囲を変更したら旧許可を失効させ、新しい許可を発行する。取消は対象の許可ID・版を照合し、同じ取消の再送では版を進めない。

実許可は `goal_permits.mode='goal'`。既存列の `toolchain/workspace/impact` には解決済みの対象、`scope_json` には形式版、権限の根拠、基準コミット、読み書きパス、許可した検査の完全な組（実行ファイル・引数・cwd）、期限と既存上限を保存する。既存ポリシーが認める読み取りにはポリシーの版を根拠として記録する。実編集には本人の明示許可を使う。各子許可は、親許可と提案範囲の積に限定し、親・担当・入力の版を実行前にも再照合する。現在の監督は単一 checkout に結線されているので、目標入口では `workspaceRef` から登録済みの隔離 checkout を解決する。解決できないときは対象不明を返す。[作業範囲の解決と既存差分の保護](../api/application/work/supervision-workspace.ts)・[監督への接続](../api/application/work/development-supervision-host.ts)

### 4.2 目標所有の仕事

tool-runtime に所有者を識別する目標起点の型を加える。親の出所は `origin: "goal"`、`runId = dispatchId`、所有者・実 Goals スコープ・目標ID／版・試行ID・許可ID／版・能力と binding の版、凍結した request と digest を持つ。監督が作る子の出所は既存の `origin: "supervised"` に親の所有者種別を持たせ、既存の `grantRef/parentWorkId/taskId/各generation` で照合する。配送先は目標台帳で読む。権限の比較に画面の activeId や通知先を使わない。[実行元と既存のガード](../api/domains/tool-runtime/contracts/task-execution.ts)・[現在の検証](../api/application/toolchain/task-execution-sources.ts)

一つの親仕事は、選ばれた一手の `request` と `expectedObservation` を受け取る。子の並列実行や同じ方法の通信回復は監督が扱う。一手の検査が失敗したときは、親が実測と失敗した対象を目標へ返す。目標担当がその観測を読み、別の方法を選んだら次の試行を作る。最初のコマンドの失敗を監督の中で隠して目標全体の成功だけを返すと、段7の「失敗を受けた別試行」は成立しない。

| 結合箇所 | 実装する変更と互換条件 |
| --- | --- |
| 監督の親入口 | 開発監督の `goal.startInTransaction / lookupInTransaction / cancelInTransaction` を追加する。start は本家から注入した許可検証 port を呼び、登録 binding が同じときだけ受付。`parentOfRun(db, dispatchId)` の既存行と同一の目標・範囲・依頼・版なら同じ親ID、相違は conflict。通常の `task.startInTransaction` は従来どおり発言を検査する。目標側の権限上限は保存済み許可から設定し、計画・担当からの文章で上限を上げない。[通常入口](../api/domains/development-supervision/task.ts)・[親と子の照合](../api/domains/development-supervision/authority.ts) |
| 永続化 | `development_supervision_work.conversation_id` と `web_note_runs.conversation_id` は現在 NOT NULL。各 domain に追加 migration を置き、既存列を `owner_key` に rename、`owner_kind TEXT NOT NULL DEFAULT 'conversation' CHECK(owner_kind IN ('conversation','goal'))` を追加する。旧行は旧会話ID、新行は実目標ID。既存の位置指定 INSERT を列名指定にし、会話の検索・取消・表示は明示的に `owner_kind='conversation'` を要求。保守全件走査と所有者照会を別関数にする。Claude の仕事は既存 JSON の出所を旧・新の型で読む。[監督の表と検索](../api/domains/development-supervision/repository.ts)・[Webメモの表](../api/domains/web-note/repository/index.ts)・[子作業の受付台帳](../api/domains/claude-code/repository.ts) |
| 読取と通知 | 目標所有の返却は `ownerWorkId, ownerRevision, status, question, result, evidenceRefs`。会話用 `ExecutionView.conversationId` は会話所有の投影で必須とする。子作業の照合は親・許可・試行の一致を要求する。目標所有の結果は目標の観測先へ保存し、会話用 TODO・完了通知への自動配送を起こさない。通常の会話仕事の投影は回帰試験で照合する。[現在の監督の投影](../api/domains/development-supervision/views.ts)・[子作業のライフサイクル](../api/domains/claude-code/lifecycle.ts)・[Webメモの投影](../api/domains/web-note/service/lifecycle.ts) |
| 設計書・調査資料 | `GeneratedInput` は現在 `conversationId` 必須。既存の会話形と、目標所有者・目標ID／版・親仕事IDを持つ形を strict union で読む。既存行は旧 JSON のまま読める。目標形は文書 owner の `validInTransaction/storedPreviewInTransaction` で設計版・全入力を検証。同じ設計の現物を目標と監督が参照し、目標ごと・試行ごとに同じ Markdown を再生成しない。設計が必要な子作業は有効な設計参照を得てから開始する。[Markdown の入力](../api/domains/markdown/contracts/generated.ts)・[設計参照の照合](../api/application/work/supervision-design.ts) |
| 開発作業・検査 | 子作業側の `startInTransaction` と `viewInTransaction` を再利用し、親許可の失効を `liveGrant` に反映。ファイルは作業先の実パス・HEAD・入力 digest を固定する。先行試行の確定差分を引き継ぐ際は同じ目標・作業先・前後 digest・編集済みパス・実行枠解放をすべて照合する。第三者の変更が混じれば保留する。試験の検査器はホストの許可済み検査として登録し、製品コードには試験固有のファイル名・コマンド分岐を加えない。[子の受付と二重受付照合](../api/domains/claude-code/supervised-task.ts)・[既存の検査実行](../packages/coding-runner/src/claude-supervised-tools.ts) |

各 domain の migration をその domain の既存 migration に続ける。下記の旧表で開いた DB を移行し、同じ文字列を会話IDと目標IDの両方に使っても、会話用検索で目標の仕事を返さないことを確認する。保存済みの JSON に owner のない旧行は `conversation` としてデコードする。

```sql
-- development-supervision/0002-owner (after development-supervision/0001-work)
ALTER TABLE development_supervision_work RENAME COLUMN conversation_id TO owner_key;
ALTER TABLE development_supervision_work ADD COLUMN owner_kind TEXT NOT NULL
  DEFAULT 'conversation' CHECK(owner_kind IN ('conversation','goal'));
-- web-note/0002-owner (after web-note/0001-runs)
ALTER TABLE web_note_runs RENAME COLUMN conversation_id TO owner_key;
ALTER TABLE web_note_runs ADD COLUMN owner_kind TEXT NOT NULL
  DEFAULT 'conversation' CHECK(owner_kind IN ('conversation','goal'));
```

### 4.3 参照、質問、報告の採用

- `recordsFor` で提示した `goal:<id>` は実 Goals スコープ・版と出典、`plan:<id>` は Continuity の計画の現行版または内容 digest と根拠、`note:<id>` は文書ID・版・入力を保存する。利用時の `referencedInput` と採用時の `currentInput` の双方で発行元に戻って照合する。メッセージとして Memory に渡すのは、それぞれの発行元が返した実在の根拠発言だけ。未知・抑制・忘却・別所有者は受付0件。同一の恒久拒否は入力版が変わるまで繰り返さない。[提示元](../api/application/agency/always-on-recall.ts)・[解決先](../api/application/agency/input.ts)・[監督側にある目標版の照合例](../api/application/work/supervision-research.ts)
- ホストは `GoalStep.contextId` を、現在の目標版・進行版・提示参照の版・許可／停止世代に結び付ける。保存済みの質問はID・対象条件・目標版・必要な範囲を持つ。本人の返答を既存の会話入口で解釈し、対象質問の消費と制御操作を同じ writer で行う。別件への返答・古い質問・再送で新規実行0件。
- 成果検証には固定した期待値と `{attemptId, ownerWorkId, artifactRef, version, digest, checkRef, observed}` を渡す。合格した条件を保存し、根拠の版が変わればその条件を再検査する。機械検査が使える場合、その出力の一致をホストが採否に使う。文書の意味を判定する場合は、根拠本文と検査結果を結び付ける。完了報告の採用後、配送先ありは同じ `agency-goal-report:<reportId>` を照会して追加。宛先なしなら台帳から閲覧可能にして、配送の空振りを再予約しない。[既存の報告 sink](../api/application/agency/goal-agenda.ts)
- `registerForgetPurges` の既存の閉包・即時除外に進行の根拠、試行、許可、未配送報告を接続する。purge 後の回収に必要な受付IDと停止状態だけを保持可能な範囲で扱い、忘却済みの本文を再公開しない。受付確認不能と未受付は別の応答にする。[忘却の組立](../api/application/server-wiring.ts)・[既存の失効試験](../api/application/agency/goal-agenda-regressions.test.ts)
- `list_goals` の既存の行に、実行方式、`progressVersion`、状態、直近の試行と実測、未達の条件、次の手／待機理由、質問ID、開ける証拠・完了報告の参照を加える。所有者と閲覧スコープを照合してから返す。所有者が離席後に戻ったときも、失敗した手、変更した方針、現在待っている相手を同じ目標から確認できる。[既存の目標ツール](../api/application/agency/always-on-goal-reply.ts)

実報告の `state` は、通知先ありなら `pending` から既定のメッセージIDの保存確認で `delivered`、通知先なしなら初めから `ledger_only` とする。配送と復旧が選ぶのは `mode='goal' AND state='pending'` の行。発話休止中は `pending` を維持し、解除時に起こす。どの配送状態でも目標一覧から同じ報告を開ける。

## 5. 受入を再現する手順

### 5.1 固定試験

段ごとの新設テスト名は §1 のとおり。次の中断位置は、本家の一時 SQLite を閉じて同じ DB からホストを再構築し、独立した実行先の受付台帳と照合する。時計・推論応答・受付通知を個別に制御する。各行で目標の最終表示と外部受付回数の両方を検査する。[目標用の会話 fixture](../api/application/agency/goal-agenda.fixture.ts)・[キューの回復試験](../api/domains/queue/test/recovery.test.ts)・[担当を再開する結合試験](../api/application/work/claude-code-task-recovery.test.ts)

| 止める位置・入力 | 再開後に必ず観測すること |
| --- | --- |
| 試行を予約した直後、担当の受付前 | reservation の attemptId と dispatchId を再利用。受付1、余分な親仕事0。 |
| 受付済みだが結果未保存、通知を1回欠落 | 元の dispatchId を照会し、同じ ownerWorkId を回収。既に実行した副作用の再送0。 |
| 登録と同時のキュー満杯、期限待ち中の資料到着 | 登録は1件、空きで始動。資料で旧予約が無効化され、同じ文書の2通目による追加判断0。 |
| 有効な `goal:<id>` と `plan:<id>` をそれぞれ調査の根拠にし、別所有者・旧版でも同じ依頼を送る | 有効な各依頼の受付・開始は各1、別所有者・旧版は各0。結果の保存で対象目標だけ起きる。偽の発言ID、無関係な目標の起動、古い資料の再採用は各0。 |
| 許可取消／目標改訂／出典忘却後に古い実行が成功 | 旧結果の採用・報告0。既知の仕事の停止や解放の照会は元のID。 |
| 発話だけ休止／すべて停止／本人の返答待ち | 発話休止中の許可内作業は進み配送は待つ。全停止中の新規試行0。質問は1件、他の着手可能な目標の選択を妨げない。 |
| 一つの条件が未達、根拠ファイルを後から変更 | 有効な条件だけ保持。不一致または古い根拠で完了0。新しい版を検証してから完了。 |
| 完了予約後、配送確認前 | Goals 完了1、報告行1、通知先ありなら同じメッセージID1。宛先なしなら会話メッセージ0、目標から読める報告1。 |

### 5.2 実モデル・実作業の通し試験

本家に `api/application/agency/goal-autonomy.live.test.ts` を新設する。既存の監督 live 試験の隔離 checkout・別プロセス・再起動手法と、既存の会話 API を使う。試験専用の起動指定を `EUMENES_GOAL_AUTONOMY_LIVE=1` とし、通常の `bun test` は実モデルを自動起動しない。[既存の実行例](../api/application/work/supervision-parallel.live.test.ts)・[初回発話と許可範囲](registered-goal-autonomy-2026-11-23.md)

1. `spec/verification/goal-autonomy-2026-11-23/workspace` だけを一時 Git checkout に複製し、初期内容をコミット。隔離 DB に作業先、登録能力、推論設定と許可可能な検査を設定する。試験器は編集可能な checkout の外に置く。試験専用 API に本家設計 §7 の初回発話を1件送り、登録と許可の受付を確認して画面を離脱する。
2. 最初の掲載コマンドが終了2になった事実を、実行先の作業ID・標準エラーとともに目標に返す。別の方法をモデル自身に選ばせる。以後はユーザー発言、手段指定、修正文の注入を各0件にする。修正を担う仕事の受付が永続化され、結果の採用前であることを観測してから、試験のバックエンドだけを閉じて再起動する。復旧後の照会・採用は同じ仕事IDに結び付ける。
3. 基準コミットに対する `git diff --name-only <基準コミット>` が `README.md` のみで、`git ls-files --others --exclude-standard` に未追跡の成果追加がないことを照合する。本家側から `bun spec/verification/goal-autonomy-2026-11-23/check-readme.ts <隔離checkout>` を実行し、検査器の終了0と、サンプルの終了0・JSONの `count=3, total=12` を確認する。コードブロックを消した説明だけの修正、テキスト出力を返す終了0、サンプル本体の書換えは受入失敗になる。[独立検査器](verification/goal-autonomy-2026-11-23/check-readme.ts)・[検査器の校正](verification/goal-autonomy-2026-11-23/check-readme.test.ts)
4. 証跡にパッケージSHA、モデル設定の識別子、目標／版、各試行IDと受付ID、所有元の作業IDと結果版、条件別の検査結果、報告IDを残す。合格値は、追加発話0、失敗観測後の別試行1以上、各受付IDの実行回数1、モック実行0、目標完了1、完了報告1。時刻・根拠・実ファイルをつなげて確認する。外部実行先を利用できず skip した回は「通し未確認」と記録する。

部分・結合では仮想時計で初回分析の期限直前／直後を検査する。通し試験は既定の5分を含む実時間で行い、試験の timeout に実作業・再起動・検証の時間も確保する。期限内に達しなければ最後に観測した目標状態・試行ID・作業IDを記録して不合格とする。

### 5.3 実行コマンドと切替

| 時点 | 作業ディレクトリ | 実行コマンド |
| --- | --- | --- |
| 着手時から可能 | `eumenes_agency` | `bun test ./test/agenda/goals.test.ts ./test/agenda/design.test.ts` |
| 着手時から可能 | `eumenes` | `bun test ./api/application/agency/goal-agenda.test.ts ./api/application/agency/goal-agenda-regressions.test.ts ./spec/verification/goal-autonomy-2026-11-23/check-readme.test.ts` |
| 段1・2の追加後 | `eumenes_agency` | `bun test ./test/agenda/goal-step.test.ts ./test/agenda/goal-progress.test.ts` |
| 段3–6の追加後 | `eumenes` | `bun test ./api/application/agency/goal-progress.test.ts ./api/application/agency/goal-permission.test.ts ./api/application/work/goal-supervision.test.ts ./api/application/agency/goal-completion.test.ts` |
| 対象ドメインの結合 | `eumenes` | `bun run verify -- --domain goals --domain queue --domain tool-runtime --domain development-supervision --domain claude-code --domain web-note --domain markdown --domain dialogue` |
| 段7の実環境依存を整えた隔離先 | `eumenes` | `EUMENES_GOAL_AUTONOMY_LIVE=1 bun test ./api/application/agency/goal-autonomy.live.test.ts` |

第2稿の準備検証では着手時の2コマンドで44件が成功した。§2.1 と §4.2 の SQL を本家の既存324件の migration を適用した一時 DB に順次適用し、旧行の保持、所有者別の検索、受付IDの一意性、進行版の比較更新、完了と報告の rollback、再オープンを確認した。新しい判断から実作業までの製品受入は段7で検証する。

既存行には次の順で担当を割り当てる。完了・取下げは履歴のみ。旧受付済み／成否未確定／旧報告未配送は旧担当で照会・収束させる。終端に達してなお未達の登録目標は、同一 writer で未処理の旧仕事・報告がないことを確認して `mode='goal'` へ移す。該当する実許可がなければ許可内の分析・読取と必要な質問から始める。新規登録の実ルートへの切替は配布物・型・実行先・受入がそろった版で行う。切戻しは新受付を止め、同じ台帳を読める版で残った仕事を回収する。過去の migration の書換えや、追加済みの migration を知らないバイナリへの差し戻しは行わない。[migration の整合性検査](../api/infrastructure/sqlite/index.ts)
