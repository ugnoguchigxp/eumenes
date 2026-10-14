import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";

/**
 * Tables whose first row means "World holds something that forgetting must still
 * reach": registered entities, assertions, received extraction input (package inbox
 * and host extraction events) and forget intake that may not have finished.
 */
const CONTENT_TABLES = [
	"world_entity",
	"world_assertion",
	"world_inbox",
	"world_host_extract_event",
	"world_host_forget_intake",
] as const;

/** True when any Scope holds World content. One indexed probe per table; reads nothing else. */
function hasContent(db: Database): boolean {
	for (const table of CONTENT_TABLES) {
		const installed = db
			.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
			.get(table);
		if (installed && db.query(`SELECT 1 FROM ${table} LIMIT 1`).get())
			return true;
	}
	return false;
}

/**
 * Backend-startup question: must forget propagation keep running although World is
 * OFF? Independent of the ON/OFF flag and the gate, so it works before World is assembled.
 */
export const worldHasContent = (store: SqliteStore): boolean =>
	store.readSnapshot(hasContent);
