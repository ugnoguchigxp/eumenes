import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { TargetRequest } from "../contracts";
import type { InboxRow } from "./index";

/**
 * `steward/0008-target-requests`: the requests that name their target in words (a correction, a forget, a
 * suppression) are resolved by the agency alone, so the inbox keeps what the agency needs.
 *   - `steward_inbox` takes the `suppress` kind and two columns: `request` (the request as the agency reads it, JSON;
 *     null for a request the conversation agent made with a short reference, which `curate-memory` answers) and
 *     `told_at` (when the user was told that nothing was changed). SQLite can not alter a CHECK: the table is rebuilt.
 */
export const targetRequestsMigration: Migration = {
	id: "steward/0008-target-requests",
	after: ["steward/0007-sleep-layer"],
	sql: `
CREATE TABLE steward_inbox_next (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, source_ref TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('forget','remember','correct','goal','withdraw','suppress')), what TEXT NOT NULL, detail TEXT,
 state TEXT NOT NULL CHECK(state IN ('pending','excluded','done','none')),
 result_code TEXT, failures INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, resolved_at TEXT,
 exclusion TEXT, request TEXT, told_at TEXT
);
INSERT INTO steward_inbox_next (id, conversation_id, source_ref, kind, what, detail, state, result_code, failures,
 created_at, resolved_at, exclusion)
 SELECT id, conversation_id, source_ref, kind, what, detail, state, result_code, failures, created_at, resolved_at,
 exclusion FROM steward_inbox;
DROP TABLE steward_inbox;
ALTER TABLE steward_inbox_next RENAME TO steward_inbox;
CREATE INDEX steward_inbox_conversation ON steward_inbox(conversation_id, state, created_at);
CREATE INDEX steward_inbox_source ON steward_inbox(source_ref);
`,
};

// ---- the requests that name their target in words ----

/**
 * Keeps what the agency needs to resolve the target on a request. A request the conversation agent made with
 * `requestInTransaction` (a forget) already has its row: the same row gets the details. False when the row exists
 * but is no longer pending (nothing changes).
 */
export function putTargetRequest(
	db: Database,
	input: {
		id: string;
		request: TargetRequest;
		sourceRef: string;
		createdAt: string;
	},
): boolean {
	const json = JSON.stringify(input.request);
	const existing = db
		.query("SELECT state FROM steward_inbox WHERE id = ?")
		.get(input.id) as { state: string } | null;
	if (existing) {
		if (existing.state !== "pending") return false;
		db.query(
			"UPDATE steward_inbox SET request = ? WHERE id = ? AND state = 'pending'",
		).run(json, input.id);
		return true;
	}
	db.query(
		`INSERT INTO steward_inbox (id, conversation_id, source_ref, kind, what, detail, state, created_at, request)
		 VALUES (?,?,?,?,?,?, 'pending', ?, ?)`,
	).run(
		input.id,
		input.request.conversationId,
		input.sourceRef,
		input.request.kind,
		input.request.what,
		input.request.detail ?? null,
		input.createdAt,
		json,
	);
	return true;
}

/** The pending requests that name their target in words, oldest first. */
export function pendingTargets(
	db: Database,
	conversationId?: string,
): Array<{ id: string; request: TargetRequest }> {
	const rows = db
		.query(
			`SELECT id, request FROM steward_inbox WHERE state = 'pending' AND request IS NOT NULL
			 ${conversationId === undefined ? "" : "AND conversation_id = ?"} ORDER BY created_at, id`,
		)
		.all(...(conversationId === undefined ? [] : [conversationId])) as Array<{
		id: string;
		request: string;
	}>;
	return rows.map((row) => ({
		id: row.id,
		request: JSON.parse(row.request) as TargetRequest,
	}));
}

/** A forget of the conversation that is not settled yet: nothing decided, or nothing excluded yet. */
export function hasPendingForget(
	db: Database,
	conversationId: string,
): boolean {
	return (
		db
			.query(
				"SELECT 1 FROM steward_inbox WHERE conversation_id = ? AND kind = 'forget' AND state = 'pending' LIMIT 1",
			)
			.get(conversationId) != null
	);
}

/**
 * The agency settled the request: applied ends it; unresolved ends it without a change and keeps its words (and
 * only its words) until the user was told. False when the request is not pending.
 */
export function settleTarget(
	db: Database,
	input: { id: string; outcome: "applied" | "unresolved"; now: string },
): boolean {
	const sql =
		input.outcome === "applied"
			? `UPDATE steward_inbox SET state = 'done', result_code = NULL, what = '', detail = NULL, request = NULL,
				exclusion = NULL, resolved_at = ? WHERE id = ? AND state = 'pending' AND request IS NOT NULL`
			: `UPDATE steward_inbox SET state = 'none', result_code = 'unresolved', detail = NULL, request = NULL,
				resolved_at = ? WHERE id = ? AND state = 'pending' AND request IS NOT NULL`;
	return db.query(sql).run(input.now, input.id).changes === 1;
}

/** The unresolved requests of the conversation not yet told to the user; each is returned once (its words are cleared). */
export function takeUnresolved(
	db: Database,
	conversationId: string,
	now: string,
): Array<{ id: string; kind: InboxRow["kind"]; what: string }> {
	const rows = db
		.query(
			`SELECT id, kind, what FROM steward_inbox WHERE conversation_id = ? AND state = 'none'
			 AND result_code = 'unresolved' AND told_at IS NULL ORDER BY created_at, id`,
		)
		.all(conversationId) as Array<{
		id: string;
		kind: InboxRow["kind"];
		what: string;
	}>;
	const told = db.query(
		"UPDATE steward_inbox SET told_at = ?, what = '' WHERE id = ?",
	);
	for (const row of rows) told.run(now, row.id);
	return rows;
}
