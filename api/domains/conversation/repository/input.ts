import type { Database } from "bun:sqlite";
import type {
	ConversationCut,
	ConversationState,
	ConversationStateBody,
	Utterance,
	UtteranceSpeaker,
	UtteranceToolCall,
} from "../contracts/input";

/**
 * What the conversation's input is built from (the conversation input specification, sections 6.3, 6.1.1 and 7.4):
 * the utterances as they were said and heard, the cut the recent conversation starts after, and the versions of the
 * conversation's state. The full record (messages) stays as it is; these are the input's own copy.
 */
export const inputMigration = {
	id: "conversation/0011-input",
	after: ["conversation/0010-attribution"],
	sql: `
CREATE TABLE conversation_utterances (
 conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
 speaker TEXT NOT NULL CHECK(speaker IN ('user','agent')),
 text TEXT NOT NULL, message_id TEXT, created_at TEXT NOT NULL, retracted_at TEXT,
 PRIMARY KEY (conversation_id, seq)
);
CREATE UNIQUE INDEX conversation_utterances_message ON conversation_utterances(conversation_id, speaker, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX conversation_utterances_message_id ON conversation_utterances(message_id);
CREATE TABLE conversation_cuts (
 conversation_id TEXT PRIMARY KEY, cut_seq INTEGER NOT NULL, revision INTEGER NOT NULL,
 system_digest TEXT NOT NULL, memory_version INTEGER, due TEXT, cut_at TEXT NOT NULL
);
CREATE TABLE conversation_states (
 conversation_id TEXT NOT NULL, version INTEGER NOT NULL,
 state_json TEXT NOT NULL, based_on_seq INTEGER NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY (conversation_id, version)
);
`,
};

/** Keep deployed 0011 bytes intact; old cuts have no digest and are refreshed by the existing comparison. */
export const inputMemoryDigestMigration = {
	id: "conversation/0012-input-memory-digest",
	after: ["conversation/0011-input"],
	sql: `ALTER TABLE conversation_cuts ADD COLUMN memory_digest TEXT NOT NULL DEFAULT '';`,
};

/**
 * The tool calls of the turn an agent utterance ends (the tool-call reliability design, P1). 0013 and 0014 are kept
 * as they ran on 2026-10-27: the column was dropped while the input drew no recent conversation, and 0015 adds it
 * again now that it does.
 */
export const inputToolExchangeMigration = {
	id: "conversation/0013-utterance-tool-exchange",
	after: ["conversation/0012-input-memory-digest"],
	sql: `ALTER TABLE conversation_utterances ADD COLUMN tool_exchange_json TEXT;`,
};

export const dropToolExchangeMigration = {
	id: "conversation/0014-drop-utterance-tool-exchange",
	after: ["conversation/0013-utterance-tool-exchange"],
	sql: `ALTER TABLE conversation_utterances DROP COLUMN tool_exchange_json;`,
};

export const restoreToolExchangeMigration = {
	id: "conversation/0015-utterance-tool-exchange",
	after: ["conversation/0014-drop-utterance-tool-exchange"],
	sql: `ALTER TABLE conversation_utterances ADD COLUMN tool_exchange_json TEXT;`,
};

const ready = new WeakMap<Database, boolean>();
/** The input's tables exist on this connection (a store opened with an older migration set has none). */
export function inputReady(db: Database): boolean {
	let value = ready.get(db);
	if (value === undefined) {
		value = !!db
			.query(
				"SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_utterances'",
			)
			.get();
		ready.set(db, value);
	}
	return value;
}

type UtteranceRow = {
	conversation_id: string;
	seq: number;
	speaker: UtteranceSpeaker;
	text: string;
	message_id: string | null;
	created_at: string;
	tool_exchange_json: string | null;
};
const isToolCall = (value: unknown): value is UtteranceToolCall =>
	!!value &&
	typeof value === "object" &&
	["name", "arguments", "result"].every(
		(key) => typeof (value as Record<string, unknown>)[key] === "string",
	);
