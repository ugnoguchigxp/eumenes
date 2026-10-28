import type { Database } from "bun:sqlite";
import { reportNoticeInTransaction } from "./report-notice";
import { recordUtteranceInTransaction } from "./utterances";
import { jstSeconds } from "../../../infrastructure/jst-time";
import { byId } from "../repository";
import type { DialogueDeps } from "./context";
import type { Heard } from "./event-fields";
import {
	recordMessageHeardInTransaction,
	speechHeard,
} from "./speech-delivery";

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
	const acknowledge = (recordEvent: boolean) => {
		if (!run.answerMessageId) return;
		const message = deps.conversation.messageInTransaction(
			db,
			run.answerMessageId,
		)?.message;
		if (message)
			recordMessageHeardInTransaction(
				deps,
				db,
				{
					messageId: message.id,
					playbackId: `live:${runId}`,
					heard,
					text: message.text,
				},
				recordEvent,
			);
	};
	if (events.heardInTransaction(db, run.conversationId, said.id) !== null) {
		acknowledge(true);
		return;
	}
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
			channel: "speech",
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
	acknowledge(false);
}

/**
 * An utterance the agency spoke on its own, with no run: a `said` of the agent (origin `spontaneous`), so the
 * conversation knows later what it said (section 16). The finished TODOs it reported (`todoRefs`) await playback; storage alone is not speech delivery.
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
	for (const todoId of todoRefs) {
		const row = deps.work?.workInTransaction(db, todoId);
		if (
			row?.conversationId === input.conversationId &&
			row.status === "done" &&
			!row.archivedAt
		)
			deps.work!.requestArchiveInTransaction(
				db,
				todoId,
				`message:${input.messageId}`,
			);
	}
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
	// The reply that told these TODOs shows their resources as chips.
	deps.resourceLedger?.linkMessageToWorkInTransaction(
		db,
		input.conversationId,
		input.messageId,
		input.todoIds,
	);
	const events = deps.continuity.events;
	const said = events.deliveredUtteranceInTransaction(
		db,
		input.conversationId,
		`run:${runId}`,
	);
	if (!said) return;
	const heard = speechHeard(deps, db, input.messageId);
	const at = jstSeconds(Date.parse(deps.clock()));
	for (const todoId of input.todoIds) {
		const current = ledger.workInTransaction(db, todoId);
		if (
			current?.conversationId !== input.conversationId ||
			current.status !== "done" ||
			Date.parse(current.updatedAt) > Date.parse(message.message.createdAt)
		)
			continue;
		// An older reconciliation cannot supersede a newer pending report.
		if (
			current.archiveRequested &&
			current.archiveRequested !== `run:${runId}`
		) {
			const pending = events.deliveredUtteranceInTransaction(
				db,
				input.conversationId,
				current.archiveRequested,
			);
			if (pending && pending.seq > said.seq) continue;
		}
		if (heard === "full")
			archiveDone(deps, db, input.conversationId, todoId, at);
		else {
			const row = ledger.workInTransaction(db, todoId);
			if (
				row?.conversationId === input.conversationId &&
				row.status === "done" &&
				Date.parse(row.updatedAt) <= Date.parse(message.message.createdAt) &&
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
