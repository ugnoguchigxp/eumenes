# 担当への依頼・第2段の実装設計（TODO・確認の全面廃止）

> **整理判断（2026-11-28）: 今後取り組む。** 一部実施。親設計に第2段の実装・domain別fixtureを記録。全体スイート・独立レビューとlive・実画面・実機器受入は未実施。 実装済みの部分をやり直す指示ではない。未合意の設計は、着手時に現行方式と照合し必要な合意を得る。

2026年11月25日・第1稿。[担当への依頼を調べものと同じ流れにする](toolchain-assignment-as-research-2026-11-25.md) §11 の実装設計。§11 で決めたこと（TODO と確認の廃止、すべての依頼を依頼項目にする、起動前の確認なし、`agency_unavailable`、起動時に一度だけ閉じる、データドリブンの規則）は変えない。§11.2 の表は「種別ごとに adapter を足す」としていたが、コードを調べた結果、もっと狭い形で足りる（§1）。

前提:

| 事柄 | 状態 |
| --- | --- |
| 第1段 | 作業ツリーにあり、未コミット（`agency-actions.ts`・`executor-delegation.ts`・`always-on-*.ts` など）。第2段の着手前に第1段をコミットしておく |
| 別セッション | `api/application/agency/` の調べもの拒否（`researchRefusals`・`retry`。`always-on-flow.ts`・`always-on-cycle.ts`・`always-on-scope.ts`・`research-admission*.ts`）を編集中。下の単位はその hunk に触れない |
| 表 | `dialogue_work`・`dialogue_confirmations`・`command_interactions` は行を残し、書込みだけを止める。DROP マイグレーションは作らない |

## 1. 起動の口：新しい adapter は作らない

### 1.1 結論

`agency-actions.ts` の `start`（`agency-actions.ts:239-266`）は今でも3つに分かれている。task は持ち主の `TaskLifecyclePort`、pipeline は `startPipelineInTransaction`、それ以外は `agents.executions.startSelectedInTransaction`。3つ目は、agency の自律行動が今使っている口である。この口は、run に結び付いた種別をすべて run なしで起動できる。

| 種別 | 今の会話経路（run が待つ） | 第2段の起動口 | 根拠 |
| --- | --- | --- | --- |
| `task` | `work-dispatch.ts:155-169` | 持ち主の `TaskLifecyclePort`（第1段のまま） | `toolchain-routing.ts:440-475` |
| `image` | `work-dispatch.ts:95-100`（`runId` 必須） | `startSelectedInTransaction` → 子の `prepareInTransaction` → `host.media.startInTransaction` | `task-execution-dispatch.ts:113-118`、`task-media-execution.ts:93-110`（`execution: child` を渡す。`image/service/index.ts:78,86` は execution 付きの行では `onFinished(run)` を呼ばない） |
| `music-create`・`music-playback` | `work-dispatch.ts:101-113` | 同上（playback は `child.refs` を `references` に使う。`music/service/playback.ts:244`） | `task-media-execution.ts:97-100` |
| `excalidraw` | `work-dispatch.ts:88-94` | 同上 | `task-media-execution.ts:46-53` |
| `command` | dialogue の queue job `COMMAND_KIND`（`work-dispatch.ts:114-139`） | `startSelectedInTransaction` → `dialogue.executionCommands.prepareInTransaction`（`execution-command.ts:39-136`）→ bound 操作 / legacy | `task-execution-dispatch.ts:40-53, 189-277` |
| 既定の route（research） | `delegateConversation`（`work-dispatch.ts:191-224`） | `startSelectedInTransaction` → research の子（`agents.startInTransaction`、route は binding のもの） | `task-execution-dispatch.ts:67-85` |
| `pipeline` | `startPipelineInTransaction`（`work-dispatch.ts:170-190`） | 同じ口。`references`・`routedSteps` を渡すよう直す | `execution-pipeline.ts:244-255` |
| `session` | `startSpecialistSession`（`work-dispatch.ts:140-154`） | 変えない（依頼項目にしない） | — |
| `instant` | `instant()`（`executor-delegation.ts:602-603`） | 変えない（記録なし） | — |

資源番号: 選んだ実行が完了すると、`adoptTaskResources`（`task-execution-resources.ts:5-29`）が子の `output`（画像なら `{state, imageRef}`）から `links` を作る。`agency-actions.ts` の `result`（`:270-305`）はそれを `view.result.links` として読み、`sync`（`agency-action-work.ts:28-41`）が作業 root を鍵に台帳へ入れる。報告の発言はメモを引用し、`findingWorkRefs`（`always-on-flow.ts:308-319`）から `linkFindingsInTransaction`（`agency-state.ts:182-196`）を通って資源チップになる。この連鎖は第1段のまま使え、新しいコードは要らない。

再生: Web は会話の playlist 一覧を問い合わせ、新しい playlist を自分で開く（`web/src/domains/music/index.ts:38-50`、`useWorkspace.ts:98`）。run の返事には依存しない。未確認なのは、execution 付きの playlist 行もこの一覧に入るかどうか。受け入れ試験で確かめる（単位 A）。

### 1.2 直す所（起動口まわり）

