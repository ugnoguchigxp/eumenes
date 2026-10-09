import type { Database } from "bun:sqlite";
import { WORLD_FEEDS, type WorldFeed } from "../contracts";

/**
 * Host-owned World state. World's own tables (`world_*` from the package) are
 * never read or written here. Append-only: add new migrations, never edit this one.
 *
 * - `world_host_state`: the ON/OFF flag (default OFF) and the restore epoch.
 * - `world_host_forget_epoch`: per-Scope forget epoch; absent row = the initial token.
 * - `world_host_feed_cursor`: source/memory feed positions, stamped with the
 *   restore epoch that issued them (a cursor from an older epoch is not used).
 */
export const hostStateMigration = `
CREATE TABLE world_host_state (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
	restore_epoch TEXT NOT NULL CHECK (length(restore_epoch) BETWEEN 1 AND 200),
	revision INTEGER NOT NULL DEFAULT 1
);
INSERT INTO world_host_state (id, enabled, restore_epoch, revision) VALUES (1, 0, 'restore-0', 1);
CREATE TABLE world_host_forget_epoch (
	principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 200),
	scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 200),
	forget_epoch TEXT NOT NULL CHECK (length(forget_epoch) BETWEEN 1 AND 200),
	PRIMARY KEY (principal, scope_key)
) WITHOUT ROWID;
CREATE TABLE world_host_feed_cursor (
	feed TEXT NOT NULL CHECK (feed IN ('source', 'memory')),
	principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 200),
	scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 200),
	restore_epoch TEXT NOT NULL CHECK (length(restore_epoch) BETWEEN 1 AND 200),
	cursor TEXT NOT NULL CHECK (length(cursor) BETWEEN 1 AND 512),
	PRIMARY KEY (feed, principal, scope_key)
) WITHOUT ROWID;
`;

/** Epoch seen by a Scope that has never had a forget. */
export const INITIAL_FORGET_EPOCH = "forget-0";

export class WorldHostStateError extends Error {
	constructor(
		readonly code:
			| "state_missing"
			| "transaction_required"
			| "initial_sync_required",
	) {
		super(`world_host_${code}`);
	}
}

function requireWriteTransaction(db: Database): void {
	if (!db.inTransaction) throw new WorldHostStateError("transaction_required");
}

export type HostStateRow = {
	enabled: boolean;
	restoreEpoch: string;
	revision: number;
	/**
	 * The host finished the first full pass over Memory's change feed and the
	 * source outboxes (so every earlier forget/correction is already applied).
	 * World cannot be turned ON before; see guardMigration.
	 */
	initialSyncComplete: boolean;
};

export function readHostState(db: Database): HostStateRow {
	const row = db
		.query(
			"SELECT enabled, restore_epoch, revision, initial_sync_complete FROM world_host_state WHERE id = 1",
		)
		.get() as
		| {
				enabled: number;
				restore_epoch: string;
				revision: number;
				initial_sync_complete: number;
		  }
		| null
		| undefined;
	if (!row) throw new WorldHostStateError("state_missing");
	return {
		enabled: row.enabled === 1,
		restoreEpoch: row.restore_epoch,
		revision: row.revision,
		initialSyncComplete: row.initial_sync_complete === 1,
	};
}

/**
 * Turning World ON needs the explicit host flag `initialSyncComplete`; turning
 * it OFF never does. Throws WorldHostStateError("initial_sync_required").
 */
export function writeEnabled(db: Database, enabled: boolean): void {
	requireWriteTransaction(db);
	if (enabled && !readHostState(db).initialSyncComplete)
		throw new WorldHostStateError("initial_sync_required");
	db.query(
		"UPDATE world_host_state SET enabled = ?, revision = revision + 1 WHERE id = 1",
	).run(enabled ? 1 : 0);
}

/** The host's statement that the first full feed pass is done. Never reset by World. */
export function writeInitialSyncComplete(db: Database, done: boolean): void {
	requireWriteTransaction(db);
	db.query(
		"UPDATE world_host_state SET initial_sync_complete = ?, revision = revision + 1 WHERE id = 1",
	).run(done ? 1 : 0);
}

/** Replaces the restore epoch with a new opaque token. Cursors stamped with the old one stop being used. */
export function writeRestoreEpoch(db: Database, token: string): void {
	requireWriteTransaction(db);
	db.query(
		"UPDATE world_host_state SET restore_epoch = ?, revision = revision + 1 WHERE id = 1",
	).run(token);
}

export function readForgetEpoch(
	db: Database,
	principal: string,
	scopeKey: string,
): string {
	const row = db
		.query(
			"SELECT forget_epoch FROM world_host_forget_epoch WHERE principal = ? AND scope_key = ?",
		)
		.get(principal, scopeKey) as { forget_epoch: string } | null | undefined;
	return row?.forget_epoch ?? INITIAL_FORGET_EPOCH;
}

export function writeForgetEpoch(
	db: Database,
	principal: string,
	scopeKey: string,
	token: string,
): void {
	requireWriteTransaction(db);
	db.query(
		`INSERT INTO world_host_forget_epoch (principal, scope_key, forget_epoch) VALUES (?, ?, ?)
		ON CONFLICT (principal, scope_key) DO UPDATE SET forget_epoch = excluded.forget_epoch`,
	).run(principal, scopeKey, token);
}

export type FeedCursorRow = {
	/** null: start from the beginning (never set, or issued under an older restore epoch). */
	cursor: string | null;
	/** True when a stored cursor was ignored because its restore epoch is no longer current. */
	stale: boolean;
	restoreEpoch: string;
};

export function readFeedCursor(
	db: Database,
	feed: WorldFeed,
	principal: string,
	scopeKey: string,
): FeedCursorRow {
	assertFeed(feed);
	const { restoreEpoch } = readHostState(db);
	const row = db
		.query(
			"SELECT restore_epoch, cursor FROM world_host_feed_cursor WHERE feed = ? AND principal = ? AND scope_key = ?",
		)
		.get(feed, principal, scopeKey) as
		| { restore_epoch: string; cursor: string }
		| null
		| undefined;
	if (!row) return { cursor: null, stale: false, restoreEpoch };
	if (row.restore_epoch !== restoreEpoch)
		return { cursor: null, stale: true, restoreEpoch };
	return { cursor: row.cursor, stale: false, restoreEpoch };
}

/** Stores a cursor under the CURRENT restore epoch. */
export function writeFeedCursor(
	db: Database,
	feed: WorldFeed,
	principal: string,
	scopeKey: string,
	cursor: string,
): void {
	requireWriteTransaction(db);
	assertFeed(feed);
	const { restoreEpoch } = readHostState(db);
	// An unchanged cursor writes nothing: an idle feed poll must not commit
	// (a commit notifies every listener, e.g. the UI change stream).
	const current = db
		.query(
			"SELECT restore_epoch, cursor FROM world_host_feed_cursor WHERE feed = ? AND principal = ? AND scope_key = ?",
		)
		.get(feed, principal, scopeKey) as
		| { restore_epoch: string; cursor: string }
		| null
		| undefined;
	if (current?.restore_epoch === restoreEpoch && current.cursor === cursor)
		return;
	db.query(
		`INSERT INTO world_host_feed_cursor (feed, principal, scope_key, restore_epoch, cursor) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (feed, principal, scope_key) DO UPDATE SET restore_epoch = excluded.restore_epoch, cursor = excluded.cursor`,
	).run(feed, principal, scopeKey, restoreEpoch, cursor);
}

function assertFeed(feed: string): void {
	if (!(WORLD_FEEDS as readonly string[]).includes(feed))
		throw new RangeError("invalid_world_feed");
}
