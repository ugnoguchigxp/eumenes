import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
	createKanban,
	kanbanReceiptSchema,
	migrations as kanbanMigrations,
	type KanbanBoardView,
} from "../domains/kanban";
import { openStore, type SqliteStore } from "../infrastructure/sqlite";
import {
	createKanbanAdapter,
	describeKanbanAdapter,
	kanbanDomainSchemas,
	KANBAN_ADAPTER_REF,
} from "./kanban-adapter";
import { migrations } from "./migrations";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function setup(runnable = true) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-kanban-adapter-"));
	dirs.push(dir);
	// The app migration list does not include kanban until the host registers it.
	const store = openStore(join(dir, "db"), [
		...migrations,
		...kanbanMigrations.filter(
			(kanban) => !migrations.some((m) => m.id === kanban.id),
		),
	]);
	stores.push(store);
	let seq = 0;
	const kanban = createKanban({
		store,
		id: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
	});
	const state = { runnable };
	const adapter = createKanbanAdapter(kanban, {
		runnable: () => state.runnable,
	});
	return { store, adapter, state };
}

const origin = { kind: "ui" as const, scope: "s", actionRequestId: "a" };
let n = 0;
const invoke = (
	tx: Database,
	adapter: ReturnType<typeof setup>["adapter"],
	operationName: string,
	input: unknown,
	requestId = `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`,
) =>
	adapter.invokeInTransaction(tx, {
		operationName,
		input,
		requestId,
		issuedAt: "2026-10-14T00:00:00.000Z",
		origin,
	});
const board = (
	store: SqliteStore,
	adapter: ReturnType<typeof setup>["adapter"],
) =>
	store.read((tx) =>
		adapter.sourceInTransaction(tx, "query:kanban.board@1", undefined)!,
	);

test("describes the P1 operations, board query, input adapters and projection", () => {
	const described = describeKanbanAdapter();
	expect(described.owner).toBe("kanban");
	expect([...described.operations]).toEqual([
		["kanban.add", { inputSchemaRef: "builtin:kanbanAdd", effect: "write" }],
		["kanban.edit", { inputSchemaRef: "builtin:kanbanEdit", effect: "write" }],
		["kanban.move", { inputSchemaRef: "builtin:kanbanMove", effect: "write" }],
		[
			"kanban.remove",
			{ inputSchemaRef: "builtin:kanbanCardRef", effect: "write" },
		],
	]);
	expect([...described.queries]).toEqual(["query:kanban.board@1"]);
	expect([...described.inputAdapters.keys()].sort()).toEqual([
		"input:kanban.add@1",
		"input:kanban.card@1",
		"input:kanban.edit@1",
		"input:kanban.move@1",
	]);
	expect([...described.projections]).toEqual(["projection:kanban.result@1"]);
	expect(described.availability).toBe("availability:kanban@1");
	expect(Object.keys(kanbanDomainSchemas)).toEqual(["domain:kanban.receipt@1"]);
	expect(KANBAN_ADAPTER_REF).toBe("adapter:kanban@1");
});

test("operations change the board and the board source carries revision and runnable", async () => {
	const { store, adapter, state } = setup();
	expect(board(store, adapter)).toEqual({
		revision: 0,
		data: {
			revision: 0,
			queue: { state: "running", waiting: 0 },
			runnable: true,
			cards: [],
			runs: [],
		},
	});
	const added = await store.write((tx) =>
		invoke(tx, adapter, "kanban.add", { title: "A", prompt: "依頼" }),
	);
	expect(
		kanbanDomainSchemas["domain:kanban.receipt@1"].parse(added.receipt),
	).toEqual(added.receipt as never);
	expect(added).toMatchObject({
		replay: false,
		receipt: { action: "added", revision: 1, title: "A", column: "todo" },
		receiptRef: { owner: "kanban" },
		resultRefs: [
			{ owner: "kanban", kind: "card", schemaRef: "domain:kanban.receipt@1" },
		],
	});
	const cardId = (added.receipt as { cardId: string }).cardId;
	await store.write((tx) =>
		invoke(tx, adapter, "kanban.edit", {
			cardId,
			expectedRevision: 1,
			title: "A2",
		}),
	);
	await store.write((tx) =>
		invoke(tx, adapter, "kanban.move", {
			cardId,
			expectedRevision: 2,
			column: "finished",
			beforeCardId: null,
		}),
	);
	const moved = board(store, adapter);
	const data = moved.data as KanbanBoardView;
	expect(moved.revision).toBe(3);
	expect(data.cards[0]).toMatchObject({
		title: "A2",
		column: "finished",
		label: "done",
		revision: 3,
		actions: ["edit", "remove", "run", "open"],
	});
	state.runnable = false;
	expect((board(store, adapter).data as KanbanBoardView).runnable).toBe(false);
	await store.write((tx) =>
		invoke(tx, adapter, "kanban.remove", { cardId, expectedRevision: 3 }),
	);
	expect((board(store, adapter).data as KanbanBoardView).cards).toEqual([]);
});

