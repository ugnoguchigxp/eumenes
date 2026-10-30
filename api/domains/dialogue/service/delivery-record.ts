import type { Database } from "bun:sqlite";
import { reportNoticeInTransaction } from "./report-notice";
import { recordUtteranceInTransaction } from "./utterances";
import { jstSeconds } from "../../../infrastructure/jst-time";
import { byId } from "../repository";
import type { DialogueDeps } from "./context";
import type { Heard } from "./event-fields";

/**
 * How much of a run's spoken answer reached the user (the ContextWindow specification, section 8.1): a `delivered`
 * event against the answer's `said`, once. A partial delivery keeps what was heard, without the announcement spoken
 * before it.
 */
export function recordHeardInTransaction(
	deps: DialogueDeps,
	db: Database,
	runId: string,
	heard: Heard,
	spokenText = "",
) {
	const run = byId(db, runId);
	if (!run) return;
	const events = deps.continuity.events;
	const said = events.deliveredUtteranceInTransaction(
		db,
		run.conversationId,
		`run:${runId}`,
	);
	if (!said) return;
	if (events.heardInTransaction(db, run.conversationId, said.id) !== null)
		return;
	let deliveredText = spokenText;
	for (const line of (run.announcement ?? "").split("\n"))
		if (line && deliveredText.startsWith(line))
			deliveredText = deliveredText.slice(line.length).trimStart();
	events.appendInTransaction(db, {
		conversationId: run.conversationId,
		at: jstSeconds(Date.parse(deps.clock())),
		type: "delivered",
		by: "host",
		fields: {
			ref: said.id,
			heard,
			...(heard === "partial" ? { deliveredText } : {}),
		},
		// The heard part is the utterance's own text: forgetting its message clears this copy too.
		messageIds: said.messageIds,
		dedupeKey: `delivered:${said.id}`,
	});
	// The reply took its place at adoption: what reached the user of it, all, the part heard, or nothing.
	const messageId = said.messageIds[0];
	if (messageId) {
		if (heard !== "full")
			deps.conversation.input.reviseUtteranceInTransaction(db, {
				conversationId: run.conversationId,
				speaker: "agent",
				messageId,
				text:
					heard === "partial" && deliveredText.trim() ? deliveredText : null,
				at: deps.clock(),
			});
		if (heard !== "none")
			deps.contextKeeper?.noteUtterance(run.conversationId, "agent");
	}
}

/**
 * Speech that reached the user from a run that kept no answer (it failed, was cut short, or was not adopted after its
 * speech began): what was heard becomes the agent's message and utterance, so the chat and the record hold what the
 * user heard (the local harness rebuild plan, section 4.5). A run still answering keeps what it says when it is
 * adopted; an announcement it delivered is an utterance already.
 */
export function recordUnadoptedSpeechInTransaction(
	deps: DialogueDeps,
	db: Database,
	runId: string,
	heardText: string,
) {
	const run = byId(db, runId);
	if (
		!run ||
		run.answerMessageId ||
		run.status === "queued" ||
		run.status === "running"
	)
		return;
	const events = deps.continuity.events;
	if (
		events.deliveredUtteranceInTransaction(
			db,
			run.conversationId,
			`run:${runId}`,
		)
	)
		return;
	let text = heardText;
	for (const line of (run.announcement ?? "").split("\n"))
		if (line.trim()) text = text.replace(line, "");
	text = text.trim();
	if (!text) return;
	const messageId = deps.id();
	const createdAt = deps.clock();
	deps.conversation.appendInTransaction(db, {
		id: messageId,
		conversationId: run.conversationId,
		role: "assistant",
		text,
		createdAt,
		runId,
	});
	const at = jstSeconds(Date.parse(createdAt));
	const { event } = events.appendInTransaction(db, {
		conversationId: run.conversationId,
		at,
		type: "said",
		by: "agent",
		fields: { text },
		messageIds: [messageId],
		deliveryKey: `run:${runId}`,
	});
	events.appendInTransaction(db, {
		conversationId: run.conversationId,
		at,
		type: "delivered",
		by: "host",
		fields: { ref: event.id, heard: "full" },
		messageIds: [messageId],
		dedupeKey: `delivered:${event.id}`,
	});
	recordUtteranceInTransaction(deps, db, {
		conversationId: run.conversationId,
		speaker: "agent",
		text,
		messageId,
		at: createdAt,
	});
}

/**
 * An utterance the agency spoke on its own, with no run: a `said` of the agent (origin `spontaneous`), so the
 * conversation knows later what it said (section 16). The TODOs it cited (`todoRefs`, a sub-agent's question it
 * asks) are shown before it as the host's notice.
 */
export function recordSpontaneousInTransaction(
	deps: DialogueDeps,
	db: Database,
	input: {
		conversationId: string;
		messageId: string;
		text: string;
		at: string;
		todoRefs?: readonly string[];
	},
) {
	const at = jstSeconds(Date.parse(input.at));
	const todoRefs = input.todoRefs ?? [];
	deps.continuity.events.appendInTransaction(db, {
		conversationId: input.conversationId,
		at,
		type: "said",
		by: "agent",
		fields: {
			text: input.text,
			origin: "spontaneous",
			...(todoRefs.length ? { todoRefs } : {}),
		},
		messageIds: [input.messageId],
		dedupeKey: `message:${input.messageId}`,
		deliveryKey: `message:${input.messageId}`,
	});
	// A report follows, in the recent conversation, the notice of the works it told.
	const notice = reportNoticeInTransaction(
		deps,
		db,
		input.conversationId,
		todoRefs,
	);
	recordUtteranceInTransaction(deps, db, {
		conversationId: input.conversationId,
		speaker: "agent",
		text: input.text,
		messageId: input.messageId,
		at: input.at,
		...(notice ? { notice } : {}),
	});
	// The report shows the resources of the TODOs it told as chips.
	deps.resourceLedger?.linkMessageToWorkInTransaction(
		db,
		input.conversationId,
		input.messageId,
		todoRefs,
	);
}
