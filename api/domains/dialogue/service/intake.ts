import { getLogger } from "../../../infrastructure/logger";
import type { TargetDefinition } from "../../scheduler";
import type { Tx } from "../../queue";
import {
	promptTargetSchema,
	type PromptTarget,
	type Run,
	type Submit,
} from "../contracts";
import { byRequest, byUtterance, insert } from "../repository";
import {
	DEFAULT_DEADLINE_MS,
	GENERATE_KIND,
	PROMPT_TARGET_KIND,
	type Accept,
	type DialogueDeps,
} from "./context";
const log = getLogger("dialogue");

/** Input acceptance: idempotent run creation, manual/voice submit and the schedule target. */
export function createIntake(deps: DialogueDeps) {
	const { store, conversation, larm, queue, clock, id } = deps;
	/** One transaction: user message + run + queue job. Throws (rolling all back) when the queue is full. */
	function acceptInTransaction(
		db: Tx,
		input: Accept,
	): { run: Run; fresh: boolean } {
		const existing =
			byRequest(db, input.requestId) ??
			(input.utteranceId ? byUtterance(db, input.utteranceId) : null);
		if (existing) {
			const original = conversation
				.messagesInTransaction(db, existing.conversationId)
				.find((message) => message.id === existing.inputMessageId);
			if (
				existing.conversationId !== input.conversationId ||
				original?.text !== input.text ||
				existing.utteranceId !== (input.utteranceId ?? null)
			)
				throw new Error("request_conflict");
			return { run: existing, fresh: false };
		}
		const now = clock();
		const runId = id();
		const messageId = id();
		conversation.appendInTransaction(db, {
			id: messageId,
			conversationId: input.conversationId,
			role: "user",
			text: input.text,
			createdAt: now,
			runId,
		});
		const deadlineAtMs =
			Date.parse(now) + (input.deadlineMs ?? DEFAULT_DEADLINE_MS);
		const generated = queue.enqueueInTransaction(db, {
			// Scheduled runs get their own scope so background work cannot exhaust interactive acceptance.
			scope: input.sourceKind === "schedule" ? "dialogue.schedule" : "dialogue",
			kind: GENERATE_KIND,
			dedupeKey: runId,
			payload: { runId },
			subjectRef: runId,
			lane: input.sourceKind === "schedule" ? "background" : "interactive",
			resourceKey: "inference.llm",
			maxAttempts: 1,
			concurrencyKey: `conversation:${input.conversationId}`,
			deadlineAtMs,
		});
		const run: Run = {
			id: runId,
			requestId: input.requestId,
			conversationId: input.conversationId,
			utteranceId: input.utteranceId ?? null,
			status: "queued",
			revision: 0,
			inputMessageId: messageId,
			answerMessageId: null,
			error: null,
			jobId: generated.job.id,
			deadlineAt: new Date(deadlineAtMs).toISOString(),
			sourceKind: input.sourceKind,
			scheduleId: input.scheduleId ?? null,
			occurrenceId: input.occurrenceId ?? null,
			worldUsed: false,
			worldBlocked: false,
			createdAt: now,
			updatedAt: now,
		};
		if (input.voiceSubject && larm.bindInTransaction)
			larm.bindInTransaction(db, input.voiceSubject, runId, deadlineAtMs, {
				validationRequestIds: input.validationRequestIds ?? [],
			});
		else larm.captureInTransaction?.(db, runId, "llm", deadlineAtMs);
		insert(db, run);
		return { run, fresh: true };
	}

	const promptTarget: TargetDefinition<PromptTarget> = {
		kind: PROMPT_TARGET_KIND,
		version: 1,
		schema: promptTargetSchema,
		materializeInTransaction(tx, occurrence) {
			const { run } = acceptInTransaction(tx, {
				requestId: `schedule:${occurrence.occurrenceId}`,
				conversationId: occurrence.payload.conversationId,
				text: occurrence.payload.text,
				sourceKind: "schedule",
				scheduleId: occurrence.scheduleId,
				occurrenceId: occurrence.occurrenceId,
				deadlineMs: occurrence.payload.deadlineMs,
			});
			return { jobId: run.jobId as string, subjectRef: run.id };
		},
	};
	return {
		promptTarget,
		acceptInTransaction,
		async submitVoice(
			input: Submit,
			voiceSubject: string,
			validation: { validationRequestIds: string[] },
			/** Runs in the same writer transaction as acceptance; throw to roll the run back. */
			link: (db: Tx, run: Run) => void,
		): Promise<Run> {
			if (!larm.bindInTransaction || !validation?.validationRequestIds.length)
				throw new Error("invalid_voice_inference");
			const accepted = await store.write((db) => {
				const result = acceptInTransaction(db, {
					...input,
					voiceSubject,
					validationRequestIds: validation.validationRequestIds,
					sourceKind: "voice",
				});
				link(db, result.run);
				return result;
			});
			log.info(accepted.fresh ? "dialogue.accepted" : "dialogue.reused", {
				requestId: accepted.run.requestId,
				runId: accepted.run.id,
				jobId: accepted.run.jobId ?? undefined,
				utteranceId: accepted.run.utteranceId ?? undefined,
				status: accepted.run.status,
			});
			if (accepted.fresh) queue.wake();
			return accepted.run;
		},
		async submit(input: Submit): Promise<Run> {
			const accepted = await store.write((db) =>
				acceptInTransaction(db, {
					...input,
					sourceKind: input.utteranceId ? "voice" : "manual",
				}),
			);
			log.info(accepted.fresh ? "dialogue.accepted" : "dialogue.reused", {
				requestId: accepted.run.requestId,
				runId: accepted.run.id,
				jobId: accepted.run.jobId ?? undefined,
				utteranceId: accepted.run.utteranceId ?? undefined,
				status: accepted.run.status,
			});
			if (accepted.fresh) queue.wake();
			return accepted.run;
		},
	};
}
