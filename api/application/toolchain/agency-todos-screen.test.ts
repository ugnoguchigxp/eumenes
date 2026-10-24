import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import { createTaskAdapter, TASK_TODOS_QUERY } from "./task-execution-adapter";
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
		const base =
			"/api/toolchain-artifacts/" +
			encodeURIComponent("artifact:agency.todos@1");
		const detail = await (await h.request(base)).json();
		expect(detail.artifact.variants[0].definition).toEqual({
			view: "todo-workspace",
			source: "agency-todos",
			title: "TODOリスト",
		});
		expect(detail.artifact.sourceBindings[0]).toMatchObject({
			adapterRef: "adapter:task-execution@1",
			query: TASK_TODOS_QUERY,
			paramsSchemaRef: "schema:todo-screen-query@1",
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
			pageIndex: 5,
			pageSize: 10,
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
