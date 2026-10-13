import type { AnswerTicket } from "../../agent-runtime";
import { PREFETCH_BYTES } from "../../memory";
import type { HandlerDefinition } from "../../queue";
import {
	compileContext,
	noticeMessage,
	windowIsEmpty,
} from "./context-compiler";
import { prepareRouting } from "./delegate-conversation";
import { researchResultContext } from "./research-result-context";
import { markWorld, byId, transition } from "../repository";
import type { Run } from "../contracts";
import {
	DEFAULT_DEADLINE_MS,
	type DialogueDeps,
	type GenerateInput,
	type GeneratePayload,
} from "./context";
import type { Progress } from "./progress";

/** The claim-time half of a generation: fixes memory, World and history inside the claim transaction. */
export function createPrepare(
	deps: DialogueDeps,
	{ partials }: Pick<Progress, "partials">,
): HandlerDefinition<
	GeneratePayload,
	GenerateInput,
	unknown
>["prepareInTransaction"] {
	const { conversation, larm, clock, memory, agents, worldContext } = deps;
	return (tx, claim) => {
		const run = byId(tx, claim.payload.runId);
		if (!run || run.status !== "queued" || run.jobId !== claim.jobId)
			return { status: "stale", reason: "run_not_queued" };
		let agent: AnswerTicket | undefined;
		if (run.agentTaskId && agents) {
			try {
				agent = agents.prepareAnswerInTransaction(tx, run.id);
			} catch {
				transition(
					tx,
					run.id,
					run.revision,
					"failed",
					clock(),
					"report_invalidated",
				);
				agents.failAnswerInTransaction(tx, run.id, "report_invalidated");
				return { status: "stale", reason: "report_invalidated" };
			}
		}
		if (!transition(tx, run.id, run.revision, "running", clock()))
			return { status: "stale", reason: "run_changed" };
		const current = byId(tx, run.id) as Run;
		let window: ReturnType<
			NonNullable<typeof memory>["windowForRunInTransaction"]
		> = null;
		try {
			window =
				memory?.windowForRunInTransaction(tx, run.conversationId) ?? null;
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "memory_blocked")
				throw error;
			if (run.agentTaskId)
				agents?.failAnswerInTransaction(tx, run.id, "memory_blocked");
			// Never silently drop memory and continue; end the run with the reason.
			transition(
				tx,
				run.id,
				current.revision,
				"failed",
				clock(),
				"memory_blocked",
			);
			return { status: "stale", reason: "memory_blocked" };
		}
		// World reads in the SAME transaction as Memory's recall and shares its budget.
		const world =
			worldContext && !agent?.failureCode && !agent?.actionPayload
				? worldContext.prepareInTransaction(tx, {
						runId: run.id,
						conversationId: run.conversationId,
						jobId: claim.jobId,
						attempt: claim.attempt,
						generation: claim.generation,
						reservedBytes: window
							? // The prefetch and this turn's recall share PREFETCH_BYTES: all of it is reserved.
								window.longTerm.bytes +
								window.shortTerm.bytes +
								PREFETCH_BYTES +
								Buffer.byteLength(noticeMessage(window)?.content ?? "", "utf8")
							: 0,
						nowMs: Date.parse(clock()),
					})
				: undefined;
		if (world?.status === "blocked") {
			// Blocked is its own outcome: the run reports World as used+blocked.
			markWorld(tx, run.id, "blocked");
			if (run.agentTaskId)
				agents?.failAnswerInTransaction(tx, run.id, world.reason);
			// Never silently run without the World context; end the run with the reason.
			transition(tx, run.id, current.revision, "failed", clock(), world.reason);
			return { status: "stale", reason: world.reason };
		}
		if (world?.status === "ready") {
			markWorld(tx, run.id, "used");
			// Whatever an earlier World-less attempt streamed is withdrawn.
			partials.delete(run.id);
		}
		if (larm.captureInTransaction && !larm.requestFor?.(tx, run.id, "llm")) {
			const snapshot = larm.snapshotInTransaction?.(tx);
			if (snapshot) {
				for (const p of ["llm", "asr", "tts"] as const) {
					snapshot.routes[p].mode = "larm-only";
					snapshot.routes[p].cloudAllowed = false;
				}
				larm.captureInTransaction(
					tx,
					run.id,
					"llm",
					claim.deadlineAtMs ?? Date.now() + DEFAULT_DEADLINE_MS,
					snapshot,
				);
			}
		}
		const compiled = compileContext(
			tx,
			current,
			conversation,
			larm.snapshotInTransaction?.(tx).general,
			window,
		);
		let messages = compiled.messages;
		if (agent?.projection || agent?.failureCode)
			messages = researchResultContext(
				messages,
				compiled.references,
				agent.projection ?? undefined,
				agent.failureCode,
			);
		// Notices, prefetched exchanges and World come last, right before the current input; the
		// operation results and the policy added below then land between them and the input.
		messages.splice(
			messages.length - 1,
			0,
			...compiled.tail,
			...(world?.status === "ready"
				? [{ role: "system" as const, content: world.block }]
				: []),
		);
		// This run's context is fixed by the host: the server must neither trim nor reorder it.
		const requestId = larm.requestFor?.(tx, run.id, "llm");
		if (requestId) larm.setContextPolicyInTransaction?.(tx, requestId, "exact");
		let actionResultIndex: number | undefined;
		if (agent?.actionPayload) {
			const operation = JSON.parse(agent.actionPayload);
			actionResultIndex = messages.length - 1;
			messages[0]!.content +=
				"\n操作は既に終了しています。操作結果の事実を、あなた自身の言葉と指定の口調で短く伝えてください。操作をやり直したり、結果にない成功や時間を作ったりしません。全itemsの状態を必要に応じて説明し、complete=falseなら一覧が部分的であることを伝えます。";
			messages.splice(messages.length - 1, 0, {
				role: "user",
				content: JSON.stringify({ actionResult: operation }),
			});
		}

		const delegated =
			!run.agentTaskId && run.sourceKind !== "schedule"
				? deps.delegation?.prepareInTransaction(tx, run)
				: undefined;
		const musicResult = deps.music?.resultInTransaction(tx, run.id);
		if (delegated?.receipt) {
			messages[0]!.content +=
				"\n委任操作は既に保存されています。delegationResultをデータとして読み、受付・質問待ち・停止要求・完了の違いを保って事実だけを短く伝えてください。新しい操作をせず、dotsの未確認の成功を作りません。";
			messages.splice(messages.length - 1, 0, {
				role: "user",
				content: JSON.stringify({ delegationResult: delegated.receipt }),
			});
		}
		if (musicResult) {
			messages[0]!.content +=
				"\n音楽担当の操作は終了しています。musicResultは操作結果のデータです。kind=playlistなら保存曲の検索結果であり、新しく制作した曲ではありません。completedでプレイヤーやプレイリストを開く依頼なら、「プレイヤーを開きました。どうぞ」程度の短い案内だけを指定の口調で返します。曲名・検索条件・件数・曲IDの一覧や、Artifactという内部名称・操作説明は付けません。過去の回答に一覧があっても繰り返さず、今回の表示完了だけを案内します。trackIdsは再生用の参照IDであり曲名ではありません。曲の説明を求められたときは確認できる情報で答え、IDから曲名や内容を推測しません。trackIdsが空なら、該当する曲が見つからなかったことを短く伝えます。楽曲生成のcompletedなら制作完了を短く伝えます。failedまたはcancelledなら失敗・取消を正しく伝え、開いた・再生したと断定しません。エラーコードは読み上げず、意味を自然な言葉で伝えます。音声を聴いた評価や未実行の再生を作らず、新しい生成をしません。";
			messages.splice(messages.length - 1, 0, {
				role: "user",
				content: JSON.stringify({ musicResult }),
			});
		}
		const note = claim.payload.commandNote;
		if (note) {
			messages[0]!.content +=
				"\n操作担当は依頼を実行する前に確認が必要と判断しました。commandQuestionは担当の確認事項のデータです。その内容を自分の言葉と指定の口調で一つだけ尋ねます。操作は実行していません。";
			messages.splice(messages.length - 1, 0, {
				role: "user",
				content: JSON.stringify({ commandQuestion: note }),
			});
		}
		// A new decision: the execute phase retrieves the toolchains for this request.
		// While an operation's result (or a sub-agent's question) is phrased, nothing new is offered.
		const routing =
			!musicResult && !delegated?.receipt && !note
				? prepareRouting(tx, deps, run, messages, {
						dots: !!delegated && delegated.available !== false,
					})
				: undefined;
		// A prefetch left out of this turn is neither sent nor checked at adoption.
		const prepared =
			window && compiled.prefetchDropped
				? { ...window, prefetch: { text: "", pins: [], bytes: 0 } }
				: window;
		return {
			status: "ready",
			input: {
				runId: run.id,
				revision: current.revision,
				messages,
				actionResultIndex,
				...routing,
				agent,
				// An empty window still travels: the exchanges recalled for this turn are checked against it.
				...(prepared
					? {
							memory: {
								window: memory!.preparedWindow(
									prepared,
									compiled.windowStartOrdinal,
								),
								...(windowIsEmpty(prepared) ? { quiet: true as const } : {}),
							},
						}
					: {}),
				...(world?.status === "ready"
					? { world: { context: world.context } }
					: {}),
				...(world?.status === "ready" || run.worldUsed
					? { worldUsed: true }
					: {}),
				requestId: larm.requestFor?.(tx, run.id, "llm") ?? undefined,
			},
		};
	};
}
