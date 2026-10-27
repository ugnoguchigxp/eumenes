import type { Database } from "bun:sqlite";
import type { DialogueDeps } from "./context";
import { eventFields, type Heard } from "./event-fields";
import { jstSeconds } from "../../../infrastructure/jst-time";
import type { WorkRow } from "../repository/work";

/** Speech acknowledgements are separate from text having been shown. A later successful replay can finish it. */
export function speechHeard(
	deps: DialogueDeps,
	db: Database,
	messageId: string,
): Heard | null {
	const heard = deps.continuity.events
		.ofMessageInTransaction(db, messageId)
		.filter((event) => event.type === "delivered")
		.map(eventFields)
		.filter((fields) => fields.channel === "speech");
	if (heard.some((fields) => fields.heard === "full")) return "full";
	const last = heard.at(-1)?.heard;
	return last === "partial" || last === "none" ? last : null;
}

/** A report awaiting its first playback result is not offered again while the player is working on it. */
export function reportPending(
	deps: DialogueDeps,
	db: Database,
	row: WorkRow,
): boolean {
	if (!row.archiveRequested) return false;
	const said = deps.continuity.events.deliveredUtteranceInTransaction(
		db,
		row.conversationId,
		row.archiveRequested,
	);
	const messageId = said?.messageIds[0];
	return !!messageId && speechHeard(deps, db, messageId) === null;
}

export type MessageHeard = {
	messageId: string;
	playbackId: string;
	heard: Heard;
	/** The exact message the player was given; rejects a stale or arbitrary text acknowledgement. */
	text: string;
};

/** Only actual playback can confirm TODO archives; duplicate and superseded acknowledgements have no new effect. */
export function recordMessageHeardInTransaction(
	deps: DialogueDeps,
	db: Database,
	input: MessageHeard,
	recordEvent = true,
): boolean {
	const message = deps.conversation.messageInTransaction(
		db,
		input.messageId,
	)?.message;
	if (!message || message.role !== "assistant" || message.text !== input.text)
		return false;
	const key = message.runId ? `run:${message.runId}` : `message:${message.id}`;
	const events = deps.continuity.events;
	const said = events.deliveredUtteranceInTransaction(
		db,
		message.conversationId,
		key,
	);
	if (!said || said.messageIds[0] !== message.id) return false;
	const at = jstSeconds(Date.parse(deps.clock()));
	if (recordEvent)
		events.appendInTransaction(db, {
			conversationId: message.conversationId,
			at,
			type: "delivered",
			by: "host",
			fields: { ref: said.id, heard: input.heard, channel: "speech" },
			messageIds: [message.id],
			dedupeKey: `speech:${said.id}:${input.playbackId}`,
		});
	const heard = speechHeard(deps, db, message.id);
	for (const row of deps.work?.waitingArchivesInTransaction(
		db,
		message.conversationId,
	) ?? []) {
		if (row.archiveRequested !== key) continue;
		const archived =
			heard === "full" && deps.work!.archiveInTransaction(db, row.id);
		events.appendInTransaction(db, {
			conversationId: message.conversationId,
			at,
			type: "acted",
			by: "host",
			fields: archived
				? { action: "work.archived", todo: row.id }
				: {
						action: "work.archive_unconfirmed",
						todo: row.id,
						reason: `heard_${heard}`,
					},
			dedupeKey: `speech-archive:${input.playbackId}:${row.id}`,
		});
	}
	deps.agency?.workChangedInTransaction(db, message.conversationId);
	return true;
}
