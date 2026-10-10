import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import { createHash } from "node:crypto";
import { getLogger } from "../../../infrastructure/logger";
import {
	speechDeliverySchema,
	type SpeechDelivery,
	type AvatarMotion,
} from "../../delivery";
import {
	CONVERSATION_SOURCE_KIND,
	CONVERSATION_SOURCE_NAMESPACE,
	CONVERSATION_SOURCE_REPRESENTATION,
	type ChangeResult,
	type ConversationSourceState,
	type Message,
	type OutboxEvent,
	type OutboxKind,
	type TextRevision,
} from "../contracts";

export const migration = `
CREATE TABLE conversations (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL, created_at TEXT NOT NULL, run_id TEXT);
CREATE INDEX messages_conversation ON messages(conversation_id, created_at, id);
`;
export const avatarMotionMigration = `
CREATE TABLE answer_avatar_motions (run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), motion TEXT NOT NULL);
CREATE INDEX answer_avatar_motions_conversation ON answer_avatar_motions(conversation_id);
`;
export const answerDeliveryMigration = `
CREATE TABLE answer_deliveries (run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), delivery TEXT NOT NULL);
CREATE INDEX answer_deliveries_conversation ON answer_deliveries(conversation_id);
`;
/**
 * Ordinary-change outbox (append-only migration). Owned by conversation: the
 * source change and its event are written by the same statements, in the
 * caller's transaction. AUTOINCREMENT seq may have gaps. No message text here.
 */
export const outboxMigration = `
CREATE TABLE conversation_outbox (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	kind TEXT NOT NULL CHECK(kind IN ('added','corrected','retracted')),
	namespace TEXT NOT NULL,
	source_kind TEXT NOT NULL,
	source_id TEXT NOT NULL,
	representation TEXT NOT NULL,
	revision TEXT NOT NULL,
	digest TEXT NOT NULL,
	principal TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	speaker TEXT NOT NULL CHECK(speaker IN ('user','assistant')),
	occurred_at TEXT NOT NULL
);
CREATE INDEX conversation_outbox_source ON conversation_outbox(source_id, seq);
`;
/**
 * Retraction tombstone (append-only migration). Retraction blanks the text and
 * sets retracted_at in place: dialogue_runs reference messages(id) with foreign
 * keys on, so the row itself must stay. Every conversation read treats a row
 * with retracted_at set as missing.
 */
export const retractionMigration = `
ALTER TABLE messages ADD COLUMN retracted_at TEXT;
`;
export type OutboxOptions = {
	principal: string;
	scopeKey: string;
	/** When true a missing outbox table is an error instead of "not recorded". */
	required: boolean;
};
export function textRevision(text: string): TextRevision {
	const digest = createHash("sha256").update(text).digest("hex");
	return { revision: `sha256:${digest}`, digest };
}
/** True once outboxMigration has been applied to this database. */
export function outboxReady(db: Database): boolean {
	return !!db
		.query(
			"SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_outbox'",
		)
		.get();
}
const retractionColumn = new WeakMap<Database, boolean>();
/**
 * True once retractionMigration has been applied. Checked once per connection
 * (migrations only run when the store opens), so non-retraction reads keep
 * working on databases that do not have the column.
 */
export function retractionReady(db: Database): boolean {
	let ready = retractionColumn.get(db);
	if (ready === undefined) {
		ready = (
			db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>
		).some((column) => column.name === "retracted_at");
		retractionColumn.set(db, ready);
	}
	return ready;
}
/** SQL fragment hiding tombstoned rows; empty when the column does not exist. */
const liveOnly = (db: Database, alias: string): string =>
	retractionReady(db) ? ` AND ${alias}.retracted_at IS NULL` : "";
