import { originalRequestInTransaction } from "./request-context";
import type { Database } from "bun:sqlite";
import type { Run } from "../contracts";
import type { Receipt } from "../../inference";
import type { ConversationOperation } from "./conversation-tools";
import type { DialogueDeps, GenerateInput } from "./context";
import { COMMAND_KIND } from "./context";
import { transition, linkAnswer } from "../repository";
import { endRun } from "./run-end";
import { delegateConversation } from "./delegate-conversation";
import { operationRejection } from "./operation-authority";

/** Accept the natural-language answer atomically with the rest of the run's settlement. */
function acceptAnswer(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	chosen: ConversationOperation,
	bound: boolean,
): { ok: true; interactionId: string } | { ok: false; code: string } {
	if (!bound || !deps.interactions || !chosen.questionRef)
		return { ok: false, code: "question_not_open" };
	tx.exec("SAVEPOINT dialogue_nl_answer");
	try {
		const accepted = deps.interactions.acceptNaturalLanguageInTransaction(
			tx,
			run,
			{
				questionRef: chosen.questionRef,
				functionName: chosen.functionName,
				revisionId: chosen.revisionId,
				request: chosen.request,
			},
		);
		tx.exec("RELEASE dialogue_nl_answer");
		return accepted;
	} catch (e) {
		tx.exec("ROLLBACK TO dialogue_nl_answer");
		tx.exec("RELEASE dialogue_nl_answer");
		return {
			ok: false,
			code:
				e instanceof Error && /^[a-z_]+$/.test(e.message)
					? e.message
					: "answer_failed",
		};
	}
}
export function settleConversationOperation(
	deps: DialogueDeps,
	partials: Map<string, string>,
	tx: Database,
	claim: { jobId: string; attempt: number; generation: number },
	run: Run,
	input: GenerateInput,
	result: {
		operation: ConversationOperation;
		receipt?: Receipt;
		/** Messages the exchanges recalled into the deciding prompt stand on. */
		recallPins?: Array<{ messageId: string; digest: string }>;
	},
): "applied" | { status: "failed"; errorCode: string } {
	const { larm, memory, clock, agents, conversation, queue } = deps;

	const rejected = operationRejection(tx, {
		inference: larm,
		receipt: result.receipt,
		memory,
		memoryWindow: input.memory,
		recallPins: result.recallPins,
		goals: deps.goals,
		goalsLayer: input.goals,
		settle: { runId: run.id },
	});
	if (rejected) {
		endRun(deps, tx, run, "failed", rejected);
		return { status: "failed", errorCode: rejected };
	}
	// The initial receipt stays pending; the final answer is a later attempt
	// on the same policy request. No control text is adopted or collected.
	const chosen = result.operation;
	let resolved: ReturnType<
		NonNullable<DialogueDeps["toolchains"]>["resolveInTransaction"]
	>;
	try {
		if (!deps.toolchains) throw new Error("toolchain_unavailable");
		// The exact revision offered must still be active (and its package available).
		resolved = deps.toolchains.resolveInTransaction(tx, chosen.revisionId);
	} catch {
		endRun(deps, tx, run, "failed", "toolchain_unavailable");
		deps.toolchains?.settleSelectionInTransaction(tx, run.id, {
			outcome: "failed",
			code: "toolchain_unavailable",
		});
		return { status: "failed", errorCode: "toolchain_unavailable" };
	}
	const { runtime, packageRevisionId } = resolved;
	if (runtime.execution === "excalidraw") {
		if (!deps.excalidraw) throw new Error("excalidraw_unavailable");
		const original = originalRequestInTransaction(tx, conversation, run);
		const saved = deps.excalidraw.startInTransaction(tx, {
			runId: run.id,
			conversationId: run.conversationId,
			question: chosen.request,
			originalRequest: original,
			deadline: Date.parse(run.deadlineAt!),
		});
		linkAnswer(tx, run.id, saved.jobId);
	} else if (runtime.execution === "image") {
		if (!deps.image) throw new Error("image_unavailable");
		const original = originalRequestInTransaction(tx, conversation, run);
		const saved = deps.image.startInTransaction(tx, {
			runId: run.id,
			conversationId: run.conversationId,
			question: chosen.request,
			originalRequest: original,
			deadline: Date.parse(run.deadlineAt!),
		});
		linkAnswer(tx, run.id, saved.jobId);
	} else if (
		runtime.execution === "music-create" ||
		runtime.execution === "music-playback"
	) {
		if (!deps.music) throw new Error("music_unavailable");
		const original = originalRequestInTransaction(tx, conversation, run);
		// The music domain's planner is this toolchain's sub-agent (profile, SKILL, tools).
		const saved = (
			runtime.execution === "music-create"
				? deps.music.startInTransaction
				: deps.music.startPlaybackInTransaction
		)(tx, {
			runId: run.id,
			conversationId: run.conversationId,
			question: chosen.request,
			originalRequest: original,
			deadline: Date.parse(run.deadlineAt!),
		});
		linkAnswer(tx, run.id, saved.jobId);
	} else if (runtime.execution === "command") {
		// The utterance may answer a question this toolchain's sub-agent asked earlier: the host
		// checks the target and accepts it once, then this run resumes that interaction.
		let interactionId: string | undefined;
		if (chosen.questionRef) {
			const answered = acceptAnswer(deps, tx, run, chosen, !!runtime.binding);
			if (!answered.ok) {
				endRun(deps, tx, run, "failed", answered.code);
				deps.toolchains?.settleSelectionInTransaction(tx, run.id, {
					outcome: "failed",
					code: answered.code,
				});
				return { status: "failed", errorCode: answered.code };
			}
			interactionId = answered.interactionId;
		}
		// A command sub-agent turns the request into one typed operation of the package.
		const { job } = queue.enqueueInTransaction(tx, {
			scope: "dialogue",
			kind: COMMAND_KIND,
			dedupeKey: `toolchain-command:${run.id}`,
			payload: {
				runId: run.id,
				toolchainRevisionId: chosen.revisionId,
				...(interactionId ? { interactionId } : {}),
			},
			subjectRef: run.id,
			lane: "interactive",
			resourceKey: "inference.llm",
			maxAttempts: 1,
			concurrencyKey: `conversation:${run.conversationId}`,
			deadlineAtMs: Date.parse(run.deadlineAt!),
		});
		linkAnswer(tx, run.id, job.id);
	} else {
		if (!agents || !runtime.route)
			throw new Error("invalid_conversation_operation");
		const root = delegateConversation(
			tx,
			agents,
			conversation,
			run,
			{
				route: runtime.route,
				request: chosen.request,
				packageRevisionId,
				researcher: runtime.researcher,
			},
			{
				parentJobId: claim.jobId,
			},
		);
		deps.toolchains!.linkTaskInTransaction(tx, run.id, root.taskId);
	}
	transition(tx, run.id, run.revision, "queued", clock());
	partials.delete(run.id);
	return "applied";
}
