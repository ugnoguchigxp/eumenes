import type { Database } from "bun:sqlite";
import type { Run } from "../contracts";
import type { Receipt } from "../../inference";
import type { ConversationOperation } from "./conversation-tools";
import type { DialogueDeps, GenerateInput } from "./context";
import { GENERATE_KIND } from "./context";
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
	if (result.operation.kind === "delegation") {
		if (!deps.delegation) throw new Error("dots_unavailable");
		deps.delegation.invokeInTransaction(
			tx,
			run,
			result.operation.command,
			input.delegationSnapshot,
		);
		const { job } = queue.enqueueInTransaction(tx, {
			scope: "dialogue",
			kind: GENERATE_KIND,
			dedupeKey: `delegation-answer:${run.id}`,
			payload: { runId: run.id },
			subjectRef: run.id,
			lane: "interactive",
			resourceKey: "inference.llm",
			maxAttempts: 1,
			concurrencyKey: `conversation:${run.conversationId}`,
			deadlineAtMs: Date.parse(run.deadlineAt!),
		});
		linkAnswer(tx, run.id, job.id);
	} else {
		if (!agents) throw new Error("invalid_conversation_operation");
		delegateConversation(tx, agents, conversation, run, result.operation, {
			parentJobId: claim.jobId,
			authorizedUrls: input.authorizedUrls,
			actionSnapshot: input.actionSnapshot,
			timerCapability: input.timerCapability,
			requirementCatalog: input.requirementCatalog,
		});
	}
	transition(tx, run.id, run.revision, "queued", clock());
	partials.delete(run.id);
	return "applied";
}