function requireOutbox(db: Database, options: OutboxOptions): boolean {
	if (outboxReady(db)) return true;
	if (options.required) throw new Error("conversation_outbox_missing");
	return false;
}
type OutboxRow = {
	seq: number;
	kind: OutboxKind;
	namespace: string;
	source_kind: string;
	source_id: string;
	representation: string;
	revision: string;
	digest: string;
	principal: string;
	scope_key: string;
	conversation_id: string;
	speaker: "user" | "assistant";
	occurred_at: string;
};
const outboxEvent = (row: OutboxRow): OutboxEvent => ({
	seq: row.seq,
	kind: row.kind,
	namespace: row.namespace,
	sourceKind: row.source_kind,
	sourceId: row.source_id,
	representation: row.representation,
	revision: row.revision,
	digest: row.digest,
	principal: row.principal,
	scopeKey: row.scope_key,
	conversationId: row.conversation_id,
	speaker: row.speaker,
	occurredAt: row.occurred_at,
});
function insertEvent(
	db: Database,
	options: OutboxOptions,
	event: {
		kind: OutboxKind;
		messageId: string;
		conversationId: string;
		speaker: "user" | "assistant";
		revision: string;
		digest: string;
		at: string;
	},
): number {
	return Number(
		db
			.query(
				"INSERT INTO conversation_outbox (kind, namespace, source_kind, source_id, representation, revision, digest, principal, scope_key, conversation_id, speaker, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				event.kind,
				CONVERSATION_SOURCE_NAMESPACE,
				CONVERSATION_SOURCE_KIND,
				event.messageId,
				CONVERSATION_SOURCE_REPRESENTATION,
				event.revision,
				event.digest,
				options.principal,
				options.scopeKey,
				event.conversationId,
				event.speaker,
				event.at,
			).lastInsertRowid,
	);
}
/** Latest event of one message, or null when none was recorded. */
export function latestEvent(
	db: Database,
	messageId: string,
): OutboxEvent | null {
	if (!outboxReady(db)) return null;
	const row = db
		.query(
			"SELECT * FROM conversation_outbox WHERE source_id = ? ORDER BY seq DESC LIMIT 1",
		)
		.get(messageId) as OutboxRow | null;
	return row ? outboxEvent(row) : null;
}
/** Events with seq greater than `after`, oldest first. Gaps are normal. */
export function listOutbox(
	db: Database,
	after: number,
	limit: number,
): OutboxEvent[] {
	if (!outboxReady(db)) return [];
	return (
		db
			.query(
				"SELECT * FROM conversation_outbox WHERE seq > ? ORDER BY seq LIMIT ?",
			)
			.all(after, limit) as OutboxRow[]
	).map(outboxEvent);
}
/** Replaces a confirmed message's text with a correction (same transaction as its event). */
export function correctMessage(
	db: Database,
	input: { messageId: string; text: string; at: string },
	options: OutboxOptions,
): ChangeResult {
	if (input.text.length === 0) throw new Error("empty_correction");
	requireOutbox(db, { ...options, required: true });
	const found = getMessage(db, input.messageId);
	if (!found)
		return latestEvent(db, input.messageId)?.kind === "retracted"
			? { status: "retracted" }
			: { status: "not_found" };
	if (found.message.text === input.text) return { status: "unchanged" };
	const next = textRevision(input.text);
	db.query("UPDATE messages SET text = ? WHERE id = ?").run(
		input.text,
		input.messageId,
	);
	// Superseded revisions must not keep a digest of the replaced text. The
	// events stay (seq/kind/ids keep cursors valid); only the newest revision
	// below carries a real digest.
	db.query(
		"UPDATE conversation_outbox SET revision = 'superseded', digest = '' WHERE source_id = ? AND source_kind = ? AND namespace = ? AND kind <> 'retracted'",
	).run(
		input.messageId,
		CONVERSATION_SOURCE_KIND,
		CONVERSATION_SOURCE_NAMESPACE,
	);
	const seq = insertEvent(db, options, {
		kind: "corrected",
		messageId: input.messageId,
		conversationId: found.message.conversationId,
		speaker: found.message.role,
		...next,
		at: input.at,
	});
	return {
		status: "applied",
		kind: "corrected",
		seq,
		revision: next.revision,
		conversationRevision: bumpRevision(db, found.message.conversationId),
	};
}
/** Tombstones a confirmed message (text blanked) and records the retraction. */
export function retractMessage(
	db: Database,
	input: { messageId: string; at: string },
	options: OutboxOptions,
): ChangeResult {
	requireOutbox(db, { ...options, required: true });
	if (!retractionReady(db)) throw new Error("conversation_retraction_missing");
	const found = getMessage(db, input.messageId);
	if (!found)
		return latestEvent(db, input.messageId)?.kind === "retracted"
			? { status: "unchanged" }
			: { status: "not_found" };
	// Tombstone in place (dialogue_runs keep their foreign keys valid).
	db.query(
		"UPDATE messages SET text = '', retracted_at = ? WHERE id = ? AND retracted_at IS NULL",
	).run(input.at, input.messageId);
	// Nothing about the removed text may remain in the outbox either.
	db.query(
		"UPDATE conversation_outbox SET revision = 'retracted', digest = '' WHERE source_id = ? AND source_kind = ? AND namespace = ?",
	).run(
		input.messageId,
		CONVERSATION_SOURCE_KIND,
		CONVERSATION_SOURCE_NAMESPACE,
	);
	const seq = insertEvent(db, options, {
		kind: "retracted",
		messageId: input.messageId,
		conversationId: found.message.conversationId,
		speaker: found.message.role,
		revision: "retracted",
		digest: "",
		at: input.at,
	});
	return {
		status: "applied",
		kind: "retracted",
		seq,
		revision: "retracted",
		conversationRevision: bumpRevision(db, found.message.conversationId),
	};
}
/** Current state of one message source (available / retracted / missing). */
export function sourceState(
	db: Database,
	messageId: string,
	options: OutboxOptions,
): ConversationSourceState {
	const found = getMessage(db, messageId);
	if (found)
		return {
			state: "available",
			message: found.message,
			ordinal: found.ordinal,
			...textRevision(found.message.text),
			principal: options.principal,
			scopeKey: options.scopeKey,
			confirmed: true,
		};
	const last = latestEvent(db, messageId);
	return last?.kind === "retracted"
		? {
				state: "retracted",
				principal: last.principal,
				scopeKey: last.scopeKey,
				seq: last.seq,
			}
		: { state: "missing" };
}
function bumpRevision(db: Database, conversationId: string): number {
	db.query("UPDATE conversations SET revision = revision + 1 WHERE id = ?").run(
		conversationId,
	);
	return revision(db, conversationId);
}
export function recordAnswerDelivery(
	db: Database,
	runId: string,
	conversationId: string,
	delivery: SpeechDelivery,
) {
	const parsed = speechDeliverySchema.parse(delivery);
	const old = db
		.query("SELECT delivery FROM answer_deliveries WHERE run_id=?")
		.get(runId) as { delivery: string } | null;
	if (old) {
		const previous = speechDeliverySchema.parse(JSON.parse(old.delivery));
		// An accepted answer-wide decision is stable. A fallback may be retried on replay.
		if (
			previous.version === 2 &&
			(previous.source !== "fallback" || parsed.source === "fallback")
		)
			return false;
	}
	db.query(
		"INSERT INTO answer_deliveries (run_id, conversation_id, delivery) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET delivery=excluded.delivery",
	).run(runId, conversationId, JSON.stringify(parsed));
	db.query("UPDATE conversations SET revision=revision+1 WHERE id=?").run(
		conversationId,
	);
	return true;
}
export function recordAnswerMotion(
	db: Database,
	runId: string,
	conversationId: string,
	motion: AvatarMotion,
): boolean {
	const result = db
		.query(
			"INSERT OR IGNORE INTO answer_avatar_motions (run_id, conversation_id, motion) VALUES (?, ?, ?)",
		)
		.run(runId, conversationId, motion);
	if (!result.changes) return false;
	db.query("UPDATE conversations SET revision = revision + 1 WHERE id = ?").run(
		conversationId,
	);
	return true;
}
export function ensureConversation(db: Database, id: string, now: string) {
	db.query(
		"INSERT OR IGNORE INTO conversations (id, created_at) VALUES (?, ?)",
	).run(id, now);
}
export function appendMessage(
	db: Database,
	message: Message,
	options?: OutboxOptions,
): number {
	const outbox = options ? requireOutbox(db, options) : false;
	// A retracted id never comes back with different content.
	if (outbox && latestEvent(db, message.id)?.kind === "retracted")
		throw new Error("message_retracted");
	db.query(
		"INSERT INTO messages (id, conversation_id, role, text, created_at, run_id) VALUES (?, ?, ?, ?, ?, ?)",
	).run(
		message.id,
		message.conversationId,
		message.role,
		message.text,
		message.createdAt,
		message.runId,
	);
	if (outbox && options)
		insertEvent(db, options, {
			kind: "added",
			messageId: message.id,
			conversationId: message.conversationId,
			speaker: message.role,
			...textRevision(message.text),
			at: message.createdAt,
		});
	return bumpRevision(db, message.conversationId);
}
type MessageRow = {
	id: string;
	conversation_id: string;
	role: "user" | "assistant";
	text: string;
	created_at: string;
	run_id: string | null;
	motion: AvatarMotion | null;
	delivery: string | null;
};
const messageSelect = (db: Database, where: string): string =>
	`SELECT m.id, m.conversation_id, m.role, m.text, m.created_at, m.run_id, a.motion, d.delivery FROM messages m LEFT JOIN answer_avatar_motions a ON a.run_id = m.run_id AND a.conversation_id = m.conversation_id AND m.role = 'assistant' LEFT JOIN answer_deliveries d ON d.run_id = m.run_id AND d.conversation_id = m.conversation_id AND m.role = 'assistant' WHERE ${where}${liveOnly(db, "m")}`;
