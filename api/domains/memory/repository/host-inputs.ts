import type { Database } from "bun:sqlite";
export const hostInputsMigration = `CREATE TABLE memory_host_run_inputs(run_id TEXT PRIMARY KEY,input_json TEXT NOT NULL);`;
export type HostInput = { sources: readonly string[]; complete: boolean };
export function readHostInput(db: Database, id: string): HostInput | null {
	const row = db
		.query("SELECT input_json FROM memory_host_run_inputs WHERE run_id=?")
		.get(id) as { input_json: string } | null;
	return row ? (JSON.parse(row.input_json) as HostInput) : null;
}
export function writeHostInput(db: Database, id: string, input: HostInput) {
	const previous = readHostInput(db, id);
	const value = {
		sources: [...new Set([...(previous?.sources ?? []), ...input.sources])],
		complete: input.complete && (previous?.complete ?? true),
	};
	db.query(
		"INSERT INTO memory_host_run_inputs VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET input_json=excluded.input_json",
	).run(id, JSON.stringify(value));
}
export function purgeHostInputs(db: Database, refs: ReadonlySet<string>) {
	for (const row of db
		.query("SELECT run_id,input_json FROM memory_host_run_inputs")
		.all() as { run_id: string; input_json: string }[]) {
		const input = JSON.parse(row.input_json) as HostInput;
		if (!input.complete || input.sources.some((ref) => refs.has(ref)))
			db.query("DELETE FROM memory_host_run_inputs WHERE run_id=?").run(
				row.run_id,
			);
	}
}