| 直す所 | 理由 | 変更 |
| --- | --- | --- |
| `startSelectedInTransaction` の開始鍵 `selected:${source.runId}:${source.digest}`（`execution-single.ts:52`） | 依頼の source は利用者の run（`AssignmentSource.runId`）。一つの発言から依頼が2件出ると（「絵と曲を作って」）、2件目が `request_conflict` になる。自律行動の source は作業 root ごとに別の run なので、今は衝突しない | 入力に `startKey?: string` を足す。鍵は `startKey ? \`selected:key:${startKey}\` : 今の式`。agency は `rootId` を渡す |
| `startPipelineInTransaction` の鍵 `pipeline:${messageId}:${digest}`（`execution-pipeline.ts:290-294`） | 同上 | 同上の `startKey?: string`。鍵は `pipeline:key:${startKey}` |
| `agency-actions.ts` の pipeline 分岐（`:253-258`） | `references` と `routedSteps` を渡していない | `references`・`details.routedSteps`・`startKey: rootId` を渡す |
| `agency-actions.ts` の `control`（`:325-366`） | task の持ち主しか受けず、他は `control_unsupported` | 持ち主が無ければ `agents.executions.controlInTransaction` に渡す（`execution-commands.ts:136-200`）。単一実行の amend は `pipeline_amend_unsupported` で断る（既存の挙動）ので、そのまま拒否として返す |
| `agency-actions.ts` の `start`。task 以外の分岐（`:259-266`） | 第2段の依頼の詳細を渡していない | `startKey: input.rootId` を渡す。`details` の扱いは §2.3 |

### 1.3 状態の見え方（`viewInTransaction`）

| 欄 | task の持ち主 | 選んだ実行・pipeline（`agents.executions.viewInTransaction`） |
| --- | --- | --- |
| `status` | 持ち主の値 | `ExecutionStatus`。`queued`・`deciding`・`waiting_child` は「進めている」、`waiting_user` は「質問がある」 |
| `question` | 持ち主の値 | 子の `waiting_input` から作る（`task-execution-dispatch.ts:212-222`）。`assignment(answer)` は `controlInTransaction(answer, questionRef)` へ渡す |
| `progress` | 持ち主の値（Claude Code など） | 未確認。設定しないなら `assignments[].progress` を出さない（第1段の表示はそのまま） |
| `result.links` | 持ち主の値 + `agency-actions.ts` の `producesInTransaction` | `adoptTaskResources` が作る（上記） |

## 2. 契約（単位の着手前に統合者が固定する）

### 2.1 依頼の詳細

`api/domains/dialogue/contracts/agency-always-on.ts` に追加する:

```ts
import type { RoutedPipelineStep } from "../../tool-runtime";

/** `delegate` の欄のうち、依頼文と refs 以外のもの。会話経路の dispatch と同じ意味で、そのまま運ぶ。 */
export type AssignmentDetails = {
	inputs?: Record<string, unknown>;
	target?: string;
	diagnosticRef?: string;
	resolveUnsaved?: "discard";
	routedSteps?: RoutedPipelineStep[];
};

export type AgendaAssignment = {
	/* 既存の欄 */
	details?: AssignmentDetails; // 追加
};
export type AgendaResearchTicket = {
	/* 既存の欄 */
	details?: AssignmentDetails; // 追加（assertAgendaTicket が照合する）
};
```

zod（`snapshotSchema` の `tickets[]` と `assignments[]` の両方に optional で足す。これで既存の checkpoint もそのまま読める）:

```ts
const assignmentDetails = z.strictObject({
	inputs: z.record(z.string(), z.unknown()).optional(),
	target: z.string().min(1).optional(),
	diagnosticRef: z.string().regex(/^e[1-9]\d{0,12}$/u).optional(),
	resolveUnsaved: z.literal("discard").optional(),
	routedSteps: z.array(z.strictObject({
		text: z.string(), entry: z.string(), revisionId: z.string().min(1),
		after: z.array(z.number().int().nonnegative()),
	})).max(16).optional(),
});
```

### 2.2 渡す口

| 口 | 変更後の入力 |
| --- | --- |
| `AgencyLayerPort.assign`（`dialogue/contracts/index.ts:297`） | `{ toolchainId, revisionId, title, request, references, source, details?: AssignmentDetails }` |
| `AgencyStatePort.startInTransaction`（`agency-state.ts:197-217`）と `createAgencyActions().start`（`agency-actions.ts:88-109`） | 既存の欄 + `details?: AssignmentDetails` |
| `agents.executions.startSelectedInTransaction`（`execution-single.ts:16-26`） | 既存の欄 + `startKey?: string` |
| `agents.executions.startPipelineInTransaction`（`execution-pipeline.ts:244-255`） | 既存の欄 + `startKey?: string` |
| `TaskLifecyclePort.startInTransaction`（`tool-runtime/contracts/task-execution.ts:318-330`） | `confirmationId` を削る。他は変えない |

### 2.3 運ぶ経路と照合

| 欄 | `delegate` での検査（残す） | 保存 | `start` で使う所 | 今の dispatch で使う所 |
| --- | --- | --- | --- | --- |
| `routedSteps` | 来たものをそのまま | `AgendaAssignment.details` → ticket `details` | pipeline の `startPipelineInTransaction({routedSteps})` | pipeline だけ（`work-dispatch.ts:179`） |
| `diagnosticRef` | `card.id === REPAIR_TOOLCHAIN` でなければ `diagnostic_ref_not_supported`、`verifiedDiagnostic` が偽なら `diagnostic_evidence_changed`（`executor-delegation.ts:607-610`、`:164-174`） | 同上 | 渡さない。今の実行中の repair は `claude-code.repair@4`（binding `claude-code.repair-managed@1`、execution `task`）で、今の task dispatch も渡していない（`work-dispatch.ts:155-169`） | command の job payload だけ（`:123-125`） |
| `target`・`resolveUnsaved` | session 以外には意味がない（今も渡していない） | 同上 | 渡さない | session だけ（`:141-149`） |
| `inputs` | instant 以外は今も渡していない | 同上 | 渡さない | なし |

新しい判断は入れない。今の dispatch が落としている欄は、起動でも落とす。保存して照合するのは、ticket が依頼の時の内容のままであることを確かめるためである。

`assertAgendaTicket`（`agency-actions.ts:397-422`）:

```ts
function assertAgendaTicket(agenda, input: { …既存…; details?: AssignmentDetails }) {
	const own = agenda.tickets.find((t) => t.id === input.ticketId);
	if (
		!own || /* 既存の照合 */ ||
		digest(own.details ?? {}) !== digest(input.details ?? {})
	) throw new Error("agency_origin_stale");
}
```