function toolCallsOf(json: string | null): UtteranceToolCall[] {
	if (!json) return [];
	try {
		const value: unknown = JSON.parse(json);
		return Array.isArray(value) ? value.filter(isToolCall) : [];
	} catch {
		return [];
	}
}
const utteranceOf = (row: UtteranceRow): Utterance => ({
	conversationId: row.conversation_id,
	seq: row.seq,
	speaker: row.speaker,
	text: row.text,
	messageId: row.message_id,
	at: row.created_at,
	toolCalls: toolCallsOf(row.tool_exchange_json),
});
const UTTERANCE_COLUMNS =
	"conversation_id, seq, speaker, text, message_id, created_at, tool_exchange_json";
const exchangeJson = (toolCalls: readonly UtteranceToolCall[] | undefined) =>
	toolCalls?.length ? JSON.stringify(toolCalls) : null;

/** Appends one utterance; a message already stored for the same speaker keeps its first row (null: nothing added). */
export function appendUtterance(
	db: Database,
	input: {
		conversationId: string;
		speaker: UtteranceSpeaker;
		text: string;
		messageId: string | null;
		at: string;
		/** The tool calls of the turn an agent utterance ends. */
		toolCalls?: readonly UtteranceToolCall[];
	},
): Utterance | null {
	if (input.messageId) {
		const existing = db
			.query(
				"SELECT 1 FROM conversation_utterances WHERE conversation_id = ? AND speaker = ? AND message_id = ?",
			)
			.get(input.conversationId, input.speaker, input.messageId);
		if (existing) return null;
	}
	const { next } = db
		.query(
			"SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM conversation_utterances WHERE conversation_id = ?",
		)
		.get(input.conversationId) as { next: number };
	db.query(
		`INSERT INTO conversation_utterances (${UTTERANCE_COLUMNS}) VALUES (?,?,?,?,?,?,?)`,
	).run(
		input.conversationId,
		next,
		input.speaker,
		input.text,
		input.messageId,
		input.at,
		input.speaker === "agent" ? exchangeJson(input.toolCalls) : null,
	);
	return {
		conversationId: input.conversationId,
		seq: next,
		speaker: input.speaker,
		text: input.text,
		messageId: input.messageId,
		at: input.at,
		toolCalls: input.speaker === "agent" ? [...(input.toolCalls ?? [])] : [],
	};
}

/**
 * The tool calls of the turn an agent utterance ends, for an utterance written before its turn ended (an
 * announcement reaches the user before its work is handed over). Written once: an utterance that has them, or was
 * retracted, keeps what it has. False when no such utterance took them.
 */
export function attachToolCalls(
	db: Database,
	input: {
		conversationId: string;
		messageId: string;
		toolCalls: readonly UtteranceToolCall[];
	},
): boolean {
	const json = exchangeJson(input.toolCalls);
	if (!json) return false;
	return (
		db
			.query(
				"UPDATE conversation_utterances SET tool_exchange_json = ? WHERE conversation_id = ? AND speaker = 'agent' AND message_id = ? AND retracted_at IS NULL AND tool_exchange_json IS NULL",
			)
			.run(json, input.conversationId, input.messageId).changes > 0
	);
}

/**
 * What reached the user of an utterance written at its adoption: the part heard of a reply cut short, or nothing
 * (it leaves the input, as nothing of it was heard). Its place in the order stays.
 */
export function reviseUtterance(
	db: Database,
	input: {
		conversationId: string;
		speaker: UtteranceSpeaker;
		messageId: string;
		text: string | null;
		at: string;
	},
): void {
	if (input.text === null)
		db.query(
			"UPDATE conversation_utterances SET text = '', tool_exchange_json = NULL, retracted_at = ? WHERE conversation_id = ? AND speaker = ? AND message_id = ? AND retracted_at IS NULL",
		).run(input.at, input.conversationId, input.speaker, input.messageId);
	else
		db.query(
			"UPDATE conversation_utterances SET text = ? WHERE conversation_id = ? AND speaker = ? AND message_id = ? AND retracted_at IS NULL",
		).run(input.text, input.conversationId, input.speaker, input.messageId);
}