/** A stored delivery that no longer matches the schema is dropped, not fatal. */
function safeDelivery(row: MessageRow): SpeechDelivery | undefined {
	if (!row.delivery) return undefined;
	try {
		const parsed = speechDeliverySchema.safeParse(JSON.parse(row.delivery));
		if (parsed.success) return parsed.data;
	} catch {
		// fall through to the warning below
	}
	getLogger("conversation").warn("conversation.delivery_invalid", {
		reason: "delivery_invalid",
		...(row.run_id ? { runId: row.run_id } : {}),
	});
	return undefined;
}
function toMessage(row: MessageRow): Message {
	const delivery = safeDelivery(row);
	return {
		id: row.id,
		conversationId: row.conversation_id,
		role: row.role,
		text: row.text,
		createdAt: row.created_at,
		runId: row.run_id,
		...(row.motion ? { avatarMotion: row.motion } : {}),
		...(delivery ? { delivery } : {}),
	};
}
export function listMessages(db: Database, id: string): Message[] {
	const rows = db
		.query(`${messageSelect(db, "m.conversation_id = ?")} ORDER BY m.rowid`)
		.all(id) as MessageRow[];
	return rows.map(toMessage);
}
/** The last `limit` messages of a conversation in acceptance order. */
export function tailMessages(
	db: Database,
	id: string,
	limit: number,
): { messages: Message[]; hasMore: boolean } {
	const rows = db
		.query(
			`${messageSelect(db, "m.conversation_id = ?")} ORDER BY m.rowid DESC LIMIT ?`,
		)
		.all(id, limit + 1) as MessageRow[];
	const hasMore = rows.length > limit;
	return {
		messages: rows.slice(0, limit).reverse().map(toMessage),
		hasMore,
	};
}
/** One message with its motion and delivery, regardless of conversation. */
export function messageWithDelivery(db: Database, id: string): Message | null {
	const row = db
		.query(messageSelect(db, "m.id = ?"))
		.get(id) as MessageRow | null;
	return row ? toMessage(row) : null;
}
/** Up to `limit` messages of a conversation before `beforeOrdinal`, ascending. */
export function messagesBefore(
	db: Database,
	conversationId: string,
	beforeOrdinal: number,
	limit: number,
): Message[] {
	const rows = db
		.query(
			`${messageSelect(db, "m.conversation_id = ? AND m.rowid < ?")} ORDER BY m.rowid DESC LIMIT ?`,
		)
		.all(conversationId, beforeOrdinal, limit) as MessageRow[];
	return rows.reverse().map(toMessage);
}
export function revision(db: Database, id: string): number {
	return (
		(
			db.query("SELECT revision FROM conversations WHERE id = ?").get(id) as {
				revision: number;
			} | null
		)?.revision ?? 0
	);
}
/** One message with its acceptance-order ordinal (rowid), regardless of conversation. */
export function getMessage(
	db: Database,
	id: string,
): { message: Message; ordinal: number } | null {
	const row = db
		.query(
			`SELECT m.rowid AS ordinal, m.id, m.conversation_id, m.role, m.text, m.created_at, m.run_id FROM messages m WHERE m.id = ?${liveOnly(db, "m")}`,
		)
		.get(id) as {
		ordinal: number;
		id: string;
		conversation_id: string;
		role: "user" | "assistant";
		text: string;
		created_at: string;
		run_id: string | null;
	} | null;
	if (!row) return null;
	return {
		ordinal: row.ordinal,
		message: {
			id: row.id,
			conversationId: row.conversation_id,
			role: row.role,
			text: row.text,
			createdAt: row.created_at,
			runId: row.run_id,
		},
	};
}

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "conversation/0001-init", sql: migration },
	{ id: "conversation/0002-avatar-motion", sql: avatarMotionMigration },
	{ id: "conversation/0003-answer-delivery", sql: answerDeliveryMigration },
	{ id: "conversation/0004-outbox", sql: outboxMigration },
	{ id: "conversation/0005-retraction", sql: retractionMigration },
];
