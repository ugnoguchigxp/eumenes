import { saveDeadlinePolicy, savePinnedToolchain } from "../repository";
import { setRunViewingResource } from "../repository/resources";
import { jstSeconds } from "../../../infrastructure/jst-time";
import { getLogger } from "../../../infrastructure/logger";
import { recordUtteranceInTransaction } from "./utterances";
import { withAttachmentNotes } from "./attachment-context";
import { eventText } from "./event-text";
import type { TargetDefinition } from "../../scheduler";
import type { Tx } from "../../queue";
import {
	isSystemPrompt,
	noticeSchema,
	promptTargetSchema,
	type Notice,
	type PromptTarget,
	type Run,
	type Submit,
} from "../contracts";
import {
	byRequest,
	byUtterance,
	insert,
	patchSession,
	setRunSession,
	setRunViewing,
} from "../repository";
import {
	DEFAULT_DEADLINE_MS,
	COMMAND_KIND,
	GENERATE_KIND,
	PROMPT_TARGET_KIND,
	SPECIALIST_KIND,
	type Accept,
	type DialogueDeps,
} from "./context";
import {
	blockSpecialistMessages,
	expiryAfter,
	flushCancelled,
} from "./specialist-core";
import {
	addresseeMatches,
	addressedSession,
	sessionRunMs,
} from "./specialist-intake";
const log = getLogger("dialogue");

/**
 * The input as an event of the conversation (the ContextWindow specification, section 8.2): a user's or a
 * schedule's utterance waits as pending until a generation handles it; one addressed to a specialist or
 * answering a command question is handled where it goes, so it joins the log at once. A host notice is logged
 * as what happened; its text is the generation's trigger.
 */
function recordInputInTransaction(
	deps: DialogueDeps,
	db: Tx,
	input: Accept,
	messageId: string,
	now: string,
	toSpecialist: boolean,
) {
	const { conversation, continuity } = deps;
	const at = jstSeconds(Date.parse(now));
	if (input.sourceKind === "notice") {
		let kind: unknown;
		try {
			kind = (JSON.parse(input.text) as { kind?: unknown }).kind;
		} catch {
			kind = undefined;
		}
		continuity.events.appendInTransaction(db, {
			conversationId: input.conversationId,
			at,
			type: "notice",
			by: "host",
			fields:
				typeof kind === "string"
					? { kind }
					: { text: input.text.slice(0, 500) },
			messageIds: [messageId],
		});
		return;
	}
	const attachments = input.attachmentIds?.length
		? conversation.attachmentsByIdsInTransaction(
				db,
				input.conversationId,
				input.attachmentIds,
			)
		: undefined;
	// The input's copy of the user's words: what the main agent is told, never the words said to a specialist.
	if (!toSpecialist)
		recordUtteranceInTransaction(deps, db, {
			conversationId: input.conversationId,
			speaker: "user",
			text: withAttachmentNotes(input.text, attachments),
			messageId,
			at: now,
		});
	continuity.events.appendInTransaction(db, {
		conversationId: input.conversationId,
		at,
		type: "said",
		by: "user",
		fields: {
			text: eventText(deps, withAttachmentNotes(input.text, attachments)),
			...(input.sourceKind === "schedule" ? { origin: "schedule" } : {}),
			...(toSpecialist ? { to: "specialist" } : {}),
		},
		messageIds: [messageId],
		pending: !toSpecialist && !input.resume,
	});
}