`startResearch`（`always-on-flow.ts`）では、held ticket を作る所（`assignment ? {...}` の hunk、`:186-193`）に `details: structuredClone(assignment.details)` を足し、`state.startInTransaction` の `assignment ? {...}` の hunk（`:212-218`）に `details: held.details` を足す。`researchRefusals` の hunk には触れない。

### 2.4 `delegate` の入口（会話経路）

```ts
// generation-tools.ts
export const delegateArgs = z.object({
	toolchain: id,
	request: z.string().trim().min(1).max(8000).optional(), // instant だけ省略できる
	inputs: z.record(z.string(), z.unknown()).optional(),
	diagnosticRef: diagnosticRef.optional(),
	target: id.optional(),
	refs: z.array(z.string().regex(/^a\d+$/)).max(8).optional(),
	resolveUnsaved: z.literal("discard").optional(),
	words: z.string().trim().min(1).max(8000).optional(),
}).strict();
```

| 順 | 条件 | 動作 |
| --- | --- | --- |
| 1 | system prompt の run | `not_from_user`（既存） |
| 2 | 提示していない toolchain | `toolchain_not_offered`（既存） |
| 3 | `card.instant` | `instant()`（今の `mode === "execute"` の条件を外す） |
| 4 | `card.execution === "session"` | `handOver`。予告文はホストの `dialogue.contexts.local.router-announce`（「「[[title]]」に頼みます。」）。確認しない（§6 の 2） |
| 5 | `servesRepliesInTransaction` が偽 | `{ delegated: false, code: "agency_unavailable" }` |
| 6 | それ以外 | `assignTo(x, chosen)`。`details` を `assign` に渡す |

`assignable()`（`executor-delegation.ts:289-306`）は削る。`impact`・`IMPACT_ORDER`・`minImpact` の参照は会話経路から消す。bundle の `minImpact` 欄は data として残すが、読まない。

結果の実例（第1段と同じ）:

```json
{"delegated":true,"assignment":"a7","assignee":"画像を作る","next":"状態の assignments に出る。担当の質問はそこに出て、終わると作業報告のメモで届く（あなたから知らせる）"}
```

```json
{"delegated":false,"code":"agency_unavailable"}
```

## 3. 削除と変更の一覧

凡例: 全削除＝ファイルごと消す。部分＝挙げた関数・分岐だけ消す。行番号は 2026-11-25 の作業ツリーのもの。

### 3.1 dialogue service（単位 B）