test("rejections and a stale revision change nothing; the source is only the untargeted board", async () => {
	const { store, adapter } = setup();
	const added = await store.write((tx) =>
		invoke(tx, adapter, "kanban.add", { title: "A", prompt: "依頼" }),
	);
	const cardId = (added.receipt as { cardId: string }).cardId;
	const before = board(store, adapter);
	await expect(
		store.write((tx) =>
			invoke(tx, adapter, "kanban.edit", {
				cardId,
				expectedRevision: 9,
				title: "X",
			}),
		),
	).rejects.toThrow("revision_conflict");
	await expect(
		store.write((tx) => invoke(tx, adapter, "kanban.add", { title: "" })),
	).rejects.toThrow();
	await expect(
		store.write((tx) => invoke(tx, adapter, "kanban.run", {})),
	).rejects.toThrow("capability_unavailable");
	expect(board(store, adapter)).toEqual(before);
	store.read((tx) => {
		expect(
			adapter.sourceInTransaction(tx, "query:kanban.board@1", "x"),
		).toBeNull();
		expect(
			adapter.sourceInTransaction(tx, "query:other@1", undefined),
		).toBeNull();
	});
});

test("the same request id replays and can be read back", async () => {
	const { store, adapter } = setup();
	const input = { title: "A", prompt: "依頼" };
	const first = await store.write((tx) =>
		invoke(tx, adapter, "kanban.add", input, "req-1"),
	);
	const again = await store.write((tx) =>
		invoke(tx, adapter, "kanban.add", input, "req-1"),
	);
	expect(again.replay).toBe(true);
	expect(again.receipt).toEqual(first.receipt);
	expect(again.receiptRef).toEqual(first.receiptRef);
	const read = store.read((tx) => adapter.readInTransaction(tx, "req-1"));
	expect(read).toMatchObject({ replay: true, receipt: first.receipt });
	expect(kanbanReceiptSchema.parse(read?.receipt)).toEqual(
		first.receipt as never,
	);
	expect(
		store.read((tx) => adapter.readInTransaction(tx, "missing")),
	).toBeNull();
	expect((board(store, adapter).data as KanbanBoardView).cards).toHaveLength(1);
	expect(store.read((tx) => adapter.snapshotInTransaction(tx))).toEqual({
		cards: [
			expect.objectContaining({ title: "A", column: "todo", revision: 1 }),
		],
	});
});

test("input adapters turn the event strings into typed inputs and reject bad values", () => {
	const { inputAdapters } = describeKanbanAdapter();
	const run = (ref: string, raw: Record<string, unknown>) =>
		inputAdapters.get(ref)!(raw);
	const id = "00000000-0000-4000-8000-000000000001";
	expect(run("input:kanban.add@1", { title: "A", prompt: "P" })).toEqual({
		ok: true,
		value: { title: "A", prompt: "P" },
	});
	expect(
		run("input:kanban.edit@1", { cardId: id, expectedRevision: "12" }),
	).toEqual({
		ok: true,
		value: { cardId: id, expectedRevision: 12 },
	});
	expect(
		run("input:kanban.edit@1", {
			cardId: id,
			expectedRevision: "2",
			title: "T",
			prompt: "P",
		}),
	).toEqual({
		ok: true,
		value: { cardId: id, expectedRevision: 2, title: "T", prompt: "P" },
	});
	expect(
		run("input:kanban.move@1", {
			cardId: id,
			expectedRevision: "3",
			column: "finished",
			beforeCardId: "",
		}),
	).toEqual({
		ok: true,
		value: {
			cardId: id,
			expectedRevision: 3,
			column: "finished",
			beforeCardId: null,
		},
	});
	expect(
		run("input:kanban.move@1", {
			cardId: id,
			expectedRevision: "3",
			column: "todo",
			beforeCardId: id,
		}),
	).toMatchObject({ ok: true, value: { beforeCardId: id } });
	expect(
		run("input:kanban.card@1", { cardId: id, expectedRevision: "1" }),
	).toEqual({
		ok: true,
		value: { cardId: id, expectedRevision: 1 },
	});
	expect(
		run("input:kanban.move@1", {
			cardId: "",
			expectedRevision: "0",
			column: "running",
		}),
	).toEqual({
		ok: false,
		errors: [
			{ field: "cardId", message: "カードを指定してください" },
			{ field: "expectedRevision", message: "revision を確認してください" },
			{ field: "column", message: "移動先を確認してください" },
			{ field: "beforeCardId", message: "位置を確認してください" },
		],
	});
	expect(
		run("input:kanban.edit@1", {
			cardId: id,
			expectedRevision: "1",
			title: " ",
		}),
	).toEqual({
		ok: false,
		errors: [{ field: "title", message: "入力してください" }],
	});
	expect(run("input:kanban.add@1", { title: "A" })).toEqual({
		ok: false,
		errors: [{ field: "prompt", message: "入力してください" }],
	});
});
