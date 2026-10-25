import type { Database } from "bun:sqlite";
import { jstSeconds } from "../../../infrastructure/jst-time";
import { byId } from "../repository";
import type { DialogueDeps } from "./context";
import { heardOf, type Heard } from "./event-fields";
import { confirmArchives } from "./generation-settle";

/**
 * How much of a run's spoken answer reached the user (the ContextWindow specification, sections 8.1 and 9.4):
 * a `delivered` event against the answer's `said`, once. Heard in full, it confirms the archives of the TODOs the
 * answer reported. A partial delivery keeps what was heard, without the announcement spoken before it.
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
	if (heardOf(events.logInTransaction(db, run.conversationId), said.id)) return;
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
	confirmArchives(deps, db, run, heard);
}

/**
 * An utterance the agency spoke on its own, with no run: a `said` of the agent (origin `spontaneous`), so the
 * conversation knows later what it said (section 16). The finished TODOs it reported (`todoRefs`) are archived: it
 * was delivered when it was stored.
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
	});
	for (const todoId of todoRefs)
		archiveDone(deps, db, input.conversationId, todoId, at);
}

/**
 * The finished TODOs a run's reply reported, as the conversation agent's background update found afterwards
 * (section 9.4): archived now when the reply was heard in full, or once its delivery says so.
 */
export function archiveReportedInTransaction(
	deps: DialogueDeps,
	db: Database,
	input: {
		conversationId: string;
		messageId: string;
		todoIds: readonly string[];
	},
) {
	const ledger = deps.work;
	if (!ledger) return;
	const message = deps.conversation.messageInTransaction(db, input.messageId);
	const runId = message?.message.runId;
	if (!runId || message.message.conversationId !== input.conversationId) return;
	const events = deps.continuity.events;
	const said = events.deliveredUtteranceInTransaction(
		db,
		input.conversationId,
		`run:${runId}`,
	);
	if (!said) return;
	const heard = heardOf(
		events.logInTransaction(db, input.conversationId),
		said.id,
	);
	const at = jstSeconds(Date.parse(deps.clock()));
	for (const todoId of input.todoIds) {
		if (heard === "full")
			archiveDone(deps, db, input.conversationId, todoId, at);
		else if (!heard) {
			const row = ledger.workInTransaction(db, todoId);
			if (
				row?.conversationId === input.conversationId &&
				row.status === "done" &&
				!row.archivedAt
			)
				ledger.requestArchiveInTransaction(db, todoId, `run:${runId}`);
		}
	}
}

function archiveDone(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
	todoId: string,
	at: string,
) {
	const row = deps.work?.workInTransaction(db, todoId);
	if (
		row?.conversationId !== conversationId ||
		row.status !== "done" ||
		row.archivedAt
	)
		return;
	if (!deps.work!.archiveInTransaction(db, todoId)) return;
	deps.continuity.events.appendInTransaction(db, {
		conversationId,
		at,
		type: "acted",
		by: "host",
		fields: { action: "work.archived", todo: todoId },
	});
}