| ファイル | 扱い | 対象 |
| --- | --- | --- |
| `work-dispatch.ts` | 部分 | 残すのは `case "session"`（:140-154）だけ。名前を `session-dispatch.ts` に変えるか、`executor-delegation.ts` へ移す。`Dispatched.handed` の文書・`confirmationId`・`interactionId`・media・command・task・pipeline・default は消す |
| `media-deadline.ts` | 全削除 | 呼ぶのは `work-dispatch.ts:74` だけ |
| `delegate-conversation.ts` | 部分 | `delegateConversation`（:13-53）を消す。`availableToolchainsInTransaction`・`readyCatalog` は残す |
| `result-intake.ts` | 部分 | `intakeInTransaction`・`runReport`・`recordOutcome`・`agentReport`・`reportExecutionInTransaction`・`taskNotice`・`reportedLinks` の todo 部分・`dropRunResults` を消す。`answerTicketInTransaction`・`refreshAgentAnswer`・`consumeAnswer` は残す |
| `report-notice.ts`・`executor-work.ts`・`work-ledger.ts`・`work-links.ts`・`work-stop.ts`・`work-items.ts`・`task-work.ts`・`todo-notices.ts`・`confirmation-decision.ts`・`work-context-input.ts`・`pinned-operation.ts` | 全削除 | `work-items.ts` の `DocumentRefs` は `{resource}` にして `tool-exchange.ts` へ移す。`pinned-operation.ts` の代わりは §6 の 1 |
| `interaction-answers.ts`・`interaction-runs.ts`・`interaction-core.ts`・`command-interactions.ts`・`command-apply.ts` | 全削除 | `deps.interactions` は run に結び付いた command 経路だけが使う。`command-apply.ts` の `BoundInvocation` 型は `execution-command.ts` へ移す |
| `toolchain-command.ts` | 部分 | `executeCommand`（:125-202）と `createToolchainCommandHandler`（:209-456）を消す。`commandOutputFor`・`questionRefsOf`・`COMMAND_RULES`・`commandPrompt`・`parseToolCommand` は残す（`execution-command.ts` が使う） |
| `command-source.ts` | 部分 | `interactionId` 分岐（:70-86）と run 分岐（:87-96）を消し、`execution` 分岐だけ残す |
| `confirmation-revisions.ts` | 部分 | `awaitingWorkConfirmation`・`currentRevisions`・`delegationContext` の確認部分を消す。offers 部分（:73-93, :107-111）は `conversation-offers.ts` へ移す |
| `generation-settle.ts` | 部分 | `confirmationId`（:47-48, :326-345, :537-538）・`linkAnswerResources` の todo_changed 部分（:467-492）・refs の todo/confirmation（:506-509）・`finishReportedWork`（:570-602）・`workOfRun`。`handover?.handed` 分岐は session のために残す |
| `generation-prepare.ts` | 部分 | `reportedTexts`、`triggerOf` の todo_changed、`retainedInTransaction`（:305-323。作業中の担当を検索なしで出すもの。`find_toolchain` は固定の段なので補わない）、`routedInputInTransaction` の todos・confirmations・questions、intake・consume・finish、reportNotice、revisions、`shown.todos`・`todoRevisions`、`workChangedInTransaction` の呼出し（:534） |
| `generation-prepare-sources.ts`・`generated-images.ts` | 部分・全削除 | 生成画像の観測は `dialogue_work.id` を鍵にしている（`generated-images.ts:17, 44-110`）。依頼の画像は報告の資源チップで見せるので、観測は削除する（§6 の 4） |
| `generation-executor.ts` | 部分 | `case "work"`（:45-46）、`decline`（:53-115） |
| `generation-handler.ts` | 部分 | pinned（:103-106）、`decline`（:131）、`confirmationId`（:163-165, :191） |
| `generation-tools.ts` | 部分 | `TOOL_NAMES.work`・`workArgs`・`impacts`・`announcement`・`delegateArgs` の判別 union（§2.4 の形に置き換え） |
| `executor-context.ts` | 部分 | `ToolOutcome.confirmationId`、`IMPACT_ORDER`、`Request.confirmationId`、`Handover.workId`、state の `todoRevisions`・`taskRevisions`・`executionRevisions` |
| `executor-delegation.ts` | 部分 | confirmation の import（:2-3, :9-12）、`handOver` の確認・TODO（:175-189, :221-234, :239, :260, :264, :278）、`confirm`、`approval`、approve 分岐、impact と確認の判定、`targetOf`（session の `startSpecialistSession` が target を自分で検査することを確認してから消す）、`assignable`。`delegate` は §2.4 |
| `executor-read.ts`（`read_agents`） | 部分 | `agentsFound` の `visibleWorkRows`・`workByRun`・`t${ref}`・works ループ（:457-552 の該当行）、`toolSummaryTag` の `todo`・`confirmation`（:238-241） |
| `state-text.ts` | 部分 | `todoLine`・`todoDetail`・OUTCOMES・IMPACTS（:36-106）、ledger・確認・archived（:191-256）、戻り値 `todos`。「仕事:」の見出しは session（`specialistLines`）の行のためだけに残す |
| `background-input.ts` | 部分 | :31-66（todos・confirmations・archived） |
| `talk-work-controls.ts` | 部分 | APPROVE・DECLINE・`work` の定義と処理。`discard_for_pending_switch` は残す |
| `routed-talk-work.ts` | 部分 | `revises`・`mode`・`impact` の引数（:49-53）、訂正中の確認（:71, :139-149, :155, :200, :212）、`confirmed` 判定（:237-245）、TODO 題名（:19-20, :219） |
| `routed-actions.ts` | 部分 | `handWith` は `delegate` を呼ぶだけにする（:100-134 を消す）。`answerQuestion`・`impactOf`・`confirmStatement`・`IMPACT_SAID` |
| `routed-turn.ts` | 部分 | `decline`（:72-73, :417-419）、確認の判定（:18-20, :449-450）。**:598 の `deps.work &&` を外す。外さないと `delegate` が出なくなる** |
| `tool-exchange.ts`・`conversation-input.ts`・`delivery-record.ts`・`utterances.ts`・`run-end.ts`・`debug-diagnostics.ts`・`intake.ts`・`resource-ledger.ts`・`agency-sources.ts`・`execution-source.ts`・`work-read.ts`・`operation-ports.ts` | 部分 | `WORK_CONTROL_TOOLS` の todo・confirmation、refs の todo、reportNotice・`todoRefs`、`run-end` の TODO 終了、`workOfRun`、`COMMAND_KIND` の resume、`linkMessageToWorkInTransaction`、`host-work:`・`host-confirmation:` 参照、`confirmedExecutionRequest`、`backgroundWork*`・`visibleWorkRows`・`workResultSummary`、`hostTodosInTransaction`・`todoPageInTransaction`・run 待ちの media hook（`linkOperationJob`・`extendOperationDeadline`・`finishOperation`） |
| `context.ts` | 部分 | `COMMAND_KIND`、`commandNote`、`RoutedInput.pending` の revisions・confirmations・questions、`todos`、`shown.todos`、`todoRevisions`、`retained`、`Accept.resume`、`DialogueDeps.work`・`interactions`。`image`・`music`・`excalidraw` の deps は `readyCatalog` の可否判定に使うので残す |
| `service/index.ts` | 部分 | work の change hook（:130-139）、`createToolchainCommandHandler` の登録（:175）、interactions（:286-291, :337, :393）、`createWorkLedger`（:293-304）、`awaitingWorkConfirmation`・`backgroundWork*`・`confirmedRequest`・`reportExecution`・`createTodoScreenPorts`、`stopUnhandedReply`・`stopReply` の `workOfRun`。`recover()` から §4 を呼ぶ |

### 3.2 dialogue の repository・contracts・controller・contexts・eval（単位 B）

| ファイル | 扱い |
| --- | --- |
| `repository/work.ts` | migration の文字列（:8-80）は1字も変えない。書込み関数は消す。行を読む `researchSourceIds`（`pursuit/forget-research.ts:18`）・`eraseWorkBySource`、忘却で本文を消す更新（:96）は残す（行は残るので、忘却はこれからも効かせる） |
| `repository/confirmation-revisions.ts`・`repository/interactions.ts` | migration は残す。実行時の関数は消す。`MessageVersion` 型は `conversation-offers.ts` へ移す |
| `repository/resources.ts` | `workLinksMigration`・`confirmationRefsMigration` は残す。`setWorkLinks`、`saveConfirmationRefs`、`confirmationResourceUris`、`forgetWorkResources` 内の `dialogue_work` 更新を消す。`workLinksOf` は過去のメッセージのチップ表示で読んでいなければ消す（未確認。読んでいれば残す） |
| `repository/index.ts` | 変えない（migration 一覧は1字も変えない） |
| `contracts/todo-notices.ts` | 全削除 |
| `contracts/command-interactions.ts` | `ANSWER_TEXT_SCHEMA` だけ `execution-command.ts` の近くへ移し、他は消す |
| `contracts/toolchains.ts` | `linkTaskInTransaction`・`requestOfRunInTransaction` を消す（実装は `toolchain-routing.ts:360-362`、単位 C） |
| `contracts/external-output.ts` | `offer(…, confirmation?)` の confirmation（Live 側は単位 C） |
| `controller/index.ts` | `/api/todo-notices*` の3経路（:54-67）と import（:9）。`controller/interactions.ts` は全削除（`/api/toolchain-interactions*`） |
| `contexts/local/` | 全削除: `talk-work`・`talk-approve-confirmation`・`talk-decline-confirmation`・`confirmation-decision`・`confirm`・`confirm-target`・`impact-modify`・`impact-irreversible`・`approved`・`declined`・`answered`・`checked`・`work-answer-arguments`（それぞれ、残った参照が0件であることを grep で確かめてから消す）。部分: `talk-delegate`（`revises`・`mode=execute`・`impact`・「confirmation=承認待ち」） |
| `contexts/system/` | `compact-summary`（:3 の t<n>・c<n>）、`input`（:6-7 の仕事・確認・承認） |
| `contexts/agency/diagnostic-records` | :5「仕事の台帳」、:6「確認は委任ツールが扱う…承認」 |
| `contexts/context-eval/judge-rules` | :17 `work_state_aware` の todos |
| `eval/context/*` | `session-context.ts`・`session.ts`・`case-schema.ts`・`generation-runner.ts`・`judge.ts`・`materialize.ts`・`session-events.ts`・`session-run.ts`・`session-types.ts`・`trajectory.ts`・`fixture-lane.ts` から、work の seed・確認・todo_changed・`work` ツールを除く |

