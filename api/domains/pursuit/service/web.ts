import type { Database } from "bun:sqlite";
import type { ToolOutcome } from "eumenes-pursuit";
import {
	documents,
	pendingWeb,
	save,
	stateOf,
	type RunRow,
} from "../repository";
import { current, type Context } from "./context";

/** Adoption records receipts once. Waiting never invokes a model or retains a worker. */
export function collectWeb(ctx: Context, db: Database) {
	const rows = db
		.query(
			"SELECT * FROM pursuit_runs WHERE state='waiting_child' AND data_json IS NOT NULL",
		)
		.all() as RunRow[];
	for (const candidate of rows) {
		let row: RunRow;
		try {
			row = current(ctx, db, candidate.id);
		} catch {
			continue;
		}
		let ready = false;
		for (const op of pendingWeb(db, row)) {
			if (op.outcome_json) {
				ready = true;
				continue;
			}
			const result = ctx.web.current(op.external_id);
			if (result.state === "waiting") continue;
			let number = documents(db, row).length;
			const acquired = result.documents.map((doc) => {
				const evidence = `e${++number}`;
				db.query(
					"INSERT INTO pursuit_documents(run_id,epoch,id,url,title,text,fetched_at,truncated) VALUES (?,?,?,?,?,?,?,?)",
				).run(
					row.id,
					row.epoch,
					evidence,
					doc.url,
					doc.title,
					doc.text,
					doc.fetchedAt,
					doc.truncated ? 1 : 0,
				);
				return {
					evidence,
					...doc,
					text: doc.text.slice(0, 12000),
					totalCharacters: doc.text.length,
					truncated: doc.truncated || doc.text.length > 12000,
					trust: "untrusted",
				};
			});
			const outcome: ToolOutcome = {
				status: result.state === "finished" ? "ok" : "error",
				...(result.code ? { errorCode: result.code } : {}),
				output: {
					candidates: result.hits,
					documents: acquired,
					failures: result.failures,
				},
				refs: acquired.map((doc) => ({
					kind: "source",
					uri: doc.url,
					note: doc.evidence,
				})),
			};
			db.query(
				"UPDATE pursuit_web_operations SET outcome_json=? WHERE id=? AND outcome_json IS NULL",
			).run(JSON.stringify(outcome), op.id);
			ready = true;
		}
		if (ready) {
			row.state = "queued";
			ctx.enqueue(db, row);
			save(db, row, stateOf(row), ctx.now());
		}
	}
}
