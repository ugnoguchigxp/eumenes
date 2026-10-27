import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import {
	createTaskAdapter,
	TASK_TODOS_QUERY,
	type LedgerWorkRow,
} from "./task-execution-adapter";
import { todoPageSchema } from "../../domains/agent-runtime/contracts";
import { Database } from "bun:sqlite";

test("TODO launcher and paged source resolve through the registered artifact without model calls or writes", async () => {
	const h = await harness();
	try {
		const entries = (await (await h.request("/api/toolchain-artifacts")).json())
			.artifacts;
		expect(
			entries.filter(
				(entry: { artifactId: string }) => entry.artifactId === "agency.todos",
			),
		).toHaveLength(1);
		expect(
			entries.find(
				(entry: { artifactId: string }) => entry.artifactId === "agency.todos",
			).artifactRevisionId,
		).toBe("artifact:agency.todos@3");
		const base =
			"/api/toolchain-artifacts/" +
			encodeURIComponent("artifact:agency.todos@3");
		const detail = await (await h.request(base)).json();
		expect(detail.artifact.variants[0].definition).toEqual({
			view: "todo-workspace",
			source: "agency-todos",
			title: "TODOリスト",
		});
		expect(detail.artifact.sourceBindings[0]).toMatchObject({
			adapterRef: "adapter:task-execution@1",
			query: TASK_TODOS_QUERY,
			paramsSchemaRef: "schema:todo-screen-query@3",
		});
		const source = base + "/sources/agency-todos";
		const read = (params: unknown, suffix = "") =>
			h.request(
				source +
					"?params=" +
					encodeURIComponent(JSON.stringify(params)) +
					suffix,
			);
		const input = {
			conversationId: "main",
			state: "archived",
			pageIndex: 0,
			pageSize: 20,
		};
		expect((await read({ ...input, state: "active" })).status).toBe(200);
		const response = await read(input);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			revision: 0,
			data: {
				rows: [],
				counts: { todo: 0, done: 0, archived: 0 },
				total: 0,
				pageIndex: 0,
			},
		});
		for (const params of [
			{ ...input, state: "other" },
			{ ...input, pageSize: 1000 },
			{ ...input, pageIndex: -1 },
			{ ...input, conversationId: "" },
			{ ...input, extra: "unregistered" },
		]) {
			expect((await read(params)).status).toBe(400);
		}
		expect((await read(input, "&target=forged")).status).toBe(400);
		expect((await h.request(base + "/sources/unregistered")).status).toBe(404);
		expect(h.calls).toBe(0);
	} finally {
		await h.close();
	}
});

test("a TODO source is unavailable before the runtime is attached", () => {
	const db = new Database(":memory:");
	try {
		const adapter = createTaskAdapter(() => undefined);
		expect(adapter.artifactAvailableInTransaction?.(db)).toBe(false);
		expect(
			adapter.sourceInTransaction(db, TASK_TODOS_QUERY, undefined, {
				conversationId: "main",
				state: "todo",
				pageIndex: 0,
				pageSize: 10,
			}),
		).toBeNull();
		expect(() =>
			adapter.invokeInTransaction(db, {
				operationName: "todo-write",
				input: {},
				requestId: "x",
				issuedAt: new Date().toISOString(),
				origin: { kind: "ui", scope: "fixture", actionRequestId: "x" },
			}),
		).toThrow("task_lifecycle_required");
	} finally {
		db.close();
	}
});

// Longer than any cut the ledger's title or a one-line summary would make: the screen shows them whole.
const LONG_REQUEST = `${"長い依頼".repeat(20)}\n続き`;
const LONG_SUMMARY = "結果の要約".repeat(60);
const ledgerRow = (over: Partial<LedgerWorkRow>): LedgerWorkRow => ({
	id: "w1",
	request: "曲を作る",
	status: "done",
	outcome: "succeeded",
	question: null,
	result: { summary: "3分の曲ができた", body: "RAW-RESULT-BODY" },
	execution: "agent",
	archivedAt: null,
	updatedAt: "2026-10-24T00:00:01.000Z",
	...over,
});

test("the TODO source pages the dialogue ledger and shows the whole request, state, outcome and summary, never the result body", () => {
	const db = new Database(":memory:");
	try {
		const asked: unknown[] = [];
		const adapter = createTaskAdapter(
			() => ({}) as never,
			() => (_db, conversationId, query) => {
				asked.push([conversationId, query]);
				return {
					rows: [
						ledgerRow({}),
						ledgerRow({
							id: "w2",
							request: "確認する",
							status: "waiting",
							outcome: null,
							question: "どの曲調?\n明るい?",
							result: null,
							updatedAt: "2026-10-24T00:00:02.000Z",
						}),
						ledgerRow({
							id: "w3",
							request: LONG_REQUEST,
							execution: "pipeline",
							archivedAt: "2026-10-24T00:00:03.000Z",
							result: { notASummary: true },
						}),
						ledgerRow({
							id: "w4",
							result: { summary: LONG_SUMMARY, body: "RAW-RESULT-BODY" },
						}),
					],
					total: 4,
					pageIndex: 0,
					counts: { todo: 1, done: 2, archived: 1 },
				};
			},
		);
		const read = adapter.sourceInTransaction(db, TASK_TODOS_QUERY, undefined, {
			conversationId: "c1",
			state: "active",
			pageIndex: 4,
			pageSize: 25,
		});
		expect(asked).toEqual([
			["c1", { state: "active", pageIndex: 4, pageSize: 25 }],
		]);
		expect(read).toEqual({
			revision: Date.parse("2026-10-24T00:00:03.000Z"),
			data: {
				rows: [
					{
						id: "w1",
						request: "曲を作る",
						status: "done",
						outcome: "succeeded",
						summary: "3分の曲ができた",
						pipeline: false,
						archived: false,
						updatedAt: "2026-10-24T00:00:01.000Z",
					},
					{
						id: "w2",
						request: "確認する",
						status: "waiting",
						outcome: null,
						summary: "どの曲調? 明るい?",
						pipeline: false,
						archived: false,
						updatedAt: "2026-10-24T00:00:02.000Z",
					},
					{
						id: "w3",
						request: LONG_REQUEST.replace(/\s+/g, " "),
						status: "done",
						outcome: "succeeded",
						summary: null,
						pipeline: true,
						archived: true,
						updatedAt: "2026-10-24T00:00:01.000Z",
					},
					{
						id: "w4",
						request: "曲を作る",
						status: "done",
						outcome: "succeeded",
						summary: LONG_SUMMARY,
						pipeline: false,
						archived: false,
						updatedAt: "2026-10-24T00:00:01.000Z",
					},
				],
				counts: { todo: 1, done: 2, archived: 1 },
				total: 4,
				state: "active",
				pageIndex: 0,
				pageSize: 25,
			},
		});
		expect(JSON.stringify(read)).not.toContain("RAW-RESULT-BODY");
		expect(() =>
			todoPageSchema.parse((read as { data: unknown }).data),
		).not.toThrow();
		// A source with a target, or other parameters, is not served.
		expect(
			adapter.sourceInTransaction(db, TASK_TODOS_QUERY, "target", {}),
		).toBeNull();
		expect(
			adapter.sourceInTransaction(db, TASK_TODOS_QUERY, undefined, {
				conversationId: "c1",
				state: "other",
			}),
		).toBeNull();
	} finally {
		db.close();
	}
});
