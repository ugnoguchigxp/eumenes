import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import { seedImportMigration } from "./seeds";
export * from "./seeds";
export * from "./window";
export * from "./tendency";
export * from "./ledger";
export * from "./turn-vector";
export const migration = `
CREATE TABLE memory_host_settings (id INTEGER PRIMARY KEY CHECK(id = 1), enabled INTEGER NOT NULL, revision INTEGER NOT NULL);
INSERT INTO memory_host_settings (id, enabled, revision) VALUES (1, 1, 1);
CREATE TABLE memory_usage (
 run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, view_digest TEXT NOT NULL, state_revision TEXT NOT NULL,
 package_version TEXT NOT NULL, view_schema INTEGER NOT NULL, item_ids TEXT NOT NULL, created_at TEXT NOT NULL
);
`;
export function readSettings(db: Database): {
	enabled: boolean;
	revision: number;
} {
	const row = db
		.query("SELECT enabled, revision FROM memory_host_settings WHERE id = 1")
		.get() as { enabled: number; revision: number };
	return { enabled: row.enabled === 1, revision: row.revision };
}
export function writeSettings(db: Database, enabled: boolean) {
	db.query(
		"UPDATE memory_host_settings SET enabled = ?, revision = revision + 1 WHERE id = 1",
	).run(enabled ? 1 : 0);
}
export interface UsageReceipt {
	runId: string;
	conversationId: string;
	viewDigest: string;
	stateRevision: string;
	packageVersion: string;
	viewSchema: number;
	itemIds: string[];
	createdAt: string;
}
export function insertUsage(db: Database, receipt: UsageReceipt) {
	db.query(
		"INSERT OR REPLACE INTO memory_usage (run_id, conversation_id, view_digest, state_revision, package_version, view_schema, item_ids, created_at) VALUES (?,?,?,?,?,?,?,?)",
	).run(
		receipt.runId,
		receipt.conversationId,
		receipt.viewDigest,
		receipt.stateRevision,
		receipt.packageVersion,
		receipt.viewSchema,
		JSON.stringify(receipt.itemIds),
		receipt.createdAt,
	);
}
/** Receipts only matter for recent runs: keep the newest ones. */
export function pruneUsage(db: Database, keep = 5000) {
	db.query(
		"DELETE FROM memory_usage WHERE run_id IN (SELECT run_id FROM memory_usage ORDER BY created_at DESC, run_id DESC LIMIT -1 OFFSET ?)",
	).run(keep);
}
export function getUsage(db: Database, runId: string): UsageReceipt | null {
	const row = db
		.query("SELECT * FROM memory_usage WHERE run_id = ?")
		.get(runId) as Record<string, unknown> | null;
	if (!row) return null;
	return {
		runId: row.run_id as string,
		conversationId: row.conversation_id as string,
		viewDigest: row.view_digest as string,
		stateRevision: row.state_revision as string,
		packageVersion: row.package_version as string,
		viewSchema: row.view_schema as number,
		itemIds: JSON.parse(row.item_ids as string) as string[],
		createdAt: row.created_at as string,
	};
}

/**
 * ContextWindow: the per-conversation snapshot, the immediate-change log that expires runs in flight,
 * and the host tables the memory agent (S2) wrote. Frozen once deployed.
 */
export const contextWindowMigration = `
CREATE TABLE memory_context_window (
 conversation_id TEXT PRIMARY KEY,
 version INTEGER NOT NULL,
 build_id TEXT NOT NULL,
 snapshot TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE memory_immediate_change (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 kind TEXT NOT NULL,
 source_run_id TEXT,
 created_at TEXT NOT NULL
);
CREATE TABLE memory_tendency_revision (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL);
INSERT INTO memory_tendency_revision (id, revision) VALUES (1, 0);
CREATE TABLE memory_item_provenance (
 item_id TEXT PRIMARY KEY, run_id TEXT,
 mode TEXT NOT NULL CHECK(mode IN ('request','agent','manual')), created_at TEXT NOT NULL
);
CREATE TABLE memory_tendency (
 id TEXT PRIMARY KEY, text TEXT NOT NULL,
 evidence TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','retired')), revision INTEGER NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE memory_agent_cursor (
 conversation_id TEXT PRIMARY KEY, last_ordinal INTEGER NOT NULL
);
`;

/**
 * Hardening of the memory agent: the messages it must not learn from, the control request of each job
 * (so a lost job can still release it), and a failure count on the read cursor.
 */
