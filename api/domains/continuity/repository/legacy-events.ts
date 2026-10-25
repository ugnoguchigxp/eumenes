import type { Database } from "bun:sqlite";

// The retired bookmark ledger predates continuity/0001-init. Keep its data,
// but free the name required by continuity/0004-events. Never rename the new flow.
const legacyColumns = [
	"sequence",
	"id",
	"bookmark_id",
	"conversation_id",
	"operation",
	"kind",
	"text",
	"status",
	"revision",
	"source_message_id",
	"source_digest",
	"origin",
	"request_id",
	"request_digest",
	"created_at",
];

export function hasLegacyContinuityEvents(db: Database): boolean {
	const columns = db.query("PRAGMA table_info(continuity_events)").all() as {
		name: string;
		type: string;
		pk: number;
	}[];
	if (!columns.length) return false;
	// A current event flow is never an archive candidate.
	if (columns.some((column) => column.name === "seq" && column.pk === 2))
		return false;
	if (
		columns.length !== legacyColumns.length ||
		columns.some((column, i) => column.name !== legacyColumns[i]) ||
		columns[0]?.type !== "INTEGER" ||
		columns[0]?.pk !== 1
	)
		throw new Error("continuity_legacy_schema_unknown");
	if (
		db
			.query("SELECT 1 FROM sqlite_schema WHERE name = ?")
			.get("continuity_legacy_bookmark_events")
	)
		throw new Error("continuity_legacy_archive_exists");
	return true;
}

/** Run in the store's writer transaction, after taking a backup. */
export function archiveLegacyContinuityEventsInTransaction(
	db: Database,
): boolean {
	if (!hasLegacyContinuityEvents(db)) return false;
	db.exec(
		"ALTER TABLE continuity_events RENAME TO continuity_legacy_bookmark_events",
	);
	return true;
}