/** The utterances after `afterSeq` that stand (not retracted), in order. */
export function utterancesAfter(
	db: Database,
	conversationId: string,
	afterSeq: number,
): Utterance[] {
	return (
		db
			.query(
				`SELECT ${UTTERANCE_COLUMNS} FROM conversation_utterances WHERE conversation_id = ? AND seq > ? AND retracted_at IS NULL ORDER BY seq`,
			)
			.all(conversationId, afterSeq) as UtteranceRow[]
	).map(utteranceOf);
}

/** The newest `limit` utterances that stand, in order. */
export function latestUtterances(
	db: Database,
	conversationId: string,
	limit: number,
): Utterance[] {
	return (
		db
			.query(
				`SELECT ${UTTERANCE_COLUMNS} FROM conversation_utterances WHERE conversation_id = ? AND retracted_at IS NULL ORDER BY seq DESC LIMIT ?`,
			)
			.all(conversationId, limit) as UtteranceRow[]
	)
		.map(utteranceOf)
		.reverse();
}

/**
 * The conversations and seqs of the standing utterances of these messages; with `speaker`, of that speaker only (an
 * announcement shares the id of the words it was asked by).
 */
function utterancesOfMessages(
	db: Database,
	messageIds: readonly string[],
	speaker?: UtteranceSpeaker,
): Array<{ conversation_id: string; seq: number }> {
	if (messageIds.length === 0 || !inputReady(db)) return [];
	return db
		.query(
			`SELECT conversation_id, seq FROM conversation_utterances WHERE retracted_at IS NULL AND message_id IN (${messageIds.map(() => "?").join(",")})${speaker ? " AND speaker = ?" : ""}`,
		)
		.all(...messageIds, ...(speaker ? [speaker] : [])) as Array<{
		conversation_id: string;
		seq: number;
	}>;
}

/**
 * Forgetting messages: their utterances keep only that they existed (no text, no tool calls) and leave the input. Every
 * conversation whose input showed one moves its cut's revision, and is cut on its next input when the utterance was
 * inside the recent conversation. Returns the conversations that changed.
 */
export function retractUtterances(
	db: Database,
	messageIds: readonly string[],
	at: string,
): string[] {
	const changed = new Set<string>();
	for (const row of utterancesOfMessages(db, messageIds)) {
		db.query(
			"UPDATE conversation_utterances SET text = '', tool_exchange_json = NULL, retracted_at = ? WHERE conversation_id = ? AND seq = ?",
		).run(at, row.conversation_id, row.seq);
		const cut = readCut(db, row.conversation_id);
		if (cut && row.seq > cut.seq)
			db.query(
				"UPDATE conversation_cuts SET due = 'forget' WHERE conversation_id = ? AND due IS NULL",
			).run(row.conversation_id);
		changed.add(row.conversation_id);
	}
	for (const conversationId of changed) bumpCutRevision(db, conversationId);
	return [...changed];
}

/**
 * A corrected message's utterance says its new text; returns the conversations that changed. The user's words are
 * corrected, never the agent's announcement that shares their message id.
 */
export function correctUtterances(
	db: Database,
	messageId: string,
	text: string,
): string[] {
	const changed = new Set<string>();
	for (const row of utterancesOfMessages(db, [messageId], "user")) {
		db.query(
			"UPDATE conversation_utterances SET text = ? WHERE conversation_id = ? AND seq = ?",
		).run(text, row.conversation_id, row.seq);
		changed.add(row.conversation_id);
	}
	for (const conversationId of changed) bumpCutRevision(db, conversationId);
	return [...changed];
}

type CutRow = {
	cut_seq: number;
	revision: number;
	system_digest: string;
	memory_digest: string;
	due: string | null;
	cut_at: string;
};

