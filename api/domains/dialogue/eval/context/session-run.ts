/** The generation step of a session (the production prepare) and the adoption step that follows it. */
import type { Run } from "../../contracts";
import { insert } from "../../repository";
import type { GeneratePayload } from "../../service/context";
import type { SessionContext } from "./session-context";
import { CONVERSATION_ID, type Generated, type Reply } from "./session-types";

export type GenerateRequest = {
	at: string;
	/** The newest user utterance; null: a generation without one, started by `trigger`. */
	utterance: string | null;
	trigger?: Record<string, unknown>;
	/** Earlier unhandled utterances, shown with it. */
	pending?: ReadonlyArray<{ at: string; text: string }>;
};

/**
 * One generation: the pending utterances and `utterance` (or the host's fixed text with `trigger`), the production
 * prepare inside a claim transaction, and the window version it left.
 */
export async function generateIn(
	ctx: SessionContext,
	input: GenerateRequest,
): Promise<Generated> {
	const { store, conversation, events } = ctx;
	ctx.wiring.setNow(input.at);
	const n = ctx.nextRun();
	const runId = `run-${n}`;
	const jobId = `job-${n}`;
	return store.write((db) => {
		let inputMessageId: string;
		if (input.utterance === null) {
			inputMessageId = ctx.nextMessage();
			conversation.appendInTransaction(db, {
				id: inputMessageId,
				conversationId: CONVERSATION_ID,
				role: "user",
				text: JSON.stringify(input.trigger ?? {}),
				createdAt: input.at,
				runId,
			});
		} else {
			const utterances = [
				...(input.pending ?? []),
				{ at: input.at, text: input.utterance },
			];
			inputMessageId = "";
			for (const utterance of utterances) {
				inputMessageId = ctx.nextMessage();
				conversation.appendInTransaction(db, {
					id: inputMessageId,
					conversationId: CONVERSATION_ID,
					role: "user",
					text: utterance.text,
					createdAt: utterance.at,
					runId,
				});
				conversation.input.appendUtteranceInTransaction(db, {
					conversationId: CONVERSATION_ID,
					speaker: "user",
					text: utterance.text,
					messageId: inputMessageId,
					at: utterance.at,
				});
				events.appendInTransaction(db, {
					conversationId: CONVERSATION_ID,
					at: ctx.jst(utterance.at),
					type: "said",
					by: "user",
					fields: { text: utterance.text },
					messageIds: [inputMessageId],
					pending: true,
				});
			}
		}
		insert(db, {
			id: runId,
			agentTaskId: null,
			specialistSessionId: null,
			requestId: `req-${n}`,
			conversationId: CONVERSATION_ID,
			utteranceId: null,
			status: "queued",
			revision: 1,
			inputMessageId,
			answerMessageId: null,
			error: null,
			jobId,
			deadlineAt: null,
			sourceKind: input.utterance === null ? "notice" : "manual",
			scheduleId: null,
			occurrenceId: null,
			createdAt: input.at,
			updatedAt: input.at,
		} as Run);
		const prepared = ctx.prepare(db, {
			payload: { runId } satisfies GeneratePayload,
			jobId,
		} as Parameters<SessionContext["prepare"]>[1]);
		if (prepared.status !== "ready")
			throw new Error(
				`context_eval_prepare_${prepared.status}:${"reason" in prepared ? prepared.reason : ""}`,
			);
		const cut = ctx.deps.conversation.input.cutInTransaction(
			db,
			CONVERSATION_ID,
		);
		return {
			runId,
			input: prepared.input,
			// The first input places the cut at the start: only a later one moves it.
			cut:
				prepared.input.cut && prepared.input.cut !== "started" && cut
					? { seq: cut.seq, reason: prepared.input.cut }
					: null,
		};
	});
}

/**
 * What adopting the generation leaves in the log: its utterances are handled (they join the log in receipt order),
 * then its actions, then what it said and how much of it was heard.
 */
export function settleIn(
	ctx: SessionContext,
	generated: Generated,
	reply: Reply,
) {
	const { store, conversation, events, resolve } = ctx;
	const { input } = generated;
	return store.write((db) => {
		const at = ctx.jst(ctx.wiring.now());
		if (input.final.kind === "utterances")
			events.handleInTransaction(db, CONVERSATION_ID, input.final.seqs);
		for (const action of reply.acted ?? [])
			events.appendInTransaction(db, {
				conversationId: CONVERSATION_ID,
				at,
				type: "acted",
				by: action.by ?? "agent",
				fields: resolve(action.fields) as Record<string, unknown>,
			});
		if (reply.text) {
			const id = ctx.nextMessage();
			conversation.appendInTransaction(db, {
				id,
				conversationId: CONVERSATION_ID,
				role: "assistant",
				text: reply.text,
				createdAt: ctx.wiring.now(),
				runId: generated.runId,
			});
			const todoRefs = (reply.todoRefs ?? []).map(
				(ref) => resolve(ref) as string,
			);
			const about = (reply.about ?? []).map((ref) => resolve(ref) as string);
			const { event: said } = events.appendInTransaction(db, {
				conversationId: CONVERSATION_ID,
				at,
				type: "said",
				by: "agent",
				fields: {
					text: reply.text,
					...(reply.origin && reply.origin !== "reply"
						? { origin: reply.origin }
						: {}),
					...(todoRefs.length ? { todoRefs } : {}),
					...(about.length ? { about } : {}),
				},
				messageIds: [id],
				deliveryKey: `run:${generated.runId}`,
			});
			const heard = reply.heard ?? "full";
			const reached =
				heard === "full"
					? reply.text
					: heard === "partial"
						? (reply.deliveredText ?? "")
						: "";
			if (reached)
				conversation.input.appendUtteranceInTransaction(db, {
					conversationId: CONVERSATION_ID,
					speaker: "agent",
					text: reached,
					messageId: id,
					at: ctx.wiring.now(),
					...(reply.toolCalls ? { toolCalls: reply.toolCalls } : {}),
				});
			events.appendInTransaction(db, {
				conversationId: CONVERSATION_ID,
				at,
				type: "delivered",
				by: "host",
				fields: {
					ref: said.id,
					heard,
					...(heard === "partial"
						? { deliveredText: reply.deliveredText ?? "" }
						: {}),
				},
			});
		}
		db.query("UPDATE dialogue_runs SET status='completed' WHERE id=?").run(
			generated.runId,
		);
	});
}
