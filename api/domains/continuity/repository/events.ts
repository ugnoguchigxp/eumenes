import type { Database } from "bun:sqlite";
import type {
	ConversationEvent,
	EventActor,
	EventStatus,
	EventType,
} from "../contracts/events";

/**
 * The conversation's input is its own utterances and state now (the conversation input specification, section 12):
 * the episode and the window version of the re-constructed window go.
 */
export const dropWindowMigration =
	"DROP TABLE continuity_episode; DROP TABLE continuity_window;";

/** Work results are events of the log now (the ContextWindow layout specification): the result slots go. */
export const dropActiveMigration = "DROP TABLE continuity_active;";

/**
 * The `activity` notes copied the conversation, which the log and the episode hold (the ContextWindow layout
 * specification, section 2.2): the open ones are retracted, so they no longer count toward the notes' limit.
 */
export const retractActivityMigration =
	"UPDATE continuity_items SET status = 'retracted', revision = revision + 1 WHERE kind = 'activity' AND status = 'active';";

/** The active short-term memory: the events (the episode and the window version are dropped since). */
export const eventsMigration = `
CREATE TABLE continuity_events (
 conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('said','delivered','acted','notice')),
 actor TEXT NOT NULL CHECK(actor IN ('user','agent','specialist','host')),
 status TEXT NOT NULL CHECK(status IN ('pending','logged','moved')),
 log_order INTEGER, full_text TEXT, full_tokens INTEGER NOT NULL,
 short_text TEXT, short_tokens INTEGER,
 form TEXT NOT NULL DEFAULT 'full' CHECK(form IN ('full','short')),
 dedupe_key TEXT, delivery_key TEXT, curated INTEGER NOT NULL DEFAULT 0, forgotten INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (conversation_id, seq)
);
CREATE UNIQUE INDEX continuity_events_dedupe ON continuity_events(conversation_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX continuity_events_delivery ON continuity_events(conversation_id, delivery_key) WHERE delivery_key IS NOT NULL;
CREATE INDEX continuity_events_log ON continuity_events(conversation_id, status, log_order);
CREATE INDEX continuity_events_curation ON continuity_events(curated, conversation_id, seq);
CREATE TABLE continuity_event_message (
 conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, message_id TEXT NOT NULL,
 PRIMARY KEY (conversation_id, seq, message_id)
);
CREATE INDEX continuity_event_message_id ON continuity_event_message(message_id);
CREATE TABLE continuity_episode (
 conversation_id TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('shown','prepared')),
 position INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('summary','unsummarized')),
 from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, from_at TEXT NOT NULL, to_at TEXT NOT NULL,
 count INTEGER NOT NULL, text TEXT NOT NULL, message_ids TEXT NOT NULL,
 PRIMARY KEY (conversation_id, stage, position)
);
CREATE TABLE continuity_active (
 conversation_id TEXT NOT NULL, todo_id TEXT NOT NULL, position INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('waiting','done')),
 at TEXT NOT NULL, text TEXT NOT NULL, tokens INTEGER NOT NULL,
 PRIMARY KEY (conversation_id, todo_id)
);
CREATE TABLE continuity_window (
 conversation_id TEXT PRIMARY KEY, version INTEGER NOT NULL, rebuilt_at TEXT, reason TEXT
);
`;

const eventColumns =
	"conversation_id, seq, at, type, actor, status, log_order, full_text, full_tokens, short_text, short_tokens, form, delivery_key, curated, forgotten";

type EventRow = {
	conversation_id: string;
	seq: number;
	at: string;
	type: EventType;
	actor: EventActor;
	status: EventStatus;
	log_order: number | null;
	full_text: string | null;
	full_tokens: number;
	short_text: string | null;
	short_tokens: number | null;
	form: "full" | "short";
	delivery_key: string | null;
	curated: number;
	forgotten: number;
};

function messagesOf(
	db: Database,
	conversationId: string,
	seqs: readonly number[],
): Map<number, string[]> {
	const found = new Map<number, string[]>();
	if (seqs.length === 0) return found;
	const rows = db
		.query(
			`SELECT seq, message_id AS messageId FROM continuity_event_message WHERE conversation_id = ? AND seq IN (${seqs.map(() => "?").join(",")}) ORDER BY rowid`,
		)
		.all(conversationId, ...seqs) as Array<{ seq: number; messageId: string }>;
	for (const row of rows)
		found.set(row.seq, [...(found.get(row.seq) ?? []), row.messageId]);
	return found;
}