export const agentHardeningMigration = `
ALTER TABLE memory_agent_cursor ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
CREATE TABLE memory_agent_excluded_message (message_id TEXT PRIMARY KEY);
CREATE TABLE memory_agent_request (job_id TEXT PRIMARY KEY, request_id TEXT NOT NULL);
`;

/** The embedding of each message (user and assistant), for finding exchanges that left the verbatim window. */
export const turnVectorsMigration = `
CREATE TABLE memory_turn_vector (
 message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
 space TEXT NOT NULL, vector BLOB NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX memory_turn_vector_conversation ON memory_turn_vector(conversation_id, space, ordinal);
`;

/**
 * The steward's ledgers: exchanges with their step marks, the conversation summary and its sources, the blocked
 * messages (what `memory_agent_excluded_message` held becomes `scheduled_prompt`), and the forget fence.
 * The old agent's cursor, request and exclusion tables go. The old exclusions did not name a conversation (and the
 * messages table belongs to conversation, not to this migration), so they become blocks of conversation '':
 * a block of '' applies to every conversation, and a message id is unique anyway.
 */
export const stewardLedgersMigration = `
CREATE TABLE memory_exchange (
 input_message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, run_id TEXT NOT NULL,
 answer_message_id TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('answered','failed')),
 input_ordinal INTEGER NOT NULL, answer_ordinal INTEGER,
 state TEXT NOT NULL CHECK(state IN ('pending','done')),
 curated TEXT CHECK(curated IN ('done','skipped')), disposed TEXT CHECK(disposed IN ('done','skipped')),
 summarized TEXT CHECK(summarized IN ('done','skipped')),
 disposition TEXT CHECK(disposition IN ('keep','summarize','drop')), duplicate_of TEXT,
 failures TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX memory_exchange_state ON memory_exchange(conversation_id, state, answer_ordinal);
CREATE TABLE memory_conversation_summary (
 conversation_id TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE memory_summary_source (
 conversation_id TEXT NOT NULL, revision INTEGER NOT NULL, input_message_id TEXT NOT NULL,
 PRIMARY KEY (conversation_id, revision, input_message_id)
);
CREATE INDEX memory_summary_source_message ON memory_summary_source(input_message_id);
CREATE TABLE memory_forget_fence (id INTEGER PRIMARY KEY CHECK(id = 1), seq INTEGER NOT NULL);
INSERT INTO memory_forget_fence (id, seq) VALUES (1, 0);
CREATE TABLE memory_message_block (
 message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN ('scheduled_prompt','forgotten')), forget_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX memory_message_block_conversation ON memory_message_block(conversation_id);
INSERT INTO memory_message_block (message_id, conversation_id, reason, forget_id, created_at)
 SELECT message_id, '', 'scheduled_prompt', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 FROM memory_agent_excluded_message;
ALTER TABLE memory_item_provenance ADD COLUMN quote_matched INTEGER;
DROP TABLE memory_agent_cursor;
DROP TABLE memory_agent_request;
DROP TABLE memory_agent_excluded_message;
`;

/**
 * What a forget needs to be complete: the merge lineage (forgetting a merged item forgets what it was merged
 * from, and the other way round) and the block journal lines whose derived-data purge has been applied (a
 * restored database loses these marks, so the purge runs again for it).
 */
export const forgetClosureMigration = `
CREATE TABLE memory_item_merge (item_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY (item_id, source_id));
CREATE INDEX memory_item_merge_source ON memory_item_merge(source_id);
CREATE TABLE memory_block_applied (forget_id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
`;

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "memory/0001-init", sql: migration },
	{
		id: "memory/0002-context-window",
		sql: contextWindowMigration,
		after: ["memory/0001-init"],
	},
	{
		id: "memory/0003-agent-hardening",
		sql: agentHardeningMigration,
		after: ["memory/0002-context-window"],
	},
	{
		id: "memory/0004-turn-vectors",
		sql: turnVectorsMigration,
		after: ["memory/0003-agent-hardening"],
	},
	{
		id: "memory/0005-steward-ledgers",
		sql: stewardLedgersMigration,
		after: ["memory/0004-turn-vectors"],
	},
	{
		id: "memory/0006-forget-closure",
		sql: forgetClosureMigration,
		after: ["memory/0005-steward-ledgers"],
	},
	{
		id: "memory/0007-seed-import",
		sql: seedImportMigration,
		after: ["memory/0006-forget-closure"],
	},
];
