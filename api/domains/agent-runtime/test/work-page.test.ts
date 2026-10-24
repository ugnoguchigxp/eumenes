import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { migrations } from "../repository";
import { executionReports } from "../service/execution-reports";
import { registerAgentRuntime } from "../controller";
import type { AgentRuntime } from "../service";
import type { ExecutionContext } from "../service/execution-context";
import { workQuery } from "../contracts/work-query";

function setup() {
	const db = new Database(":memory:");
	for (const m of migrations) db.exec(m.sql);
	const reports = executionReports(
		{
			now: () => 1000,
			store: { read: (fn: (db: Database) => unknown) => fn(db) },
		} as unknown as ExecutionContext,
		() => true,
	);
	const add = (
		id: string,
		state: "todo" | "done" | "archived",
		conversationId = "c1",
	) => {
		db.query(
			"INSERT INTO agent_executions(id,start_key,input_digest,conversation_id,request,state,state_json,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
		).run(
			id,
			id,
			"d",
			conversationId,
			`依頼 ${id}`,
			state === "todo" ? "deciding" : "completed",
			JSON.stringify({ version: 1, question: null }),
			999999,
			100,
			200,
		);
		if (state !== "todo") {
			reports.holdReportInTransaction(db, {
				eventId: `event-${id}`,
				executionId: id,
				conversationId,
			});
			if (state === "archived")
				reports.releaseReportInTransaction(db, `event-${id}`);
		}
	};
	return { db, reports, add };
}

test("SQL paging reaches every state beyond the old limits, with stable pages and counts", () => {
	const { db, reports, add } = setup();
	try {
		for (const [state, count] of [
			["todo", 12],
			["done", 11],
			["archived", 31],
		] as const) {
			for (let n = 0; n < count; n++)
				add(`${state}-${String(n).padStart(2, "0")}`, state);
		}
		add("other-conversation", "archived", "c2");
		// Multiple reports must not duplicate a row or inflate the count.
		reports.holdReportInTransaction(db, {
			eventId: "extra",
			executionId: "archived-00",
			conversationId: "c1",
		});
		reports.releaseReportInTransaction(db, "extra");
		for (const [state, count] of [
			["todo", 12],
			["done", 11],
			["archived", 31],
		] as const) {
			const ids: string[] = [];
			for (let pageIndex = 0; pageIndex < Math.ceil(count / 10); pageIndex++) {
				const page = reports.agencyWorkPage("c1", {
					state,
					pageIndex,
					pageSize: 10,
				});
				expect(page.counts).toEqual({ todo: 12, done: 11, archived: 31 });
				expect(page.total).toBe(count);
				expect(page.rows.length).toBe(Math.min(10, count - pageIndex * 10));
				ids.push(...page.rows.map((row) => row.id));
			}
			expect(new Set(ids).size).toBe(count);
			expect(ids).not.toContain("other-conversation");
			expect(ids).toEqual([...ids].sort().reverse());
		}
		expect(
			reports.agencyWorkPage("c1", {
				state: "archived",
				pageIndex: 999,
				pageSize: 25,
			}),
		).toMatchObject({ pageIndex: 1, total: 31, rows: expect.any(Array) });
		expect(
			reports.agencyWorkPage("empty", {
				state: "todo",
				pageIndex: 4,
				pageSize: 50,
			}),
		).toMatchObject({
			pageIndex: 0,
			rows: [],
			total: 0,
			counts: { todo: 0, done: 0, archived: 0 },
		});
		// The agency context remains deliberately bounded.
		expect(
			reports
				.workItemsInTransaction(db, "c1")
				.filter((row) => row.heldEventId === null),
		).toHaveLength(8);
	} finally {
		db.close();
	}
});

test("active pages mix todo and done as the same items and preserve identity on transition", () => {
	const { db, reports, add } = setup();
	try {
		for (let n = 0; n < 23; n++)
			add(`item-${String(n).padStart(2, "0")}`, n % 2 ? "done" : "todo");
		add("archived", "archived");
		add("other", "todo", "c2");
		reports.holdReportInTransaction(db, {
			eventId: "duplicate",
			executionId: "item-01",
			conversationId: "c1",
		});
		const ids: string[] = [];
		for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
			const page = reports.agencyWorkPage("c1", {
				state: "active",
				pageIndex,
				pageSize: 10,
			});
			expect(page.total).toBe(23);
			expect(page.rows).toHaveLength(pageIndex === 2 ? 3 : 10);
			expect(new Set(page.rows.map((row) => row.state))).toEqual(
				new Set(["todo", "done"]),
			);
			ids.push(...page.rows.map((row) => row.id));
		}
		expect(ids).toEqual(
			Array.from(
				{ length: 23 },
				(_, n) => `item-${String(22 - n).padStart(2, "0")}`,
			),
		);
		db.query(
			"UPDATE agent_executions SET state='completed' WHERE id='item-22'",
		).run();
		reports.holdReportInTransaction(db, {
			eventId: "finished",
			executionId: "item-22",
			conversationId: "c1",
		});
		const page = reports.agencyWorkPage("c1", {
			state: "active",
			pageIndex: 0,
			pageSize: 10,
		});
		expect(page.total).toBe(23);
		expect(page.rows[0]).toMatchObject({ id: "item-22", state: "done" });
		expect(page.rows.filter((row) => row.id === "item-22")).toHaveLength(1);
	} finally {
		db.close();
	}
});

test("work route precedes /:id, preserves legacy response and rejects invalid pagination", async () => {
	const { db, reports, add } = setup();
	try {
		add("one", "todo");
		const app = new Hono();
		registerAgentRuntime(
			app,
			{ executions: reports } as unknown as AgentRuntime,
			async () => {},
		);
		const response = await app.request(
			"/api/agent-executions/work?conversationId=c1&state=todo&pageSize=10",
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			total: 1,
			state: "todo",
			pageIndex: 0,
			pageSize: 10,
		});
		expect(
			await (
				await app.request("/api/agent-executions/work?conversationId=c1")
			).json(),
		).toMatchObject({
			items: [expect.objectContaining({ id: "one" })],
			archived: [],
		});
		for (const query of [
			"state=other",
			"state=todo&pageIndex=-1",
			"state=todo&pageSize=999",
			"state=done&pageIndex=1.5",
			"state=todo&pageIndex=NaN",
		]) {
			expect(
				(
					await app.request(
						`/api/agent-executions/work?conversationId=c1&${query}`,
					)
				).status,
			).toBe(400);
		}
		expect(
			workQuery.parse({ state: "done", pageIndex: "2", pageSize: "25" }),
		).toEqual({ state: "done", pageIndex: 2, pageSize: 25 });
	} finally {
		db.close();
	}
});