/** Input acceptance: idempotent run creation, manual/voice submit, notices and the schedule target. */
export function createIntake(deps: DialogueDeps) {
	const { store, conversation, larm, queue, memory, clock, id } = deps;
	/** One transaction: user message + run + queue job. Throws (rolling all back) when the queue is full. */
	function acceptInTransaction(
		db: Tx,
		input: Accept,
	): {
		run: Run;
		fresh: boolean;
		/** What ending an expired session withdrew: abort it after the commit. */
		cancelled?: { flush: string[]; runs: string[] };
	} {
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
				(original?.presentation ?? "conversation") !==
					(input.presentation ?? "conversation") ||
				JSON.stringify(original?.attachments?.map((a) => a.id) ?? []) !==
					JSON.stringify(input.attachmentIds ?? []) ||
				existing.utteranceId !== (input.utteranceId ?? null) ||
				(existing.pinnedToolchainId ?? null) !== (input.toolchainId ?? null)
			)
				throw new Error("request_conflict");
			return { run: existing, fresh: false };
		}
		const now = clock();
		const runId = id();
		const messageId = id();
		// An active specialist session takes the utterance directly: no main-agent generation at all.
		// A screen's pinned form submit is the main conversation's: it never goes to a session.
		const { session: addressee, cancelled } =
			!isSystemPrompt(input.sourceKind) && !input.resume && !input.toolchainId
				? addressedSession(deps, db, input.conversationId, now)
				: { session: null, cancelled: { flush: [], runs: [] } };
		// What the screen showed when the user sent must still be who listens, or nothing is stored.
		if (input.addressee && !addresseeMatches(input.addressee, addressee))
			throw new Error("addressee_changed");
		conversation.appendInTransaction(db, {
			id: messageId,
			conversationId: input.conversationId,
			role: "user",
			text: input.text,
			presentation: input.presentation ?? "conversation",
			...(input.attachmentIds?.length
				? {
						attachments: conversation.attachmentsByIdsInTransaction(
							db,
							input.conversationId,
							input.attachmentIds,
						),
					}
				: {}),
			createdAt: now,
			runId,
		});
		// A session toolchain with its own run time gives the utterance addressed to it that time.
		const runMs = addressee ? sessionRunMs(deps, db, addressee) : 0;
		const deadlineAtMs =
			Date.parse(now) +
			Math.max(input.deadlineMs ?? DEFAULT_DEADLINE_MS, runMs);
		const generated = queue.enqueueInTransaction(db, {
			// Scheduled runs get their own scope so background work cannot exhaust interactive acceptance.
			scope: isSystemPrompt(input.sourceKind)
				? "dialogue.schedule"
				: "dialogue",
			kind: addressee
				? SPECIALIST_KIND
				: input.resume
					? COMMAND_KIND
					: GENERATE_KIND,
			dedupeKey: addressee
				? `specialist-turn:${runId}`
				: input.resume
					? `toolchain-command:${runId}`
					: runId,
			payload: addressee
				? { runId, epoch: addressee.epoch }
				: input.resume
					? {
							runId,
							toolchainRevisionId: input.resume.toolchainRevisionId,
							interactionId: input.resume.interactionId,
						}
					: { runId },
			subjectRef: runId,
			lane: isSystemPrompt(input.sourceKind) ? "background" : "interactive",
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
			pinnedToolchainId: input.toolchainId ?? null,
			scheduleId: input.scheduleId ?? null,
			occurrenceId: input.occurrenceId ?? null,
			specialistSessionId: addressee?.id ?? null,
			createdAt: now,
			updatedAt: now,
		};
		if (input.voiceSubject && larm.bindInTransaction)
			larm.bindInTransaction(
				db,
				input.voiceSubject,
				runId,
				deadlineAtMs,
				input.transcriptionRequestIds,
			);
		else larm.captureInTransaction?.(db, runId, "llm", deadlineAtMs);
		// A voice turn's requests were captured with the voice deadline: the toolchain's run time reaches them too.
		if (runMs) larm.extendDeadlineInTransaction?.(db, runId, deadlineAtMs);
		insert(db, run);
		saveDeadlinePolicy(db, run.id, input.deadlineMs !== undefined);
		if (input.toolchainId) savePinnedToolchain(db, runId, input.toolchainId);
		if (addressee) {
			// The utterance belongs to the session: the work is taken for its turn (refused while busy), the
			// message is kept from memory and the main agent's context, and the idle expiry restarts.
			setRunSession(db, runId, addressee.id);
			blockSpecialistMessages(deps, db, input.conversationId, [messageId]);
			// A turn still holds the work: this utterance waits in the queue behind it (the conversation's
			// concurrency key keeps them in order) and takes the work when the earlier turn ends.
			if (addressee.activeRunId === null) {
				deps.specialist!.beginTurnInTransaction(
					db,
					addressee.adapterRef,
					addressee.workRef,
					runId,
				);
				patchSession(db, addressee.id, { activeRunId: runId }, now);
			}
			patchSession(db, addressee.id, { expiresAt: expiryAfter(now) }, now);
		}
		if (input.viewing && "resource" in input.viewing)
			setRunViewingResource(db, runId, input.viewing.resource);
		else if (input.viewing) setRunViewing(db, runId, input.viewing);
		recordInputInTransaction(deps, db, input, messageId, now, !!addressee);
		// A scheduled prompt is stored as a user message but is the host's: it is never learned from.
		if (isSystemPrompt(input.sourceKind))
			memory?.blockMessagesInTransaction(db, {
				conversationId: input.conversationId,
				messageIds: [messageId],
				reason: "scheduled_prompt",
			});
		return { run, fresh: true, cancelled };
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
			transcriptionRequestIds: string[],
			/** Runs in the same writer transaction as acceptance; throw to roll the run back. */
			link: (db: Tx, run: Run) => void,
		): Promise<Run> {
			if (!larm.bindInTransaction) throw new Error("invalid_voice_inference");
			const accepted = await store.write((db) => {
				const result = acceptInTransaction(db, {
					...input,
					voiceSubject,
					transcriptionRequestIds,
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
			flushCancelled(
				deps,
				accepted.cancelled?.flush ?? [],
				accepted.cancelled?.runs ?? [],
			);
			if (accepted.fresh) queue.wake();
			return accepted.run;
		},
		/** The system's notice: a hidden input the conversation answers (e.g. a task finished). */
		notifyInTransaction(db: Tx, input: Notice) {
			return acceptInTransaction(db, {
				...noticeSchema.parse(input),
				presentation: "artifact",
				sourceKind: "notice",
			}).run;
		},
		async notify(input: Notice): Promise<Run> {
			const notice = noticeSchema.parse(input);
			const accepted = await store.write((db) =>
				acceptInTransaction(db, {
					...notice,
					presentation: "artifact",
					sourceKind: "notice",
				}),
			);
			log.info(accepted.fresh ? "dialogue.accepted" : "dialogue.reused", {
				requestId: accepted.run.requestId,
				runId: accepted.run.id,
				jobId: accepted.run.jobId ?? undefined,
				status: accepted.run.status,
			});
			flushCancelled(
				deps,
				accepted.cancelled?.flush ?? [],
				accepted.cancelled?.runs ?? [],
			);
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
			flushCancelled(
				deps,
				accepted.cancelled?.flush ?? [],
				accepted.cancelled?.runs ?? [],
			);
			if (accepted.fresh) queue.wake();
			return accepted.run;
		},
	};
}
