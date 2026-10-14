import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usagePageQuerySchema } from "../domains/inference/contracts";
import { createToolchainHistory } from "../domains/toolchain-history";
import { openStore, type SqliteStore } from "../infrastructure/sqlite";
import { migrations } from "./migrations";
import {
	createRecordsAdapter,
	describeRecordsAdapter,
} from "./records-adapter";
import { offlineBundleHost } from "./toolchain-adapters";

let store: SqliteStore | undefined;
let dir = "";
afterEach(async () => {
	await store?.close();
	store = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
});

async function setup() {
	dir = mkdtempSync(join(tmpdir(), "records-adapter-"));
	store = openStore(join(dir, "db"), migrations);
	const history = createToolchainHistory(store, () => 1_000_000);
	const usageQueries: unknown[] = [];
	const adapter = createRecordsAdapter({
		usagePage: (query) => {
			usageQueries.push(query);
			return { ...query, total: 0, items: [] };
		},
		usage: () => [{ id: "attempt" }],
		larm: () => ({ profile: "p" }),
		diagnostics: () => ({ keyError: null, connections: [] }),
		history: () => history,
	});
	await store.write((db) => {
		for (const n of [1, 2, 3])
			history.saveRecipeInTransaction(db, "web.search", {
				signature: `手順-${n}`,
				url: `https://example.com/${n}`,
				readHint: "本文を読む",
			});
	});
	return { store, history, adapter, usageQueries };
}
type Harness = Awaited<ReturnType<typeof setup>>;

function run(
	h: Harness,
	operationName: string,
	input: unknown,
	origin: "ui" | "conversation" = "ui",
) {
	const requestId = crypto.randomUUID();
	return h.store.write((db) =>
		h.adapter.invokeInTransaction(db, {
			operationName,
			input,
			requestId,
			issuedAt: new Date().toISOString(),
			origin:
				origin === "conversation"
					? {
							kind: "conversation",
							owner: {} as never,
							runId: "r",
							conversationId: "c",
							messageId: "m",
						}
					: { kind: "ui", scope: "scope", actionRequestId: requestId },
		}),
	);
}
const codeOf = async (promise: Promise<unknown>) => {
	try {
		await promise;
		return "no_error";
	} catch (error) {
		return (error as Error).message;
	}
};
const read = (h: Harness, query: string, params?: unknown) =>
	h.store.read((db) =>
		h.adapter.sourceInTransaction(db, query, undefined, params),
	);

test("describe offers the records queries, the page read and the two procedure writes", () => {
	const d = describeRecordsAdapter();
	expect([...d.queries].sort()).toEqual([
		"query:records.diagnostics@1",
		"query:records.export@1",
		"query:records.recipes@1",
		"query:records.selections@1",
		"query:records.usage@1",
	]);
	expect(
		Object.fromEntries(
			[...d.operations].map(([name, op]) => [name, op.effect]),
		),
	).toEqual({
		"records.recipe-state": "write",
		"records.recipe-delete": "write",
	});
	expect(d.inputAdapters.size).toBe(0);
	expect(offlineBundleHost().adapters.get("adapter:records@1")).toBeDefined();
});

test("sources give the first page of each table, the diagnostics and the export", async () => {
	const h = await setup();
	const defaults = usagePageQuerySchema.parse({});
	expect(read(h, "query:records.usage@1")!.data).toEqual({
		...defaults,
		total: 0,
		items: [],
	});
	const recipes = read(h, "query:records.recipes@1")!.data as {
		total: number;
		items: Array<{ signature: string }>;
		pageSize: number;
	};
	expect(recipes.total).toBe(3);
	expect(recipes.pageSize).toBe(10);
	expect(
		(read(h, "query:records.selections@1")!.data as { total: number }).total,
	).toBe(0);
	expect(read(h, "query:records.diagnostics@1")!.data).toEqual({
		keyError: null,
		connections: [],
	});
	expect(read(h, "query:records.export@1")!.data).toEqual({
		diagnostics: { keyError: null, connections: [] },
		larm: { profile: "p" },
		usage: [{ id: "attempt" }],
	});
	expect(read(h, "query:records.nothing@1")).toBeNull();
});

test("page sources return the page the parameters ask for, per table", async () => {
	const h = await setup();
	const recipes = read(h, "query:records.recipes@1", {
		pageIndex: 0,
		pageSize: 10,
		sort: "signature",
		desc: false,
		q: "手順-2",
	})!.data as { total: number; items: Array<{ signature: string }> };
	expect(recipes.total).toBe(1);
	expect(recipes.items[0]!.signature).toBe("手順-2");
	read(h, "query:records.usage@1", {
		pageIndex: 2,
		pageSize: 50,
		sort: "model",
		desc: true,
		q: "",
	});
	expect(h.usageQueries.at(-1)).toEqual({
		pageIndex: 2,
		pageSize: 50,
		sort: "model",
		desc: true,
		q: "",
	});
	// A sort of another table or a page size outside the allowed sizes is refused.
	expect(() => read(h, "query:records.usage@1", { sort: "signature" })).toThrow(
		"invalid_input",
	);
	expect(() => read(h, "query:records.recipes@1", { pageSize: 7 })).toThrow(
		"invalid_input",
	);
});

test("a procedure is disabled and enabled through toolchain-history and a missing one is refused", async () => {
	const h = await setup();
	const [first] = h.history.listRecipes("web.search");
	const stateOf = () =>
		h.history.listRecipes("web.search").find((r) => r.id === first!.id)!.state;
	const result = await run(h, "records.recipe-state", {
		id: first!.id,
		enabled: false,
	});
	expect(stateOf()).toBe("disabled");
	expect(result.replay).toBe(false);
	expect(result.resultRefs).toEqual([
		expect.objectContaining({ kind: "recipe", id: first!.id }),
	]);
	await run(h, "records.recipe-state", { id: first!.id, enabled: true });
	expect(stateOf()).toBe("active");
	expect(
		await codeOf(
			run(h, "records.recipe-state", { id: "no-such-recipe", enabled: true }),
		),
	).toBe("recipe_not_found");
});

test("a procedure is deleted once and a second delete is refused", async () => {
	const h = await setup();
	const [first] = h.history.listRecipes("web.search");
	await run(h, "records.recipe-delete", { id: first!.id });
	expect(h.history.listRecipes("web.search")).toHaveLength(2);
	expect(
		h.history.listRecipes("web.search").some((r) => r.id === first!.id),
	).toBe(false);
	expect(await codeOf(run(h, "records.recipe-delete", { id: first!.id }))).toBe(
		"recipe_not_found",
	);
});

test("operations validate their input, and conversations cannot reach them", async () => {
	const h = await setup();
	const [first] = h.history.listRecipes("web.search");
	expect(await codeOf(run(h, "records.recipe-state", { id: first!.id }))).toBe(
		"invalid_input",
	);
	expect(
		await codeOf(run(h, "records.recipe-delete", { id: "../x", extra: 1 })),
	).toBe("invalid_input");
	expect(await codeOf(run(h, "records.unknown", {}))).toBe(
		"capability_unavailable",
	);
	for (const [name, input] of [
		["records.recipe-delete", { id: first!.id }],
		["records.recipe-state", { id: first!.id, enabled: false }],
	] as const)
		expect(await codeOf(run(h, name, input, "conversation"))).toBe(
			"capability_unavailable",
		);
	expect(h.history.listRecipes("web.search")).toHaveLength(3);
});
