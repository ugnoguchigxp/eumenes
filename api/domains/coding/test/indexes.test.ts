import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { executionStates } from "../../../../packages/coding-runner/src/contracts";
import { LIVE_STATES } from "../repository";
import { migrations as hostMigrations } from "../../../application/migrations";

let store: SqliteStore | undefined;
let dir = "";
afterEach(() => {
	void store?.close();
	store = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
});

function plan(sql: string): string {
	if (!store) {
		dir = mkdtempSync(join(tmpdir(), "coding-indexes-"));
		store = openStore(join(dir, "test.sqlite"), hostMigrations);
	}
	return store.read((db) =>
		(db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
			.map((r) => r.detail)
			.join("\n"),
	);
}

test("receipt update by execution uses coding_operations_execution", () => {
	expect(
		plan("UPDATE coding_operations SET state='x' WHERE execution_id='e'"),
	).toContain("USING INDEX coding_operations_execution");
});

test("live() query uses coding_executions_state", () => {
	expect(
		plan(
			`SELECT * FROM coding_executions WHERE state IN (${LIVE_STATES.map((s) => `'${s}'`).join(",")})`,
		),
	).toContain("USING INDEX coding_executions_state");
});

test("LIVE_STATES lists every non-terminal state", () => {
	const terminal = ["stopped", "exited"];
	const expected = new Set<string>([
		"intent",
		"accepted",
		...executionStates.filter((s) => !terminal.includes(s)),
	]);
	expect(new Set<string>(LIVE_STATES)).toEqual(expected);
});

test("countEvents uses coding_evidence_kind", () => {
	expect(
		plan(
			"SELECT COUNT(*) AS n FROM coding_evidence WHERE execution_id='e' AND json_extract(data_json,'$.kind')='k'",
		),
	).toContain("USING COVERING INDEX coding_evidence_kind");
});

test("supervision trim and purge use their task indexes", () => {
	expect(
		plan(
			"DELETE FROM coding_observations WHERE task_id='t' AND id NOT IN (SELECT id FROM coding_observations WHERE task_id='t' ORDER BY created_ms DESC,rowid DESC LIMIT 128)",
		),
	).toContain("coding_observations_task_created");
	expect(plan("DELETE FROM coding_decisions WHERE task_id='t'")).toContain(
		"coding_decisions_task",
	);
	expect(plan("DELETE FROM coding_steps WHERE task_id='t'")).toContain(
		"coding_steps_task",
	);
});
