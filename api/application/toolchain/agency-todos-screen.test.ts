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
		).toBe("artifact:agency.todos@4");
		const base =
			"/api/toolchain-artifacts/" +
			encodeURIComponent("artifact:agency.todos@4");
		const detail = await (await h.request(base)).json();
		expect(detail.artifact.variants[0].definition).toEqual({
			view: "todo-workspace",
			source: "agency-todos",
			title: "TODOリスト",
		});
		expect(detail.artifact.sourceBindings[0]).toMatchObject({
			adapterRef: "adapter:task-execution@1",
			query: TASK_TODOS_QUERY,
			paramsSchemaRef: "schema:todo-screen-query@4",
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
				counts: { todo: 0, archived: 0 },
				total: 0,
				pageIndex: 0,
			},
		});
		for (const params of [
			{ ...input, state: "other" },
			{ ...input, state: "done" },
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
				state: "active",
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
		const archive = (origin: "ui" | "conversation") =>
			adapter.invokeInTransaction(db, {
				operationName: "todos.archive",
				input: { todoId: "w1" },
				requestId: "x",
				issuedAt: new Date().toISOString(),
				origin:
					origin === "ui"
						? { kind: "ui", scope: "fixture", actionRequestId: "x" }
						: ({ kind: "conversation" } as never),
			});
		// Only the user's act on the screen archives; before dialogue is attached there is no ledger.
		expect(() => archive("conversation")).toThrow("task_lifecycle_required");
		expect(() => archive("ui")).toThrow("work_unavailable");
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
			() => ({
				archiveTodoInTransaction: () => {
					throw new Error("unused");
				},
				flushTodoCancellations: () => {},
				todoPageInTransaction: (_db, conversationId, query) => {
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
						counts: { todo: 3, archived: 1 },
					};
				},
			}),
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
				counts: { todo: 3, archived: 1 },
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

test("the TODO screen's archive stops an open TODO's run and archives it, through the action route", async () => {
	const h = await harness();
	try {
		const now = new Date().toISOString();
		await h.store.write((db) => {
			db.query(
				"INSERT INTO dialogue_work (id, ref, conversation_id, run_id, toolchain_id, toolchain_revision_id, execution, request, title, status, revision, dedupe_key, created_at, updated_at) VALUES ('w1', 1, 'main', 'no-run', 'toolchain', 'toolchain@1', 'agent', '鳥の絵を描く', '鳥の絵を描く', 'todo', 1, 'k1', ?, ?)",
			).run(now, now);
		});
		expect(h.todos()).toHaveLength(1);
		const registration = await (
			await h.request(
				"/api/toolchain-artifacts/" +
					encodeURIComponent("artifact:agency.todos@4"),
			)
		).json();
		const event = (todoId: string) => ({
			version: 1,
			eventId: crypto.randomUUID(),
			eventCreatedAt: new Date().toISOString(),
			eventExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			artifactId: "agency-todos",
			artifactRevisionId: "artifact:agency.todos@4",
			scopeRef: registration.scopeRef,
			source: "agency-todos",
			sourceRevision: 0,
			actionId: "archive",
			input: { todoId },
		});
		const accepted = await h.request("/api/toolchain-actions", event("w1"));
		expect(accepted.status).toBe(200);
		expect((await accepted.json()).status).toBe("accepted");
		expect(h.todos()).toEqual([]);
		const row = h.store.read((db) =>
			db
				.query(
					"SELECT status, outcome, archived_at FROM dialogue_work WHERE id = 'w1'",
				)
				.get(),
		) as { status: string; outcome: string; archived_at: string | null };
		expect(row).toMatchObject({ status: "done", outcome: "cancelled" });
		expect(row.archived_at).not.toBeNull();
		// A TODO that does not exist is refused, and nothing else changes.
		const refused = await (
			await h.request("/api/toolchain-actions", event("no-such-todo"))
		).json();
		expect(refused.status).toBe("rejected");
		expect(h.calls).toBe(0);
	} finally {
		await h.close();
	}
});
