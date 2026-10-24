import { getLogger } from "../../../infrastructure/logger";
import type { Tx } from "../../queue";
import type { Run, Resubmit } from "../contracts";
import {
	byRequest,
	insert,
	latestRunOfMessage,
	runViewing,
	saveDeadlinePolicy,
	setRunViewing,
	userInputAfter,
} from "../repository";
import {
	DEFAULT_DEADLINE_MS,
	GENERATE_KIND,
	type DialogueDeps,
} from "./context";
import { eventFields, SIDE_EFFECTS } from "./event-fields";
import { endRun } from "./run-end";
const log = getLogger("dialogue");

/** Why the latest utterance can no longer be edited (the prompt edit design, section 3). */
export type ResubmitRefusal =
	| "not_found"
	| "not_latest"
	| "already_acted"
	| "specialist_turn"
	| "not_editable"
	| "empty_text";

type Resubmitted =
	| { ok: true; run: Run; fresh: boolean; stopped?: Run }
	| { ok: false; code: ResubmitRefusal };

/**
 * Stop the latest utterance's run, correct its text and answer it again (the prompt edit design, section 4):
 * one writer transaction, so a generation that commits an action first makes the edit refused, and an edit
 * that commits first makes that generation's adoption fail on the run's state.
 */
export function createResubmit(deps: DialogueDeps) {
	const { store, conversation, continuity, queue, larm, agents, clock, id } =
		deps;
	function resubmitInTransaction(
		db: Tx,
		conversationId: string,
		messageId: string,
		input: Resubmit,
	): Resubmitted {
		const repeated = byRequest(db, input.requestId);
		if (repeated) {
			if (
				repeated.inputMessageId !== messageId ||
				conversation.messageInTransaction(db, messageId)?.message.text !==
					input.text
			)
				throw new Error("request_conflict");
			return { ok: true, run: repeated, fresh: false };
		}
		if (!input.text) return { ok: false, code: "empty_text" };
		const found = conversation.messageInTransaction(db, messageId);
		const run = latestRunOfMessage(db, messageId);
		if (
			!found ||
			!run ||
			found.message.conversationId !== conversationId ||
			found.message.role !== "user"
		)
			return { ok: false, code: "not_found" };
		if (run.specialistSessionId) return { ok: false, code: "specialist_turn" };
		if (
			(run.sourceKind !== "manual" && run.sourceKind !== "voice") ||
			run.pinnedToolchainId ||
			(found.message.presentation ?? "conversation") !== "conversation"
		)
			return { ok: false, code: "not_editable" };
		if (userInputAfter(db, run)) return { ok: false, code: "not_latest" };
		// Once a generation committed an action from the utterance, or an answer was adopted, it stays as said.
		const events = continuity.events.ofMessageInTransaction(db, messageId);
		if (
			!["queued", "running", "cancelled"].includes(run.status) ||
			!events.some(
				(event) => event.type === "said" && event.status === "pending",
			) ||
			events.some((event) => {
				// Reading (finding a toolchain, recalling memory, an instant answer) commits nothing.
				const fields = eventFields(event);
				return (
					event.type === "acted" &&
					SIDE_EFFECTS.has(String(fields.action)) &&
					!fields.instant
				);
			})
		)
			return { ok: false, code: "already_acted" };
		const now = clock();
		let stopped: Run | undefined;
		if (run.status === "queued" || run.status === "running") {
			if (run.agentTaskId) agents?.cancelTreeInTransaction(db, run.id);
			endRun(deps, db, run, "cancelled", "edited");
			deps.toolchains?.settleSelectionInTransaction(db, run.id, {
				outcome: "cancelled",
				code: "edited",
			});
			// The run already ended: the job's own cancel finds nothing left to end.
			if (run.jobId) queue.cancelInTransaction(db, run.jobId, "edited");
			stopped = run;
		}
		// The correction hook rewrites the pending `said` and moves the window version on.
		if (input.text !== found.message.text)
			conversation.correctInTransaction(db, {
				messageId,
				text: input.text,
				at: now,
			});
		const runId = id();
		const deadlineAtMs = Date.parse(now) + DEFAULT_DEADLINE_MS;
		const generated = queue.enqueueInTransaction(db, {
			scope: "dialogue",
			kind: GENERATE_KIND,
			dedupeKey: runId,
			payload: { runId },
			subjectRef: runId,
			lane: "interactive",
			resourceKey: "inference.llm",
			maxAttempts: 1,
			concurrencyKey: `conversation:${conversationId}`,
			deadlineAtMs,
		});
		const next: Run = {
			id: runId,
			requestId: input.requestId,
			conversationId,
			// The edit is typed: the utterance id stays with the run voice-dialogue made for it.
			utteranceId: null,
			status: "queued",
			revision: 0,
			inputMessageId: messageId,
			answerMessageId: null,
			error: null,
			jobId: generated.job.id,
			deadlineAt: new Date(deadlineAtMs).toISOString(),
			sourceKind: "manual",
			pinnedToolchainId: null,
			scheduleId: null,
			occurrenceId: null,
			specialistSessionId: null,
			createdAt: now,
			updatedAt: now,
		};
		larm.captureInTransaction?.(db, runId, "llm", deadlineAtMs);
		insert(db, next);
		// The input and its new answer are one exchange (memory pairs a run's messages).
		conversation.moveToRunInTransaction(db, messageId, runId);
		saveDeadlinePolicy(db, runId, false);
		const viewing = runViewing(db, run.id);
		if (viewing) setRunViewing(db, runId, viewing);
		return { ok: true, run: next, fresh: true, stopped };
	}
	return {
		resubmitInTransaction,
		async resubmit(
			conversationId: string,
			messageId: string,
			input: Resubmit,
		): Promise<Resubmitted> {
			const result = await store.write((db) =>
				resubmitInTransaction(db, conversationId, messageId, input),
			);
			log.info(
				result.ok ? "dialogue.resubmitted" : "dialogue.resubmit_refused",
				result.ok
					? {
							requestId: result.run.requestId,
							runId: result.run.id,
							subjectId: messageId,
						}
					: { subjectId: messageId, reason: result.code },
			);
			if (!result.ok || !result.fresh) return result;
			if (result.stopped) {
				if (result.stopped.jobId)
					queue.flushCancellations([result.stopped.jobId]);
				await larm.cancelSubject?.(result.stopped.id);
			}
			queue.wake();
			return result;
		},
	};
}
