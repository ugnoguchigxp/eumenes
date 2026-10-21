import type { HandlerDefinition } from "../../queue";
import type { Receipt } from "../../inference";
import type { SettleResult } from "../../memory";
import type { DialogueDeps, GenerateInput, GeneratePayload } from "./context";
import type { ConversationOperation } from "./conversation-tools";
import type { SelectionDraft } from "./selection-trace";
import {
	agentOutcome,
	failedAnswer,
	traceSelection,
	traceOutcome,
	traceFailure,
} from "./selection-trace";
import { retainAdopted, validRetainedSources } from "./retained-toolchains";
import { settleConversationOperation } from "./generation-operation";
import { validAttachmentContext } from "./attachment-context";
import { goalsLayerStale } from "./goals-layer";
import { adoptMemoryWindow, clearShownNotices } from "./memory-window";
import { byId, transition } from "../repository";
import { endRun, type RunEndState } from "./run-end";
import { researchFailed } from "./research-failure-reply";

export type GenerationResult = {
	text: string;
	receipt?: Receipt;
	operation?: ConversationOperation;
	/** An instant toolchain's host-owned answer. */
	hostAnswer?: true;
	selection?: SelectionDraft;
	recallPins?: Array<{ messageId: string; digest: string }>;
};
export type GenerationHandler = HandlerDefinition<
	GeneratePayload,
	GenerateInput,
	GenerationResult
>;
/** Adoption and execution dispatch share the existing queue writer transaction. */
export function createGenerationSettlement(
	deps: DialogueDeps,
	partials: Map<string, string>,
): GenerationHandler["settleInTransaction"] {
	const { larm, memory, agents, clock, id, conversation } = deps;
	return (tx, claim, input, outcome) => {
		const run = byId(tx, claim.payload.runId);
		if (!run) return "stale";
		if (outcome.type === "success") {
			const answerText = outcome.result.text;
			if (
				!input ||
				run.status !== "running" ||
				run.revision !== input.revision
			) {
				return "stale";
			}
			if (!validAttachmentContext(deps, tx, input, run.conversationId)) {
				endRun(deps, tx, run, "failed", "attachment_source_unavailable");
				return failedAnswer(deps, tx, run.id, "attachment_source_unavailable");
			}
			if (!validRetainedSources(deps, tx, input)) {
				endRun(deps, tx, run, "failed", "toolchain_context_stale");
				return failedAnswer(deps, tx, run.id, "toolchain_context_stale");
			}
			if (
				outcome.result.hostAnswer &&
				outcome.result.selection?.toolchainRevisionId &&
				!deps.toolchains?.cardInTransaction(
					tx,
					outcome.result.selection.toolchainRevisionId,
				)
			) {
				endRun(deps, tx, run, "failed", "toolchain_unavailable");
				return failedAnswer(deps, tx, run.id, "toolchain_unavailable");
			}
			const selectionId = traceSelection(
				deps,
				tx,
				run.id,
				outcome.result.selection,
			);
			if (outcome.result.operation) {
				const settled = settleConversationOperation(
					deps,
					partials,
					tx,
					claim,
					run,
					input,
					{ ...outcome.result, operation: outcome.result.operation },
				);
				if (settled === "applied")
					retainAdopted(
						deps,
						tx,
						run,
						input,
						selectionId,
						outcome.result.operation.revisionId,
					);
				return settled;
			}
			if (
				input.agent &&
				agents &&
				!agents.validAnswerInTransaction(tx, input.agent)
			) {
				endRun(deps, tx, run, "failed", "report_invalidated");
				agents.failAnswerInTransaction(tx, run.id, "report_invalidated");
				return failedAnswer(deps, tx, run.id, "report_invalidated");
			}
			// The goals layer stands apart from the memory window: a quiet window still has to see its goals change.
			const goalsStale = goalsLayerStale(deps.goals, tx, input.goals);
			if (goalsStale || (input.memory && memory)) {
				const adopted: SettleResult = goalsStale
					? { ok: false, reason: "memory_stale" }
					: adoptMemoryWindow(
							memory!,
							tx,
							run,
							input.memory!,
							outcome.result.recallPins,
						);
				if (!adopted.ok) {
					if (run.agentTaskId)
						agents?.failAnswerInTransaction(tx, run.id, adopted.reason);
					endRun(deps, tx, run, "failed", adopted.reason);
					return failedAnswer(deps, tx, run.id, adopted.reason);
				}
			}
			// No model was asked: the request is accepted as the host's own answer, so the speech standing on it proceeds.
			if (researchFailed(input.agent) || outcome.result.hostAnswer) {
				const requestId = larm.requestFor?.(tx, run.id, "llm");
				if (
					requestId &&
					larm.acceptHostAnswerInTransaction &&
					!larm.acceptHostAnswerInTransaction(tx, requestId)
				) {
					if (run.agentTaskId)
						agents?.failAnswerInTransaction(tx, run.id, "permission_revoked");
					endRun(deps, tx, run, "failed", "permission_revoked");
					return failedAnswer(deps, tx, run.id, "permission_revoked");
				}
			}
			if (
				outcome.result.receipt &&
				!larm.acceptInTransaction?.(tx, outcome.result.receipt)
			) {
				memory?.discardUsageInTransaction(tx, run.id);
				if (run.agentTaskId)
					agents?.failAnswerInTransaction(tx, run.id, "permission_revoked");
				endRun(deps, tx, run, "failed", "permission_revoked");
				return failedAnswer(deps, tx, run.id, "permission_revoked");
			}
			if (input.agent && agents)
				agents.completeAnswerInTransaction(tx, input.agent);
			const messageId = id();
			conversation.appendInTransaction(tx, {
				id: messageId,
				conversationId: run.conversationId,
				role: "assistant",
				text: answerText,
				createdAt: clock(),
				runId: run.id,
			});
			// The notices this answer carried are shown once: only an adopted answer clears them.
			if (input.memory && memory)
				clearShownNotices(memory, tx, run, input.memory);
			if (outcome.result.receipt?.delivery?.version === 2)
				conversation.recordAnswerDeliveryInTransaction(
					tx,
					run.id,
					run.conversationId,
					outcome.result.receipt.delivery,
				);
			const done = endRun(deps, tx, run, "completed", null, messageId);
			if (done) {
				traceOutcome(deps, tx, run.id, agentOutcome(input.agent));
				if (outcome.result.hostAnswer)
					retainAdopted(
						deps,
						tx,
						run,
						input,
						selectionId,
						outcome.result.selection?.toolchainRevisionId,
					);
			}
			return done ? "applied" : "stale";
		}
		// A run that is already terminal (e.g. cancelled) keeps its state.
		if (run.status !== "queued" && run.status !== "running") return "applied";
		const next: [RunEndState | "queued", string | null] =
			outcome.type === "retry"
				? ["queued", outcome.errorCode]
				: outcome.type === "failed"
					? ["failed", outcome.errorCode]
					: outcome.type === "expired"
						? ["failed", "deadline_exceeded"]
						: ["interrupted", outcome.errorCode];
		if (run.agentTaskId)
			agents?.failAnswerInTransaction(tx, run.id, next[1] ?? "answer_failed");
		if (next[0] !== "queued")
			traceFailure(deps, tx, run.id, outcome.type, next[1]);
		const moved =
			next[0] === "queued"
				? transition(tx, run.id, run.revision, "queued", clock(), next[1])
				: endRun(deps, tx, run, next[0], next[1]);
		return moved ? "applied" : "stale";
	};
}
