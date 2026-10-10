import type { Database } from "bun:sqlite";
import { WorldHostStateError } from "./index";

/**
 * Host-owned progress of continuous input (P4-01/P4-02). Append-only
 * migration at the TAIL of the host migrations, never edited. World's own
 * tables (`world_inbox`, `world_checkpoint`) are never read or written here;
 * the package has no read API for them, so the host keeps its own record of
 * what it handed to `inbox.receive` / `candidate.settle` and WHEN, in the
 * same writer callback as the World operation. Ids and opaque cursors only:
 * no message text, no model output.
 *
 * - `world_host_extract_event`: one row per source change the host scanned.
 *   `received` and `applied` and `rejected` mirror World's inbox status of an
 *   event the host really delivered to World; `skipped` is host-only (the
 *   change was scanned while World was OFF: it is never extracted and never
 *   delivered, but it is remembered so a later resync does not extract the
 *   whole history). `seq` is the host's arrival order inside the Scope. The
 *   FeedSpec the event was delivered under is kept so a Scope-set change
 *   cannot strand an unsettled event.
 * - `world_host_extract_feed`: the Scope set a feed cursor was saved under.
 *   A different set discards the cursor and reads the feed again.
 */
export const extractionMigration = `
CREATE TABLE world_host_extract_event (
	principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 200),
	scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 200),
	event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
	seq INTEGER NOT NULL CHECK (seq >= 1),
	feed_scope_keys TEXT NOT NULL,
	feed_restore_epoch TEXT NOT NULL CHECK (length(feed_restore_epoch) BETWEEN 1 AND 200),
	received_cursor TEXT NOT NULL CHECK (length(received_cursor) BETWEEN 1 AND 512),
	source_key TEXT NOT NULL,
	source_json TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('received', 'applied', 'rejected', 'skipped')),
	reason TEXT CHECK (reason IS NULL OR length(reason) <= 100),
	failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
	retry_at_ms INTEGER NOT NULL DEFAULT 0,
	job_id TEXT CHECK (job_id IS NULL OR length(job_id) <= 200),
	manifest_id TEXT CHECK (manifest_id IS NULL OR length(manifest_id) <= 200),
	request_id TEXT CHECK (request_id IS NULL OR length(request_id) <= 200),
	received_at_ms INTEGER NOT NULL,
	settled_at_ms INTEGER,
	PRIMARY KEY (principal, scope_key, event_id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX world_host_extract_event_seq ON world_host_extract_event (principal, scope_key, seq);
CREATE INDEX world_host_extract_event_source ON world_host_extract_event (principal, scope_key, source_key);
CREATE INDEX world_host_extract_event_open ON world_host_extract_event (principal, scope_key, seq) WHERE state = 'received';
CREATE TABLE world_host_extract_feed (
	feed TEXT NOT NULL CHECK (feed IN ('source', 'memory')),
	principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 200),
	scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 200),
	scope_set TEXT NOT NULL,
	PRIMARY KEY (feed, principal, scope_key)
) WITHOUT ROWID;
`;

export const EXTRACT_EVENT_STATES = [
	"received",
	"applied",
	"rejected",
	"skipped",
] as const;
export type ExtractEventState = (typeof EXTRACT_EVENT_STATES)[number];

export type ExtractSourceRef = {
	namespace: string;
	kind: string;
	id: string;
	representation: string;
	revision: string;
	digest: string;
};

export type ExtractEventRow = {
	principal: string;
	scopeKey: string;
	eventId: string;
	seq: number;
	feedScopeKeys: string[];
	feedRestoreEpoch: string;
	receivedCursor: string;
	sourceKey: string;
	source: ExtractSourceRef;
	state: ExtractEventState;
	reason: string | null;
	heldContextDigest: string | null;
	failures: number;
	retryAtMs: number;
	jobId: string | null;
	manifestId: string | null;
	requestId: string | null;
	receivedAtMs: number;
	settledAtMs: number | null;
};

type Raw = {
	principal: string;
	scope_key: string;
	event_id: string;
	seq: number;
	feed_scope_keys: string;
	feed_restore_epoch: string;
	received_cursor: string;
	source_key: string;
	source_json: string;
	state: ExtractEventState;
	reason: string | null;
	held_context_digest: string | null;
	failures: number;
	retry_at_ms: number;
	job_id: string | null;
	manifest_id: string | null;
	request_id: string | null;
	received_at_ms: number;
	settled_at_ms: number | null;
};

const COLUMNS =
	"principal, scope_key, event_id, seq, feed_scope_keys, feed_restore_epoch, received_cursor, source_key, source_json, state, reason, held_context_digest, failures, retry_at_ms, job_id, manifest_id, request_id, received_at_ms, settled_at_ms";