function toEvents(db: Database, rows: EventRow[]): ConversationEvent[] {
	const byConversation = new Map<string, number[]>();
	for (const row of rows)
		byConversation.set(row.conversation_id, [
			...(byConversation.get(row.conversation_id) ?? []),
			row.seq,
		]);
	const messages = new Map<string, Map<number, string[]>>();
	for (const [conversationId, seqs] of byConversation)
		messages.set(conversationId, messagesOf(db, conversationId, seqs));
	return rows.map((row) => {
		const short = row.form === "short";
		return {
			conversationId: row.conversation_id,
			seq: row.seq,
			id: `e${row.seq}`,
			at: row.at,
			type: row.type,
			by: row.actor,
			status: row.status,
			logOrder: row.log_order,
			text: short ? row.short_text : row.full_text,
			tokens: short ? (row.short_tokens ?? 0) : row.full_tokens,
			form: row.form,
			shortable: row.short_text !== null,
			deliveryKey: row.delivery_key,
			messageIds: messages.get(row.conversation_id)?.get(row.seq) ?? [],
			curated: row.curated === 1,
			forgotten: row.forgotten === 1,
		};
	});
}

export function nextSeq(db: Database, conversationId: string): number {
	const row = db
		.query(
			"SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM continuity_events WHERE conversation_id = ?",
		)
		.get(conversationId) as { next: number };
	return row.next;
}

export function nextLogOrder(db: Database, conversationId: string): number {
	const row = db
		.query(
			"SELECT COALESCE(MAX(log_order), 0) + 1 AS next FROM continuity_events WHERE conversation_id = ?",
		)
		.get(conversationId) as { next: number };
	return row.next;
}

export function insertEvent(
	db: Database,
	row: {
		conversationId: string;
		seq: number;
		at: string;
		type: EventType;
		by: EventActor;
		status: EventStatus;
		logOrder: number | null;
		fullText: string;
		fullTokens: number;
		shortText: string | null;
		shortTokens: number | null;
		dedupeKey: string | null;
		deliveryKey: string | null;
		messageIds: readonly string[];
	},
) {
	db.query(
		"INSERT INTO continuity_events (conversation_id, seq, at, type, actor, status, log_order, full_text, full_tokens, short_text, short_tokens, dedupe_key, delivery_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		row.conversationId,
		row.seq,
		row.at,
		row.type,
		row.by,
		row.status,
		row.logOrder,
		row.fullText,
		row.fullTokens,
		row.shortText,
		row.shortTokens,
		row.dedupeKey,
		row.deliveryKey,
	);
	const insert = db.query(
		"INSERT OR IGNORE INTO continuity_event_message (conversation_id, seq, message_id) VALUES (?,?,?)",
	);
	for (const messageId of row.messageIds)
		insert.run(row.conversationId, row.seq, messageId);
}

export function eventByDedupe(
	db: Database,
	conversationId: string,
	dedupeKey: string,
): ConversationEvent | null {
	const row = db
		.query(
			`SELECT ${eventColumns} FROM continuity_events WHERE conversation_id = ? AND dedupe_key = ?`,
		)
		.get(conversationId, dedupeKey) as EventRow | null;
	return row ? toEvents(db, [row])[0]! : null;
}

export function eventByDeliveryKey(
	db: Database,
	conversationId: string,
	deliveryKey: string,
): ConversationEvent | null {
	const row = db
		.query(
			`SELECT ${eventColumns} FROM continuity_events WHERE conversation_id = ? AND delivery_key = ?`,
		)
		.get(conversationId, deliveryKey) as EventRow | null;
	return row ? toEvents(db, [row])[0]! : null;
}

export function eventBySeq(
	db: Database,
	conversationId: string,
	seq: number,
): ConversationEvent | null {
	const row = db
		.query(
			`SELECT ${eventColumns} FROM continuity_events WHERE conversation_id = ? AND seq = ?`,
		)
		.get(conversationId, seq) as EventRow | null;
	return row ? toEvents(db, [row])[0]! : null;
}

/** Events of one status: pending ones in receipt order, logged ones in log order, moved ones in receipt order. */
/**
 * The time (ms) of the conversation's newest logged or pending event, or null when it has none. The times are
 * compared as instants: they need not share one offset.
 */
export function latestEventMs(
	db: Database,
	conversationId: string,
): number | null {
	const rows = db
		.query(
			"SELECT at FROM continuity_events WHERE conversation_id = ? AND status IN ('logged','pending')",
		)
		.all(conversationId) as Array<{ at: string }>;
	return rows.length
		? Math.max(...rows.map((row) => Date.parse(row.at)))
		: null;
}

export function eventsWithStatus(
	db: Database,
	conversationId: string,
	status: EventStatus,
): ConversationEvent[] {
	const order = status === "logged" ? "log_order" : "seq";
	const rows = db
		.query(
			`SELECT ${eventColumns} FROM continuity_events WHERE conversation_id = ? AND status = ? ORDER BY ${order}`,
		)
		.all(conversationId, status) as EventRow[];
	return toEvents(db, rows);
}

export function logEvent(
	db: Database,
	conversationId: string,
	seq: number,
	logOrder: number,
): boolean {
	return (
		db
			.query(
				"UPDATE continuity_events SET status = 'logged', log_order = ? WHERE conversation_id = ? AND seq = ? AND status = 'pending'",
			)
			.run(logOrder, conversationId, seq).changes > 0
	);
}

