import type { Database } from "bun:sqlite";
import type { Run } from "../contracts";
import type { Receipt } from "../../inference";
import type { ConversationOperation } from "./conversation-tools";
import type { DialogueDeps, GenerateInput } from "./context";
import { COMMAND_KIND } from "./context";
import { transition, linkAnswer } from "../repository";
import { delegateConversation } from "./delegate-conversation";
import { operationRejection } from "./operation-authority";
export function settleConversationOperation(
	deps: DialogueDeps,
	partials: Map<string, string>,
	tx: Database,
	claim: { jobId: string; attempt: number; generation: number },
	run: Run,
	input: GenerateInput,
	result: { operation: ConversationOperation; receipt?: Receipt },
): "applied" | { status: "failed"; errorCode: string } {
	const { larm, memory, worldContext, clock, agents, conversation, queue } =
		deps;

	const rejected = operationRejection(tx, {
		inference: larm,
		receipt: result.receipt,
		memory,
		memoryView: input.memory,
		world: worldContext,
		worldView: input.world,
		settle: {
			runId: run.id,
			conversationId: run.conversationId,
			jobId: claim.jobId,
			attempt: claim.attempt,
			generation: claim.generation,
			inference: result.receipt
				? {
						requestId: result.receipt.requestId,
						attemptId: result.receipt.attemptId,
					}
				: null,
			nowMs: Date.parse(clock()),
		},
	});
	if (rejected) {
		if (input.world)
			worldContext?.releaseInTransaction(tx, run.id, run.conversationId);
		transition(tx, run.id, run.revision, "failed", clock(), rejected);
		return { status: "failed", errorCode: rejected };
	}
	// The initial receipt stays pending; the final answer is a later attempt
	// on the same policy request. No control text is adopted or collected.
	if (input.world)
		worldContext?.releaseInTransaction(tx, run.id, run.conversationId);
	const chosen = result.operation;
	let resolved: ReturnType<
		NonNullable<DialogueDeps["toolchains"]>["resolveInTransaction"]
	>;
	try {
		if (!deps.toolchains) throw new Error("toolchain_unavailable");
		// The exact revision offered must still be active (and its package available).
		resolved = deps.toolchains.resolveInTransaction(tx, chosen.revisionId);
	} catch {
		transition(
			tx,
			run.id,
			run.revision,
			"failed",
			clock(),
			"toolchain_unavailable",
		);
		deps.toolchains?.settleSelectionInTransaction(tx, run.id, {
			outcome: "failed",
			code: "toolchain_unavailable",
		});
		return { status: "failed", errorCode: "toolchain_unavailable" };
	}
	const { runtime, packageRevisionId } = resolved;
	if (
		runtime.execution === "music-create" ||
		runtime.execution === "music-playback"
	) {
		if (!deps.music) throw new Error("music_unavailable");
		const original = conversation
			.messagesInTransaction(tx, run.conversationId)
			.find((m) => m.id === run.inputMessageId)!.text;
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
		// A command sub-agent turns the request into one typed operation of the package.
		const { job } = queue.enqueueInTransaction(tx, {
			scope: "dialogue",
			kind: COMMAND_KIND,
			dedupeKey: `toolchain-command:${run.id}`,
			payload: { runId: run.id, toolchainRevisionId: chosen.revisionId },
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
