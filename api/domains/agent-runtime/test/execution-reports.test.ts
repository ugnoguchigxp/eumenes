import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrations } from "../repository";
import { executionReports } from "../service/execution-reports";
import type { ExecutionContext } from "../service/execution-context";

function setup() {
	const db = new Database(":memory:");
	for (const m of migrations) db.exec(m.sql);
	let now = 1_000;
	const reports = executionReports(
		{ now: () => now } as unknown as ExecutionContext,
		() => true,
	);
	const row = (id: string, state: string, conversationId = "c1") =>
		db
			.query(
				"INSERT INTO agent_executions(id,start_key,input_digest,conversation_id,request,state,state_json,deadline,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
			)
			.run(
				id,
				`k-${id}`,
				"d",
				conversationId,
				`依頼 ${id}`,
				state,
				JSON.stringify({ version: 1, question: null }),
				9_999_999,
				state === "completed"
					? JSON.stringify({
							status: "completed",
							summary: "曲ができた",
							fulfilled: [],
							missing: [],
							refs: [],
							code: null,
						})
					: null,
				100,
				200,
			);
	return { db, reports, row, tick: (ms: number) => (now += ms) };
}

test("a held report is listed as a work item until it is released (archived)", () => {
	const { db, reports, row, tick } = setup();
	row("e1", "completed");
	row("e2", "deciding");
	db.query(
		"INSERT INTO agent_execution_events(id,execution_id,kind,state) VALUES('ev1','e1','finished:0','accepted')",
	).run();
	expect(
		reports.holdReportInTransaction(db, {
			eventId: "ev1",
			executionId: "e1",
			conversationId: "c1",
		}),
	).toBe(true);
	// idempotent per event
	reports.holdReportInTransaction(db, {
		eventId: "ev1",
		executionId: "e1",
		conversationId: "c1",
	});
	expect(reports.heldReportsInTransaction(db)).toEqual([
		{ eventId: "ev1", executionId: "e1", conversationId: "c1", heldAt: 1_000 },
	]);
	const items = reports.workItemsInTransaction(db, "c1");
	expect(items.map((i) => [i.id, i.heldEventId, i.resultSummary])).toEqual([
		["e1", "ev1", "曲ができた"],
		["e2", null, null],
	]);
	expect(reports.workItemsInTransaction(db, "c2")).toEqual([]);
	tick(500);
	expect(reports.releaseReportInTransaction(db, "ev1")).toBe(true);
	expect(reports.releaseReportInTransaction(db, "ev1")).toBe(false);
	expect(reports.heldReportsInTransaction(db, "c1")).toEqual([]);
	expect(reports.workItemsInTransaction(db, "c1").map((i) => i.id)).toEqual([
		"e2",
	]);
	expect(
		reports
			.archivedItemsInTransaction(db, "c1")
			.map((i) => [i.id, i.releasedAt]),
	).toEqual([["e1", 1_500]]);
	// settling stops the delivery loop's polling
	reports.settleEventInTransaction(db, "ev1");
	expect(
		db.query("SELECT state FROM agent_execution_events WHERE id='ev1'").get(),
	).toEqual({ state: "delivered" });
});

test("two held events of one execution make one work item", () => {
	const { db, reports, row } = setup();
	row("e1", "completed");
	for (const ev of ["ev1", "ev2"])
		reports.holdReportInTransaction(db, {
			eventId: ev,
			executionId: "e1",
			conversationId: "c1",
		});
	expect(reports.heldReportsInTransaction(db, "c1")).toHaveLength(2);
	expect(reports.workItemsInTransaction(db, "c1").map((i) => i.id)).toEqual([
		"e1",
	]);
});