/**
 * A user utterance logged where it went (to a specialist) becomes pending again, re-rendered for the main agent;
 * false when it is not a logged user utterance.
 */
export function reopenEvent(
	db: Database,
	conversationId: string,
	seq: number,
	fullText: string,
	fullTokens: number,
): boolean {
	return (
		db
			.query(
				"UPDATE continuity_events SET status = 'pending', log_order = NULL, full_text = ?, full_tokens = ?, short_text = NULL, short_tokens = NULL, form = 'full' WHERE conversation_id = ? AND seq = ? AND status = 'logged' AND type = 'said' AND actor = 'user'",
			)
			.run(fullText, fullTokens, conversationId, seq).changes > 0
	);
}

/** An event's frozen texts in both forms, as stored (null once moved out or when it has no short form). */
export function eventTexts(
	db: Database,
	conversationId: string,
	seq: number,
): { full: string | null; short: string | null } | null {
	const row = db
		.query(
			"SELECT full_text, short_text FROM continuity_events WHERE conversation_id = ? AND seq = ?",
		)
		.get(conversationId, seq) as {
		full_text: string | null;
		short_text: string | null;
	} | null;
	return row ? { full: row.full_text, short: row.short_text } : null;
}

/** Replaces an event's frozen texts (a corrected message); a form that is absent stays absent. */
export function reviseEvent(
	db: Database,
	conversationId: string,
	seq: number,
	full: { text: string; tokens: number } | null,
	short: { text: string; tokens: number } | null,
) {
	db.query(
		"UPDATE continuity_events SET full_text = COALESCE(?, full_text), full_tokens = COALESCE(?, full_tokens), short_text = COALESCE(?, short_text), short_tokens = COALESCE(?, short_tokens) WHERE conversation_id = ? AND seq = ?",
	).run(
		full?.text ?? null,
		full?.tokens ?? null,
		short?.text ?? null,
		short?.tokens ?? null,
		conversationId,
		seq,
	);
}

/** Replaces an event's frozen text (both forms) by `text`: what forgetting leaves of it. */
export function forgetEvent(
	db: Database,
	conversationId: string,
	seq: number,
	text: string,
	tokens: number,
) {
	db.query(
		"UPDATE continuity_events SET full_text = CASE WHEN status = 'moved' THEN NULL ELSE ? END, full_tokens = ?, short_text = NULL, short_tokens = NULL, form = 'full', forgotten = 1 WHERE conversation_id = ? AND seq = ?",
	).run(text, tokens, conversationId, seq);
}

export function eventsOfMessages(
	db: Database,
	messageIds: readonly string[],
): Array<{ conversationId: string; seq: number }> {
	if (messageIds.length === 0) return [];
	const found: Array<{ conversationId: string; seq: number }> = [];
	for (let start = 0; start < messageIds.length; start += 500) {
		const chunk = messageIds.slice(start, start + 500);
		found.push(
			...(db
				.query(
					`SELECT DISTINCT conversation_id AS conversationId, seq FROM continuity_event_message WHERE message_id IN (${chunk.map(() => "?").join(",")})`,
				)
				.all(...chunk) as Array<{ conversationId: string; seq: number }>),
		);
	}
	return found;
}

export function uncuratedEvents(
	db: Database,
	conversationId: string,
): ConversationEvent[] {
	const rows = db
		.query(
			`SELECT ${eventColumns} FROM continuity_events WHERE conversation_id = ? AND curated = 0 AND status != 'pending' ORDER BY seq`,
		)
		.all(conversationId) as EventRow[];
	return toEvents(db, rows);
}

export function conversationsWithUncurated(db: Database): string[] {
	return (
		db
			.query(
				"SELECT DISTINCT conversation_id AS id FROM continuity_events WHERE curated = 0 AND status != 'pending' ORDER BY conversation_id",
			)
			.all() as Array<{ id: string }>
	).map((row) => row.id);
}

export function markCurated(
	db: Database,
	conversationId: string,
	seqs: readonly number[],
) {
	const update = db.query(
		"UPDATE continuity_events SET curated = 1 WHERE conversation_id = ? AND seq = ?",
	);
	for (const seq of seqs) update.run(conversationId, seq);
}

/** The newest seq of the conversation's events (0 when none). */
export function latestSeq(db: Database, conversationId: string): number {
	return (
		db
			.query(
				"SELECT COALESCE(MAX(seq), 0) AS seq FROM continuity_events WHERE conversation_id = ?",
			)
			.get(conversationId) as { seq: number }
	).seq;
}

/** The logged events after `seq`, in log order. */
export function loggedAfter(
	db: Database,
	conversationId: string,
	seq: number,
): ConversationEvent[] {
	const rows = db
		.query(
			`SELECT ${eventColumns} FROM continuity_events WHERE conversation_id = ? AND status = 'logged' AND seq > ? ORDER BY log_order`,
		)
		.all(conversationId, seq) as EventRow[];
	return toEvents(db, rows);
}