`contracts/index.ts` の `workChangedInTransaction`（:346-347）と `assign` の `details` は統合者が触る（§5.3）。

### 3.3 dialogue の試験（単位 B）

| 扱い | ファイル（`api/domains/dialogue/test/`） |
| --- | --- |
| 削除 | `command-interactions{,-http,-lifecycle,-questions,-work}.test.ts`・`command-interactions.fixture.ts`・`pinned-operation.test.ts`・`work-check-request.test.ts`・`todo-screen.test.ts`・`media-deadline.test.ts`・`structured-continuation.test.ts`、`generation-work.test.ts` の work・承認・通知・TODO 画面の部分（:35-258, :376-442） |
| 書き換え | `generation-work.test.ts` の残り（:286, :312-375, :443, :463 は移す）、`talk-work.test.ts`（:68, :168, :320-647 を「確認なしの依頼」にする）、`talk-work-controls.test.ts`（DISCARD だけ）、`run-end.test.ts`（:41-79）、`action-origin.test.ts`、`state-text.test.ts`、`resources.test.ts`（:174-212）、`generation.test.ts`・`read-tools.test.ts`・`routed-turn.test.ts`・`generation-tools.test.ts`・`specialist.test.ts`（:384-422 の確認付き session は「確認なしで引き継ぐ」に）・`tool-exchange.test.ts`・`conversation-input.test.ts`・`cache-compaction-history.test.ts`・`routed-work-integration.test.ts`、`context-eval/*`、`generation.fixture.ts`・`conversation-steps.fixture.ts`・`specialist.fixture.ts` |

### 3.4 他 domain・application（単位 C）

| ファイル | 扱い |
| --- | --- |
| `domains/tool-runtime/contracts/task-execution.ts:324` | `confirmationId` を削る |
| `domains/development-supervision/{task.ts:177-248, authority.ts:15-30, contracts.ts:202-208, state}` | 確認の証明（`confirmation`・`confirmedRequestInTransaction`）と `ledgerInTransaction` を消す。確認は optional なので、今の確認なしの起動はそのまま通る（`authority.ts:21`）。保存済みの parent が `confirmation` を持つ場合は、`sourceCurrent` を偽にする（§4 で開いている TODO の task は取り消されるので、実害はない） |
| `application/work/development-supervision-host.ts` | `reportExecutionInTransaction`・`confirmedRequestInTransaction`（:37-39, :100-102） |
| `domains/agent-runtime/service/execution-single.ts`・`execution-pipeline.ts` | §1.2 の `startKey`。**これは単位 A が持つ**。C は触らない |
| `domains/agent-runtime/contracts/todo-screen.ts` | 全削除（contracts barrel の :3-8 は統合者） |
| `application/toolchain/task-execution-adapter.ts` | `TASK_TODOS_QUERY`・`TODOS_ARCHIVE`・`TodoLedgerPort`・archive・page を消す。`task:` の lifecycle は休止中の bundle が使うので残す |
| `application/toolchain/toolchain-host.ts` | `todos`・`TodoLedgerPort`・interactions（:1, :72, :74, :115, :119-134） |
| `application/toolchain/toolchain-adapters.ts` | `questionReader`（:443-469）、maintenance（:474, :496） |
| `application/toolchain/toolchain-routing.ts` | `linkTaskInTransaction`・`requestOfRunInTransaction`（:360-362） |
| `application/timers/timer-adapter.ts` | QUESTION の source（:59, :281）。command の質問はもう interactions に入らない |
| `application/server-media.ts` | run を待つ media hook `onJob`・`onFinished`・`onWaiting`（:60-65）を消す。media domain の `onFinished(run)` は execution の無い行でだけ呼ばれ、その行はもう作られない。domain 側の引数を削るかどうかは、試験を見てから決める |
| `application/media/live-bridge.ts:23-24`・`live-voice.ts:150-151`、`domains/live-voice/{service/delivery.ts:61-79, contracts:33}` | 確認の `offer` を消す |
| `capabilities/bundles/agency-todos-screen.bundle.json`（artifact `agency.todos@2-4`、TODO 画面） | ファイルを消すか `.dormant.json` にする。DB に入った版の扱いは seeder 次第で未確認。`capability-seed.test.ts` と `docs/toolchain-extension.md` の手順で、launcher から「TODOリスト」が消えることを確かめる。版の書き換えはしない |
| 試験 | 削除: `toolchain/agency-todos-screen.test.ts`。書き換え: `markdown/archive-research.test.ts`、`media/{generated-image-e2e, music-e2e, live-voice}.test.ts`、`pipelines/pipeline-execution.test.ts`、`toolchain/{task-execution, task-execution-browser}.test.ts`、`toolchain/{toolchain.fixture.ts:914-922, conversation-script.fixture.ts:65-79, :447}`、`world/world-research.fixture.ts:475`、`web-note/{source-inspect, web-note-integration}.test.ts`、`work/{claude-code-toolchain, dots-delegation-conversation, kanban-toolchain, supervision-conversation-controls, supervision-through, supervision-parallel.live}.test.ts`、`timers/{timer-toolchain, timer-question}.test.ts`、stock・weather の toolchain 試験。`/api/todo-notices`・`h.todos()`・`work`・`mode:"confirm"`・`/api/toolchain-interactions` の答えを、依頼項目と `assignment` の答えに置き換える |
| `scripts/nl-acceptance/host.ts:17, 104`、`scripts/router-issue-eval.ts:146` | `/api/toolchain-interactions`・todo を除く。`scripts/context-eval/experiments/2026-10-24-context-window/cases/*.json` は過去の実験記録なので触らない |

