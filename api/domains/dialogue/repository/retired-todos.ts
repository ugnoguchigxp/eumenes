import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";

/**
 * The retired TODO ledger leaves (spec toolchain-assignment-as-research-2026-11-25.md section 14): its tables, the
 * confirmations, the command question forms and the first generated-image table are dropped with their rows. What
 * they made elsewhere goes with them: the resources entered under a TODO are no longer shown, and the short-term memory
 * events (`work:<id>`) and the research runs a TODO named wait in `dialogue_retired_todo_traces` until the startup
 * forgets them through their owners (retired-todo-traces.ts).
 */
export const dropRetiredTodosMigration: Migration = {
	id: "dialogue/0049-drop-retired-todos",
	after: ["dialogue/0048-assignment-images"],
	sql: `CREATE TABLE dialogue_retired_todo_traces (
		kind TEXT NOT NULL CHECK(kind IN ('event','research')),
		id TEXT NOT NULL,
		PRIMARY KEY(kind, id)
	);
	INSERT INTO dialogue_retired_todo_traces(kind, id) SELECT 'event', 'work:' || id FROM dialogue_work;
	INSERT OR IGNORE INTO dialogue_retired_todo_traces(kind, id)
		SELECT 'research', source_ref FROM dialogue_work
		WHERE toolchain_id = 'web.research' AND source_ref IS NOT NULL AND source_ref <> '';
	UPDATE dialogue_resources SET forgotten_at = COALESCE(forgotten_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		WHERE source = 'work' AND work_id IN (SELECT id FROM dialogue_work);
	DROP TABLE dialogue_generated_images;
	DROP TABLE command_interaction_events;
	DROP TABLE command_interactions;
	DROP TABLE dialogue_confirmations;
	DROP TABLE dialogue_work;`,
};

export type RetiredTodoTraces = { events: string[]; research: string[] };

export function retiredTodoTraces(db: Database): RetiredTodoTraces {
	const rows = db
		.query(
			"SELECT kind, id FROM dialogue_retired_todo_traces ORDER BY kind, id",
		)
		.all() as Array<{ kind: "event" | "research"; id: string }>;
	return {
		events: rows.filter((r) => r.kind === "event").map((r) => r.id),
		research: rows.filter((r) => r.kind === "research").map((r) => r.id),
	};
}

export function dropRetiredTodoTraces(
	db: Database,
	kind: "event" | "research",
) {
	db.query("DELETE FROM dialogue_retired_todo_traces WHERE kind = ?").run(kind);
}