export function readCut(
	db: Database,
	conversationId: string,
): ConversationCut | null {
	const row = db
		.query(
			"SELECT cut_seq, revision, system_digest, memory_digest, due, cut_at FROM conversation_cuts WHERE conversation_id = ?",
		)
		.get(conversationId) as CutRow | null;
	return row
		? {
				seq: row.cut_seq,
				revision: row.revision,
				systemDigest: row.system_digest,
				memoryDigest: row.memory_digest,
				due: row.due,
				at: row.cut_at,
			}
		: null;
}

/**
 * Places the cut: the recent conversation starts after `seq`, on this system part and memory version. The revision
 * stays: a cut only drops what the newer input no longer needs, so a generation drawn before it stands.
 */
export function writeCut(
	db: Database,
	conversationId: string,
	cut: {
		seq: number;
		systemDigest: string;
		memoryDigest: string;
		at: string;
	},
): ConversationCut {
	db.query(
		`INSERT INTO conversation_cuts (conversation_id, cut_seq, revision, system_digest, memory_digest, due, cut_at)
		 VALUES (?,?,1,?,?,NULL,?)
		 ON CONFLICT(conversation_id) DO UPDATE SET cut_seq = excluded.cut_seq,
		 system_digest = excluded.system_digest, memory_digest = excluded.memory_digest, due = NULL, cut_at = excluded.cut_at`,
	).run(conversationId, cut.seq, cut.systemDigest, cut.memoryDigest, cut.at);
	return readCut(db, conversationId)!;
}

/** Asks for a cut at the conversation's next input (`reason` is kept until the cut is placed). */
export function markCutDue(
	db: Database,
	conversationId: string,
	reason: string,
): void {
	db.query(
		"UPDATE conversation_cuts SET due = ?, revision = revision + 1 WHERE conversation_id = ? AND due IS NULL",
	).run(reason, conversationId);
}

function bumpCutRevision(db: Database, conversationId: string) {
	db.query(
		"UPDATE conversation_cuts SET revision = revision + 1 WHERE conversation_id = ?",
	).run(conversationId);
}

type StateRow = {
	version: number;
	state_json: string;
	based_on_seq: number;
	created_at: string;
};

export function latestState(
	db: Database,
	conversationId: string,
): ConversationState | null {
	const row = db
		.query(
			"SELECT version, state_json, based_on_seq, created_at FROM conversation_states WHERE conversation_id = ? ORDER BY version DESC LIMIT 1",
		)
		.get(conversationId) as StateRow | null;
	if (!row) return null;
	let body: ConversationStateBody;
	try {
		body = JSON.parse(row.state_json) as ConversationStateBody;
	} catch {
		return null;
	}
	return {
		conversationId,
		version: row.version,
		body,
		basedOnSeq: row.based_on_seq,
		at: row.created_at,
	};
}

/** Appends the next version; null when `expectedVersion` is no longer the newest (another writer came first). */
export function appendState(
	db: Database,
	conversationId: string,
	input: {
		expectedVersion: number;
		body: ConversationStateBody;
		basedOnSeq: number;
		at: string;
	},
): ConversationState | null {
	const { newest } = db
		.query(
			"SELECT COALESCE(MAX(version), 0) AS newest FROM conversation_states WHERE conversation_id = ?",
		)
		.get(conversationId) as { newest: number };
	if (newest !== input.expectedVersion) return null;
	db.query(
		"INSERT INTO conversation_states (conversation_id, version, state_json, based_on_seq, created_at) VALUES (?,?,?,?,?)",
	).run(
		conversationId,
		newest + 1,
		JSON.stringify(input.body),
		input.basedOnSeq,
		input.at,
	);
	return latestState(db, conversationId);
}

/** Forgetting reaches the state: every version of the conversation goes, and it is made again (section 11). */
export function dropStates(db: Database, conversationId: string): void {
	db.query("DELETE FROM conversation_states WHERE conversation_id = ?").run(
		conversationId,
	);
}