### 3.5 agency（application）（単位 A）

| ファイル | 扱い |
| --- | --- |
| `speech.ts` | `reportedTodoIds`・`todoRefs`（:3, :60-66） |
| `host-types.ts` | `backgroundWork`・`backgroundWorkVersion`（:224-228）、`awaitingWorkConfirmation`（:239）、`todoRefs`（:249-250） |
| `assembly.ts` | :49-52、:81-83、:92-95 |
| `work-observation.ts` | `backgroundWork*` を除き、依頼項目の view だけにする |
| `always-on-cycle.ts` | `awaitingWorkConfirmation`（:152）。:123・:160 は `workObservation` のまま（refusal の hunk には触れない） |
| `always-on-scope.ts:92` | `stepWork` の型を `workObservation` の戻り値へ変える（1行）。別セッションと重なるので、統合者がまとめて入れてもよい |
| `always-on.fixture.ts` | :97、:296-298 |
| `work-confirmation.test.ts` | 削除（`scripts/domains.ts:642` は統合者） |
| `research-admission.test.ts`・`router-failure-voice.test.ts`・`web-note-research.test.ts` | `h.todos()` の空の確認を外す。`research-admission.test.ts` は別セッションの試験なので、その行だけ直す |

### 3.6 Web・client・packages（単位 D）

| ファイル | 扱い |
| --- | --- |
| `web/src/domains/dialogue/hooks/todo-notices.ts`・`test/todo-notices.test.tsx` | 全削除 |
| `web/src/domains/dialogue/index.ts:9`、`test/hooks.test.tsx:40-42` | 部分 |
| `web/src/workspace/useWorkspace.ts`（:47, :176, :323）・`Workspace.tsx`（:8, :45, :54-72, :184） | 部分（TODO だけが使っていた launcher・opener も消す） |
| `web/src/components/domains/timers/NotificationCenter.tsx`・`TimerNotifications.tsx`・`.css`（:64-128）・`useNotificationArchive.ts` | TODO の通知カード・source `"todo"`・archive を消す |
| `NotificationCenter.test.tsx`・`TimerNotifications.test.tsx`・`workspace/CompletionNotifications.test.tsx`・`workspace/NotificationArchive.test.tsx` | TODO の部分を消し、Kanban とタイマーだけにする |
| TODO 画面: `web/src/domains/agent-runtime/toolchain-adapter.tsx`・`.test.tsx`、`workspace/agency-todos-launcher.test.tsx`、`workspace/toolchain-adapters.ts:62-67`、`tests/browser/agency-todos.spec.ts`・`fixtures/agency-todos.tsx`、`packages/artifact-ui/src/todo-components.tsx` と `contracts.ts:35-36,356`・`contracts-views.ts:297-301`・`library.tsx:71,179`、`packages/design-system/src/components/TodoWorkspace/*` | 全削除・部分 |
| command の質問フォーム: `client/toolchain-actions.ts:232-256`、`web/src/domains/toolchain-artifacts/questions.ts` とその試験 | `/api/toolchain-interactions` が無くなるので消す |
| `client/dialogue.ts:10, :52-67` | TODO 通知の呼出し |
| `web/src/domains/resources/kind-icon.tsx:34` | `todo` の資源種別。API に `todo` の resource adapter が残っていなければ消す（未確認） |

## 4. 起動時の移行（schema migration にしない）

`dialogue_work`・`dialogue_confirmations`・`command_interactions` への書込みはなくなるので、開いた行が新しく増えることはない。持ち主での取消は SQL の migration ではできない。そこで `dialogue.recover()`（`service/index.ts:386-394`。lifecycle の `dialogue_recovery` は `server-lifecycles.ts:194`）の中で、毎回の起動時に閉じる。開いた行が無ければ何もしないので、実際に効くのは最初の1回だけになる。既存の migration は1字も変えない。

新しいファイルは `api/domains/dialogue/service/todo-closure.ts`（単位 E）:

```ts
/** Closes the TODO rows and confirmations left open when the ledger was retired: the work is cancelled at its owner. */
export function closeRetiredTodosInTransaction(
	deps: Pick<DialogueDeps, "toolchains" | "agents" | "clock">,
	db: Database,
): { closed: number; cancelled: number };
```

