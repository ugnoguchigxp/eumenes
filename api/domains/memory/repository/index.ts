import type { Database } from "bun:sqlite";
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
