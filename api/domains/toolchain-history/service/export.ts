import type { Database } from "bun:sqlite";
import type {
	RouterTraceRow,
	RouterFeedbackRow,
	SelectionRow,
} from "../repository";
import type { RouterTrace } from "../contracts";

/** Raw records stay within the backend; the application exports only the explicit evaluation fields. No pruning. */
export function routingExportRecords(db: Database, since: number) {
	const selections = db
		.query(
			"SELECT * FROM toolchain_selections WHERE created_at>=? ORDER BY created_at,run_id",
		)
		.all(since) as SelectionRow[];
	const traces = db
		.query(
			"SELECT * FROM router_traces WHERE created_at>=? ORDER BY created_at,run_id",
		)
		.all(since) as RouterTraceRow[];
	const corrections = db
		.query(
			"SELECT * FROM router_feedback WHERE updated_at>=? ORDER BY updated_at,id",
		)
		.all(since) as RouterFeedbackRow[];
	const spaces = db
		.query(
			"SELECT DISTINCT query_space,query_space_json FROM router_traces WHERE query_space_json IS NOT NULL",
		)
		.all() as Array<{ query_space: string; query_space_json: string }>;
	return {
		selections,
		traces: traces.map((row) => ({
			...row,
			trace: JSON.parse(row.trace_json) as RouterTrace,
		})),
		corrections,
		spaces,
	};
}