| 対象 | 処理 |
| --- | --- |
| `dialogue_work WHERE archived_at IS NULL AND execution IN ('task','pipeline') AND source_ref IS NOT NULL` | `deps.toolchains.taskInTransaction(db, toolchain_revision_id)?.cancelInTransaction(db, conversation_id, source_ref)`。持ち主が無ければ `agents.executions.cancelByUserInTransaction`。持ち主が投げた例外は1行ごとに握って warn のログ（`dialogue.retired_todo_cancel_failed`、本文は渡さない）を出し、閉じる処理は続ける |
| `dialogue_work WHERE archived_at IS NULL`（全種別） | `UPDATE dialogue_work SET status='done', outcome='interrupted', question_id=NULL, question=NULL, archived_at=?, notice_read_at=COALESCE(notice_read_at, ?), revision=revision+1, updated_at=? WHERE archived_at IS NULL`。media と command の run は既存の `interruptUnfinished` が先に中断する |
| `dialogue_confirmations WHERE used_at IS NULL AND superseded_at IS NULL` | `UPDATE … SET superseded_at=?`（列名は `repository/work.ts` の確認表の定義に合わせる） |
| `command_interactions` の開いた行 | 状態列を ended にする（列名は `repository/interactions.ts:9-59` に合わせる） |

呼び出す位置は `recover()` の `interruptUnfinished` の後。`await store.write((db) => closeRetiredTodosInTransaction(deps, db))`、件数は info ログ（`dialogue.retired_todos_closed`）に出す。`recover()` は単位 B のファイルなので、この1行は B が入れる（E の関数名は §5.2 で固定する）。

## 5. 分担

### 5.1 順序

| 順 | 誰が | 内容 |
| --- | --- | --- |
| 0 | 統合者 | 第1段をコミット。§2.1・§2.2 の型（`AssignmentDetails`、`assign` の `details?`、`startKey?`）だけを入れる。実装は入れない |
| 1 | 単位 A・B・C・D・E を並行で | 書込み先は互いに重ならない（§5.2） |
| 2 | 統合者 | §5.3 の共有ファイル、`bun fmt <変更したファイル>`、`bun check`、verify |
| 3 | 独立レビュー1回 → 一度にまとめて修正 | — |
| 4 | 単位 F（文書） | §5.2 |

B と C は、互いに消すものを参照している（B が消す `confirmedRequestInTransaction`・`reportExecutionInTransaction`・`todoPageInTransaction`・`questionInTransaction` を C の利用側が読んでいる）。それぞれの単位の試験は自分のファイルで通し、全体の型検査は順2でまとめて行う。

### 5.2 単位

全単位に共通する指示: サーバーを起動・停止・再起動しない。git の状態を変える操作（checkout・reset・stash・commit）をしない。他人の未コミット変更を戻さない。整形は自分のファイルだけに `bun fmt <files>` で行う。試験は挙げた対象だけを流す。

| 単位 | 目的 | 書込み先（これ以外は触らない） | 触らないもの | 合格条件 |
| --- | --- | --- | --- | --- |
| A 起動と依頼の詳細 | すべての種別を依頼項目として起動・観測・回答・取消し、報告に資源チップを付ける | `api/domains/agent-runtime/service/{execution-single,execution-pipeline}.ts`（`startKey`）、`api/domains/dialogue/service/{agency-actions,agency-state,agency-action-work}.ts`（`closeLegacyTodo` と `eraseWorkBySource` の分岐は残す）、`api/application/agency/{always-on-flow.ts(§2.3 の2つの hunk だけ), always-on-ports.ts(assign), always-on-assignments.ts, work-observation.ts, always-on-cycle.ts(:152 だけ), speech.ts, host-types.ts, assembly.ts, always-on.fixture.ts, router-failure-voice.test.ts, web-note-research.test.ts, research-admission.test.ts(todos の行だけ)}`、`work-confirmation.test.ts` の削除、新しい試験 `api/application/agency/assignment-kinds.test.ts` | `researchRefusals`・`retry` の hunk、dialogue の他の service、`contracts/*` | `bun test api/application/agency/assignment-kinds.test.ts`: (1) fake の画像担当で、依頼 → `進めている` → 完成 → 報告の発言に画像の資源チップ (2) 一つの発言から画像と曲の2件が両方起動する（`startKey`） (3) command 担当の質問 → `assignment(answer)` → 完了 (4) pipeline に `routedSteps` が届く (5) ticket の `details` を書き換えると `agency_origin_stale` (6) music-playback の playlist が会話の一覧に出る。あわせて `bun test api/application/agency/always-on-assignments.test.ts`、`bun run verify -- --domain agent-runtime` |
| B 会話側の削除と `delegate` の入口 | §2.4 と §3.1-3.3 | `api/domains/dialogue/**`。ただし A の3ファイル、`contracts/index.ts`、`contracts/agency-always-on.ts`、`dialogue/index.ts`、E の新しいファイルを除く | 上記の除外、他 domain | `bun run verify -- --domain dialogue`。grep で `deps.work`・`TOOL_NAMES.work`・`approve_confirmation`・`decline_confirmation`・`todo_changed`・`COMMAND_KIND`・`confirmationId`・`IMPACT_ORDER` の残りが0件。`talk-work.test.ts` に「target 付きの依頼（`modify_existing`）も確認なしで依頼項目になり、`dialogue_confirmations` の行数が増えない」と「agenda が会話を担当していなければ `agency_unavailable`」の試験を足す |
| C 他 domain・application の追随 | §3.4 | §3.4 に挙げたファイル（agent-runtime の service は除く） | dialogue、`application/agency/`、`toolchain.ts`、`app-modules.ts` | `bun run verify -- --domain development-supervision`、`--domain tool-runtime`、`--domain capabilities`、`--domain timers`、`--domain live-voice`、`--domain claude-code`、`--domain web-note`、`--domain pipelines` |
| D Web | §3.6 | `web/src/**`、`client/**`、`packages/artifact-ui/**`、`packages/design-system/src/components/TodoWorkspace/**`、`tests/browser/agency-todos*` | `packages/design-system` の他のファイル（別セッションの変更がある） | `bun run verify -- --domain conversation` と `--domain artifact`。grep で `todoNotices`・`todo-notices`・`TodoNotice`・`toolchainInteractions` の残りが0件 |
| E 起動時の移行 | §4 | `api/domains/dialogue/service/todo-closure.ts`、`api/domains/dialogue/test/todo-closure.test.ts` | 他すべて | `bun test api/domains/dialogue/test/todo-closure.test.ts`: 開いた task の TODO が持ち主で取り消され、`interrupted` で閉じる。2回目の呼出しは0件。確認・質問の開いた行も閉じる。持ち主が例外を投げても他の行は閉じる |
| F 文書（順4） | 新しい流れを登録する | `docs/{agency,toolchain,toolchain-extension,task-execution,resources,router-export,delegated-tasks}.md`、`README.md`（:19, :29-30, :48-49, :75） | `spec/` | 「TODO」「c<n>」「t<n>」「work ツール」「todo-notices」の説明が0件。README の機能表の行を「担当への依頼（assignments・作業報告メモ）」にする |