const toRow = (raw: Raw): ExtractEventRow => ({
	principal: raw.principal,
	scopeKey: raw.scope_key,
	eventId: raw.event_id,
	seq: raw.seq,
	feedScopeKeys: JSON.parse(raw.feed_scope_keys) as string[],
	feedRestoreEpoch: raw.feed_restore_epoch,
	receivedCursor: raw.received_cursor,
	sourceKey: raw.source_key,
	source: JSON.parse(raw.source_json) as ExtractSourceRef,
	state: raw.state,
	reason: raw.reason,
	heldContextDigest: raw.held_context_digest,
	failures: raw.failures,
	retryAtMs: raw.retry_at_ms,
	jobId: raw.job_id,
	manifestId: raw.manifest_id,
	requestId: raw.request_id,
	receivedAtMs: raw.received_at_ms,
	settledAtMs: raw.settled_at_ms,
});

function requireTransaction(db: Database): void {
	if (!db.inTransaction) throw new WorldHostStateError("transaction_required");
}

export function getExtractEvent(
	db: Database,
	principal: string,
	scopeKey: string,
	eventId: string,
): ExtractEventRow | null {
	const raw = db
		.query(
			`SELECT ${COLUMNS} FROM world_host_extract_event WHERE principal = ? AND scope_key = ? AND event_id = ?`,
		)
		.get(principal, scopeKey, eventId) as Raw | null;
	return raw ? toRow(raw) : null;
}

/** The next arrival number of a Scope (never reused: purged rows leave gaps). */
export function nextExtractSeq(
	db: Database,
	principal: string,
	scopeKey: string,
): number {
	const row = db
		.query(
			"SELECT COALESCE(MAX(seq), 0) AS n FROM world_host_extract_event WHERE principal = ? AND scope_key = ?",
		)
		.get(principal, scopeKey) as { n: number };
	return row.n + 1;
}

export type NewExtractEvent = {
	principal: string;
	scopeKey: string;
	eventId: string;
	feedScopeKeys: readonly string[];
	feedRestoreEpoch: string;
	receivedCursor: string;
	sourceKey: string;
	source: ExtractSourceRef;
	state: "received" | "skipped";
	reason?: string;
	receivedAtMs: number;
};

