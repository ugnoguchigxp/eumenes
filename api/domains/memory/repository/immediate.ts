import type { Database } from "bun:sqlite";

/**
 * The tables of the immediate layer (the memory redesign, sections 5 and 7.2): the explicit requests that were applied
 * (so a withdrawal knows what to undo), the short references a window hands to the model, and the topic words the
 * user asked not to hear about when no record stands for the topic. Appended after the others; frozen once deployed.
 */
export const immediateLayerMigration = `
CREATE TABLE memory_explicit_request (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 request_id TEXT NOT NULL UNIQUE,
 conversation_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 op TEXT NOT NULL CHECK(op IN ('remember','correct')),
 item_id TEXT NOT NULL,
 item_revision INTEGER NOT NULL,
 replaced_item_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('applied','withdrawn')),
 restored_item_id TEXT,
 created_at TEXT NOT NULL,
 withdrawn_at TEXT
);
CREATE INDEX memory_explicit_request_conversation ON memory_explicit_request(conversation_id, state, seq);
CREATE INDEX memory_explicit_request_item ON memory_explicit_request(item_id);
CREATE TABLE memory_short_ref_window (
 conversation_id TEXT PRIMARY KEY, window_key TEXT NOT NULL, next_seq INTEGER NOT NULL
);
CREATE TABLE memory_short_ref (
 conversation_id TEXT NOT NULL, ref TEXT NOT NULL, item_id TEXT NOT NULL, revision INTEGER NOT NULL,
 PRIMARY KEY (conversation_id, ref)
);
CREATE INDEX memory_short_ref_item ON memory_short_ref(conversation_id, item_id, revision);
CREATE TABLE memory_topic_suppression (
 term TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, run_id TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

export type ExplicitRequestRow = {
	requestId: string;
	/** The user asked ("remember this"), as against a statement of theirs the background pass noted. */
	requested: boolean;
	conversationId: string;
	runId: string;
	op: "remember" | "correct";
	itemId: string;
	itemRevision: number;
	replacedItemId: string | null;
	state: "applied" | "withdrawn";
	restoredItemId: string | null;
};

const REQUEST_COLUMNS = `request_id AS requestId, requested = 1 AS requested, conversation_id AS conversationId, run_id AS runId, op,
 item_id AS itemId, item_revision AS itemRevision, replaced_item_id AS replacedItemId, state,
 restored_item_id AS restoredItemId`;

export function insertExplicitRequest(
	db: Database,
	row: Omit<ExplicitRequestRow, "state" | "restoredItemId">,
	now: string,
) {
	db.query(
		`INSERT INTO memory_explicit_request
		 (request_id, requested, conversation_id, run_id, op, item_id, item_revision, replaced_item_id, state, created_at)
		 VALUES (?,?,?,?,?,?,?,?, 'applied', ?)`,
	).run(
		row.requestId,
		row.requested ? 1 : 0,
		row.conversationId,
		row.runId,
		row.op,
		row.itemId,
		row.itemRevision,
		row.replacedItemId,
		now,
	);
}

export function readExplicitRequest(
	db: Database,
	requestId: string,
): ExplicitRequestRow | null {
	return db
		.query(
			`SELECT ${REQUEST_COLUMNS} FROM memory_explicit_request WHERE request_id = ?`,
		)
		.get(requestId) as ExplicitRequestRow | null;
}

/** The newest request the user made in the conversation that is still applied (a statement the background pass noted is not one). */
export function latestAppliedRequest(
	db: Database,
	conversationId: string,
): ExplicitRequestRow | null {
	return db
		.query(
			`SELECT ${REQUEST_COLUMNS} FROM memory_explicit_request
			 WHERE conversation_id = ? AND state = 'applied' AND requested = 1 ORDER BY seq DESC LIMIT 1`,
		)
		.get(conversationId) as ExplicitRequestRow | null;
}

/** The applied request that saved this item as its new version. */
export function appliedRequestOfItem(
	db: Database,
	conversationId: string,
	itemId: string,
): ExplicitRequestRow | null {
	return db
		.query(
			`SELECT ${REQUEST_COLUMNS} FROM memory_explicit_request
			 WHERE conversation_id = ? AND item_id = ? AND state = 'applied' ORDER BY seq DESC LIMIT 1`,
		)
		.get(conversationId, itemId) as ExplicitRequestRow | null;
}

export function markRequestWithdrawn(
	db: Database,
	requestId: string,
	restoredItemId: string | null,
	now: string,
) {
	db.query(
		"UPDATE memory_explicit_request SET state = 'withdrawn', restored_item_id = ?, withdrawn_at = ? WHERE request_id = ?",
	).run(restoredItemId, now, requestId);
}

/** A forget removes the requests that name one of its items (they carry no text, but they point at the forgotten). */
export function purgeExplicitRequests(db: Database, itemIds: Iterable<string>) {
	const statement = db.query(
		"DELETE FROM memory_explicit_request WHERE item_id = ?1 OR replaced_item_id = ?1 OR restored_item_id = ?1",
	);
	for (const id of itemIds) statement.run(id);
}

// ---- short references ----

export type ShortRefRow = { ref: string; itemId: string; revision: number };

/** The window the conversation's references belong to, with the next number to hand out. */
export function readShortRefWindow(
	db: Database,
	conversationId: string,
): { windowKey: string; nextSeq: number } | null {
	return db
		.query(
			"SELECT window_key AS windowKey, next_seq AS nextSeq FROM memory_short_ref_window WHERE conversation_id = ?",
		)
		.get(conversationId) as { windowKey: string; nextSeq: number } | null;
}

/**
 * Starts a new window: every earlier reference of the conversation stops resolving. The numbers never start over
 * (`next_seq` is kept): an `m3` that stayed in the history must not name another record in the new window.
 */
export function resetShortRefWindow(
	db: Database,
	conversationId: string,
	windowKey: string,
) {
	db.query("DELETE FROM memory_short_ref WHERE conversation_id = ?").run(
		conversationId,
	);
	db.query(
		`INSERT INTO memory_short_ref_window (conversation_id, window_key, next_seq) VALUES (?,?,1)
		 ON CONFLICT(conversation_id) DO UPDATE SET window_key = excluded.window_key`,
	).run(conversationId, windowKey);
}

export function findShortRef(
	db: Database,
	conversationId: string,
	itemId: string,
	revision: number,
): string | null {
	const row = db
		.query(
			"SELECT ref FROM memory_short_ref WHERE conversation_id = ? AND item_id = ? AND revision = ?",
		)
		.get(conversationId, itemId, revision) as { ref: string } | null;
	return row?.ref ?? null;
}

/** Hands out the next number of the window's references and records what it stands for. */
export function insertShortRef(
	db: Database,
	conversationId: string,
	itemId: string,
	revision: number,
): string {
	const window = readShortRefWindow(db, conversationId);
	const next = window?.nextSeq ?? 1;
	const ref = `m${next}`;
	db.query(
		"INSERT INTO memory_short_ref (conversation_id, ref, item_id, revision) VALUES (?,?,?,?)",
	).run(conversationId, ref, itemId, revision);
	db.query(
		"UPDATE memory_short_ref_window SET next_seq = ? WHERE conversation_id = ?",
	).run(next + 1, conversationId);
	return ref;
}

export function readShortRef(
	db: Database,
	conversationId: string,
	ref: string,
): ShortRefRow | null {
	return db
		.query(
			"SELECT ref, item_id AS itemId, revision FROM memory_short_ref WHERE conversation_id = ? AND ref = ?",
		)
		.get(conversationId, ref) as ShortRefRow | null;
}

export function purgeShortRefs(db: Database, itemIds: Iterable<string>) {
	const statement = db.query("DELETE FROM memory_short_ref WHERE item_id = ?");
	for (const id of itemIds) statement.run(id);
}

// ---- topic words ----

export function insertTopicSuppression(
	db: Database,
	term: string,
	conversationId: string,
	runId: string,
	now: string,
): boolean {
	return (
		db
			.query(
				"INSERT OR IGNORE INTO memory_topic_suppression (term, conversation_id, run_id, created_at) VALUES (?,?,?,?)",
			)
			.run(term, conversationId, runId, now).changes > 0
	);
}

export function deleteTopicSuppression(db: Database, term: string): boolean {
	return (
		db.query("DELETE FROM memory_topic_suppression WHERE term = ?").run(term)
			.changes > 0
	);
}

export function listTopicSuppressions(db: Database): string[] {
	return (
		db
			.query(
				"SELECT term FROM memory_topic_suppression ORDER BY created_at, term",
			)
			.all() as Array<{ term: string }>
	).map((row) => row.term);
}

/** Whether a stored window (the profile or the additions waiting beside it) shows one of the items. */
export function windowsShowing(
	db: Database,
	itemIds: ReadonlySet<string>,
): boolean {
	for (const row of db
		.query("SELECT snapshot FROM memory_context_window")
		.all() as Array<{ snapshot: string }>) {
		const snapshot = JSON.parse(row.snapshot) as {
			profile?: { items?: Array<{ id: string }> };
			newMemories?: Array<{ id: string }>;
		};
		const shown = [
			...(snapshot.profile?.items ?? []),
			...(snapshot.newMemories ?? []),
		];
		if (shown.some((item) => itemIds.has(item.id))) return true;
	}
	return false;
}

/** The conversations that hold a stored window. */
export function windowConversations(db: Database): string[] {
	return (
		db
			.query("SELECT conversation_id AS id FROM memory_context_window")
			.all() as Array<{
			id: string;
		}>
	).map((row) => row.id);
}

/** The run that wrote each tendency of the sleeping layer; a deleted tendency takes its row along. */
export const tendencyRunMigration = `
CREATE TABLE memory_tendency_run (tendency_id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
CREATE TRIGGER memory_tendency_run_cleanup AFTER DELETE ON memory_tendency
BEGIN DELETE FROM memory_tendency_run WHERE tendency_id = OLD.id; END;
`;

/** The run that wrote a tendency (L4 written by the sleeping layer). */
export function putTendencyRun(
	db: Database,
	tendencyId: string,
	runId: string,
) {
	db.query(
		"INSERT OR REPLACE INTO memory_tendency_run (tendency_id, run_id) VALUES (?,?)",
	).run(tendencyId, runId);
}

/** Whether the user asked for a record or the background pass noted it (a withdrawal without a target undoes only the former). */
export const explicitRequestedMigration = `
ALTER TABLE memory_explicit_request ADD COLUMN requested INTEGER NOT NULL DEFAULT 1;
`;