### 5.3 統合者が触る共有ファイル

| ファイル | 変更 |
| --- | --- |
| `api/domains/dialogue/contracts/agency-always-on.ts` | §2.1（順0） |
| `api/domains/dialogue/contracts/index.ts` | `assign` の `details?`（順0）。`workChangedInTransaction`（:346-347）と `export * from "./todo-notices"`（:457）の削除（順2。`always-on-ports.ts` に残った `workChangedInTransaction` の実装もこの時に消す） |
| `api/domains/dialogue/index.ts` | `registerCommandInteractions`（:6）・`INTERACTION_POLICY`（:29-31）の export を消す。`researchSourceIds`（:24）は残す |
| `api/domains/agent-runtime/contracts/index.ts` | todo-screen の export（:3-8） |
| `api/application/toolchain/toolchain.ts` | `todos`（:42, :120, :353）、`interactions`（:437） |
| `api/application/app-modules.ts` | interactions の route 登録（:56, :315） |
| `api/application/agency/always-on-scope.ts:92` | A が触らなかった場合の `stepWork` の型 |
| `api/application/fixed-input-size.test.ts` | `toolsNamed` の `tools.workControls` を `["discard_for_pending_switch"]` にする（:273-278） |
| `api/application/fixed-input-size.json` | `bun run fixed-input-size -- --write` で書き直す |
| `scripts/domains.ts:642` | `work-confirmation.test.ts` を外す |
| `scripts/bundle-budget.json` | 変わっていれば `--write` で記録し直す |
| `spec/README.md` | 本書の索引行 |
| `.s11tnext/catalog*` | bundle を消した時に生成し直すものなら生成し直す（未確認） |

最終確認は `bun check`、そして `bun run verify -- --domain dialogue`・`agent-runtime`・`development-supervision`・`claude-code`・`web-note`・`tool-runtime`・`capabilities`・`timers`・`pipelines`・`live-voice`・`conversation`・`application`。ブラウザ E2E は流さない。

## 6. 危険と、決定で扱っていない箇所

決定と矛盾するものはない。決定が触れていない経路があり、下の各行に最小限の扱いを示す。1・4・5 は利用者の確認を勧める。

| # | 事柄 | 根拠 | 提案（最小の変更） |
| --- | --- | --- | --- |
| 1 | 画面のフォーム送信（pinned run）も run を待つ dispatch と TODO を使う。画像・音楽パネルの「作る」、command の行 | `pinned-operation.ts:16-20, 73-89`、`generation-handler.ts:103-106` | pinned run も `deps.agency.assign`（source はその run）で依頼項目にする。run の返事は空、完成は agent が報告する。agenda が担当していなければ run を `agency_unavailable` で失敗させる。これは「session でも instant でもない依頼はすべて依頼項目にする」を画面の送信にも当てたものとして扱う。**要確認** |
| 2 | session の引き継ぎは `announcement` を使い、保存済み対象への変更は確認していた | `executor-delegation.ts:67-157`、`specialist.test.ts:384` | 予告はホストの `router-announce` 文にする（ローカル経路は今もこれを使っている）。確認は全廃の決定どおり行わない |
| 3 | development-supervision が確認の証明を読む | `development-supervision/task.ts:204-215`、`authority.ts:15-30` | 証明は optional なので消してよい（§3.4）。開いている TODO の実行は §4 で取り消される |
| 4 | 生成画像を会話モデルに見せる観測が、TODO の id を鍵にしている | `generated-images.ts:17, 44-110` | 削除する。画像は報告の発言のチップと、資源番号 `a<n>`（`read` で見られる）で残る。依頼項目の画像をモデルに見せる必要があるなら、別に設計する |
| 5 | command の質問フォーム（タイマーの QUESTION 画面、`/api/toolchain-interactions`）がなくなる | `timer-adapter.ts:59, 281`、`client/toolchain-actions.ts:232-256` | 質問は `assignments[].question` と `assignment(answer)` だけで扱う。画面から答える口は作らない |
| 6 | タイマーや設定のような即時性の高い command も非同期の依頼になり、作業報告のメモ（文書）が毎回1件できる | `keepNote`（`always-on-flow.ts:321-`） | 決定どおり。問題になれば、その担当を `instant` へ移す（データドリブン、版を上げる） |
| 7 | 1つの発言から同じ toolchain の task へ2件頼むと、development-supervision は `parentOfRun(source.runId)` で `operation_id_conflict` になる | `development-supervision/task.ts:216-226` | 第1段から変わっていない。この設計では扱わない |
| 8 | 構造化された回答を求める質問に `assignment(answer)` が文章を渡すと、`invalid_answer` で断られうる | `execution-commands.ts:186-200`、`routed-actions.ts:142-175`（今は会話経路で整形し直している） | 断りをそのまま `refused: <code>` で返す（`always-on-assignments.ts`）。整形の段は足さない |
| 9 | `ExecutionView.progress` を agent-runtime の選んだ実行が設定するか、未確認 | — | 設定されなければ `progress` を出さない（A の試験で確かめる） |
| 10 | TODO 画面の bundle を外したとき、DB に登録済みの artifact 版がどう扱われるか、未確認 | — | C が seeder の挙動を確かめる。版を書き換える方法は取らない |