/** Insert only; an existing event id is the caller's duplicate check. Returns the arrival number. */
export function insertExtractEvent(
	db: Database,
	input: NewExtractEvent,
): number {
	requireTransaction(db);
	const seq = nextExtractSeq(db, input.principal, input.scopeKey);
	db.query(
		`INSERT INTO world_host_extract_event
		(principal, scope_key, event_id, seq, feed_scope_keys, feed_restore_epoch, received_cursor, source_key, source_json, state, reason, received_at_ms)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.principal,
		input.scopeKey,
		input.eventId,
		seq,
		JSON.stringify([...input.feedScopeKeys]),
		input.feedRestoreEpoch,
		input.receivedCursor,
		input.sourceKey,
		JSON.stringify(input.source),
		input.state,
		input.reason ?? null,
		input.receivedAtMs,
	);
	return seq;
}

/** Events still waiting for extraction, oldest first. `due` skips events in backoff. */
export function listOpenExtractEvents(
	db: Database,
	principal: string,
	scopeKey: string,
	limit: number,
): ExtractEventRow[] {
	return (
		db
			.query(
				`SELECT ${COLUMNS} FROM world_host_extract_event
				WHERE principal = ? AND scope_key = ? AND state = 'received'
				ORDER BY seq LIMIT ?`,
			)
			.all(principal, scopeKey, limit) as Raw[]
	).map(toRow);
}

export function listExtractEventsByIds(
	db: Database,
	principal: string,
	scopeKey: string,
	eventIds: readonly string[],
): ExtractEventRow[] {
	const out: ExtractEventRow[] = [];
	const read = db.query(
		`SELECT ${COLUMNS} FROM world_host_extract_event WHERE principal = ? AND scope_key = ? AND event_id = ?`,
	);
	for (const id of eventIds) {
		const raw = read.get(principal, scopeKey, id) as Raw | null;
		if (raw) out.push(toRow(raw));
	}
	return out;
}

export function listExtractEventsBySourceKeys(
	db: Database,
	principal: string,
	scopeKey: string,
	sourceKeys: readonly string[],
): ExtractEventRow[] {
	const out: ExtractEventRow[] = [];
	const read = db.query(
		`SELECT ${COLUMNS} FROM world_host_extract_event WHERE principal = ? AND scope_key = ? AND source_key = ? ORDER BY seq`,
	);
	for (const key of sourceKeys)
		out.push(...(read.all(principal, scopeKey, key) as Raw[]).map(toRow));
	return out;
}

/** Marks an event final. `received` -> applied | rejected only. */
export function settleExtractEvent(
	db: Database,
	principal: string,
	scopeKey: string,
	eventId: string,
	state: "applied" | "rejected",
	reason: string | null,
	nowMs: number,
): void {
	requireTransaction(db);
	const changed = db
		.query(
			`UPDATE world_host_extract_event
			SET state = ?, reason = ?, settled_at_ms = ?, job_id = NULL, manifest_id = NULL, request_id = NULL, held_context_digest = NULL
			WHERE principal = ? AND scope_key = ? AND event_id = ? AND state = 'received'`,
		)
		.run(state, reason, nowMs, principal, scopeKey, eventId) as {
		changes: number;
	};
	if (changed.changes !== 1) throw new WorldHostStateError("state_missing");
}

/** Records a semantic hold only for the events this attempt still owns. */
export function holdExtractEvents(
	db: Database,
	principal: string,
	scopeKey: string,
	jobId: string,
	eventIds: readonly string[],
	contextDigest: string,
): void {
	requireTransaction(db);
	const update = db.query(
		`UPDATE world_host_extract_event
		SET held_context_digest = ?, reason = 'EXTRACTION_CONTEXT_HELD'
		WHERE principal = ? AND scope_key = ? AND event_id = ? AND job_id = ? AND state = 'received'`,
	);
	for (const eventId of eventIds) {
		const changed = update.run(
			contextDigest,
			principal,
			scopeKey,
			eventId,
			jobId,
		);
		if (changed.changes !== 1) throw new WorldHostStateError("state_missing");
	}
}

/** Hands the events to one queue job and records what was fixed at prepare. */
export function assignExtractJob(
	db: Database,
	principal: string,
	scopeKey: string,
	eventIds: readonly string[],
	jobId: string,
): void {
	requireTransaction(db);
	const update = db.query(
		`UPDATE world_host_extract_event SET job_id = ?
		WHERE principal = ? AND scope_key = ? AND event_id = ? AND state = 'received'`,
	);
	for (const id of eventIds) update.run(jobId, principal, scopeKey, id);
}

export function setExtractPrepared(
	db: Database,
	principal: string,
	scopeKey: string,
	eventId: string,
	manifestId: string | null,
	requestId: string | null,
): void {
	requireTransaction(db);
	db.query(
		`UPDATE world_host_extract_event SET manifest_id = ?, request_id = ?
		WHERE principal = ? AND scope_key = ? AND event_id = ? AND state = 'received'`,
	).run(manifestId, requestId, principal, scopeKey, eventId);
}

/**
 * The job ended without settling these events: back to the pool. A failure
 * counts and delays the next try (exponential, capped); a plain release does not.
 */
export function releaseExtractJob(
	db: Database,
	jobId: string,
	failure: { nowMs: number; baseMs: number; maxMs: number } | null,
): ExtractEventRow[] {
	requireTransaction(db);
	const rows = (
		db
			.query(
				`SELECT ${COLUMNS} FROM world_host_extract_event WHERE job_id = ? AND state = 'received' ORDER BY seq`,
			)
			.all(jobId) as Raw[]
	).map(toRow);
	if (rows.length === 0) return rows;
	if (failure)
		db.query(
			`UPDATE world_host_extract_event
			SET job_id = NULL, manifest_id = NULL, request_id = NULL,
				retry_at_ms = ? + MIN(?, ? * (1 << MIN(failures, 20))),
				failures = failures + 1
			WHERE job_id = ? AND state = 'received'`,
		).run(failure.nowMs, failure.maxMs, failure.baseMs, jobId);
	else
		db.query(
			`UPDATE world_host_extract_event
			SET job_id = NULL, manifest_id = NULL, request_id = NULL
			WHERE job_id = ? AND state = 'received'`,
		).run(jobId);
	return rows;
}

/**
 * Deletes events (any state) of these source keys / event ids. A forgotten
 * source leaves no row, not even a reason.
 */
export function purgeExtractEvents(
	db: Database,
	principal: string,
	scopeKey: string,
	by: { sourceKeys?: readonly string[]; eventIds?: readonly string[] },
): number {
	requireTransaction(db);
	let count = 0;
	const bySource = db.query(
		"DELETE FROM world_host_extract_event WHERE principal = ? AND scope_key = ? AND source_key = ?",
	);
	for (const key of by.sourceKeys ?? [])
		count += (bySource.run(principal, scopeKey, key) as { changes: number })
			.changes;
	const byId = db.query(
		"DELETE FROM world_host_extract_event WHERE principal = ? AND scope_key = ? AND event_id = ?",
	);
	for (const id of by.eventIds ?? [])
		count += (byId.run(principal, scopeKey, id) as { changes: number }).changes;
	return count;
}

/**
 * A restore deletes the events World still held unsettled (their feed key
 * embeds the old epoch): so does the host record. Final and skipped events stay.
 */
export function purgeUnsettledExtractEvents(db: Database): number {
	requireTransaction(db);
	return (
		db
			.query("DELETE FROM world_host_extract_event WHERE state = 'received'")
			.run() as { changes: number }
	).changes;
}

/**
 * The applied position: the received cursor of the last event of the
 * contiguous settled prefix (skipped events do not count). null while the
 * oldest delivered event is unsettled or nothing was delivered.
 */
export function appliedFrontier(
	db: Database,
	principal: string,
	scopeKey: string,
): { eventId: string; cursor: string; seq: number } | null {
	const firstOpen = db
		.query(
			`SELECT seq FROM world_host_extract_event
			WHERE principal = ? AND scope_key = ? AND state = 'received' ORDER BY seq LIMIT 1`,
		)
		.get(principal, scopeKey) as { seq: number } | null;
	const row = db
		.query(
			`SELECT event_id, received_cursor, seq FROM world_host_extract_event
			WHERE principal = ? AND scope_key = ? AND state IN ('applied', 'rejected') AND seq < ?
			ORDER BY seq DESC LIMIT 1`,
		)
		.get(principal, scopeKey, firstOpen?.seq ?? Number.MAX_SAFE_INTEGER) as {
		event_id: string;
		received_cursor: string;
		seq: number;
	} | null;
	return row
		? { eventId: row.event_id, cursor: row.received_cursor, seq: row.seq }
		: null;
}

export type ExtractCounts = Record<ExtractEventState, number> & {
	lastReceivedCursor: string | null;
};

export function countExtractEvents(
	db: Database,
	principal: string,
	scopeKey: string,
): ExtractCounts {
	const counts: ExtractCounts = {
		received: 0,
		applied: 0,
		rejected: 0,
		skipped: 0,
		lastReceivedCursor: null,
	};
	for (const row of db
		.query(
			`SELECT state, COUNT(*) AS n FROM world_host_extract_event
			WHERE principal = ? AND scope_key = ? GROUP BY state`,
		)
		.all(principal, scopeKey) as { state: ExtractEventState; n: number }[])
		counts[row.state] = row.n;
	const last = db
		.query(
			`SELECT received_cursor FROM world_host_extract_event
			WHERE principal = ? AND scope_key = ? AND state <> 'skipped' ORDER BY seq DESC LIMIT 1`,
		)
		.get(principal, scopeKey) as { received_cursor: string } | null;
	counts.lastReceivedCursor = last?.received_cursor ?? null;
	return counts;
}

export function readExtractFeedScopeSet(
	db: Database,
	feed: "source" | "memory",
	principal: string,
	scopeKey: string,
): string | null {
	const row = db
		.query(
			"SELECT scope_set FROM world_host_extract_feed WHERE feed = ? AND principal = ? AND scope_key = ?",
		)
		.get(feed, principal, scopeKey) as { scope_set: string } | null;
	return row?.scope_set ?? null;
}

export function writeExtractFeedScopeSet(
	db: Database,
	feed: "source" | "memory",
	principal: string,
	scopeKey: string,
	scopeSet: string,
): void {
	requireTransaction(db);
	if (readExtractFeedScopeSet(db, feed, principal, scopeKey) === scopeSet)
		return;
	db.query(
		`INSERT INTO world_host_extract_feed (feed, principal, scope_key, scope_set) VALUES (?, ?, ?, ?)
		ON CONFLICT (feed, principal, scope_key) DO UPDATE SET scope_set = excluded.scope_set`,
	).run(feed, principal, scopeKey, scopeSet);
}

/** Events that stay in the pool: the job that held them does not take them. */
export function unassignExtractEvents(
	db: Database,
	principal: string,
	scopeKey: string,
	eventIds: readonly string[],
): void {
	requireTransaction(db);
	const update = db.query(
		`UPDATE world_host_extract_event SET job_id = NULL, manifest_id = NULL, request_id = NULL
		WHERE principal = ? AND scope_key = ? AND event_id = ? AND state = 'received'`,
	);
	for (const id of eventIds) update.run(principal, scopeKey, id);
}

/** A retried attempt starts over: what the failed attempt fixed is withdrawn, the job keeps the events. */
export function clearExtractPrepared(db: Database, jobId: string): void {
	requireTransaction(db);
	db.query(
		`UPDATE world_host_extract_event SET manifest_id = NULL, request_id = NULL
		WHERE job_id = ? AND state = 'received'`,
	).run(jobId);
}
