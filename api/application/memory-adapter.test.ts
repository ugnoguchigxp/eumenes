import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilities } from "../domains/capabilities";
import { createContinuityService } from "../domains/continuity";
import { createConversationService } from "../domains/conversation";
import { createMemoryService } from "../domains/memory";
import type { AgentRefs } from "../domains/memory";
import {
	createActionRequests,
	createAdapterRegistry,
} from "../domains/tool-runtime";
import { openStore, type SqliteStore } from "../infrastructure/sqlite";
import {
	createMemoryAdapter,
	describeMemoryAdapter,
	MEMORY_ADAPTER_REF,
} from "./memory-adapter";
import { migrations } from "./migrations";
import { bundleHostOf, hostAdapterDescriptions } from "./toolchain-adapters";
import { describeWorldAdapter, WORLD_ADAPTER_REF } from "./world-adapter";

const bundlePath = (name: string) =>
	join(import.meta.dir, `../domains/capabilities/bundles/${name}.bundle.json`);
const memoryBundle = JSON.parse(
	readFileSync(bundlePath("settings-memory"), "utf8"),
);

let store: SqliteStore | undefined;
let dir = "";
afterEach(async () => {
	await store?.close();
	store = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
});

async function setup() {
	dir = mkdtempSync(join(tmpdir(), "memory-adapter-"));
	store = openStore(join(dir, "db"), migrations);
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: join(dir, "memory-forget-journal.jsonl"),
	});
	expect((await memory.recover()).healthy).toBe(true);
	const adapter = createMemoryAdapter({ memory, continuity });
	let messages = 0;
	const say = async (text: string) => {
		const id = `m${++messages}`;
		await conversation.append({
			id,
			conversationId: "main",
			role: "user",
			text,
			createdAt: new Date().toISOString(),
			runId: `run-${id}`,
		});
		return id;
	};
	const remember = async (text: string, semanticKey: string) =>
		memory.remember({
			conversationId: "main",
			messageId: await say(`${text}。`),
			quote: text,
			kind: "preference",
			semanticKey,
			text,
			polarity: "affirmed",
		});
	return { store, conversation, continuity, memory, adapter, say, remember };
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
	)!.data as Record<string, any>;

test("describe offers the memory queries and the seven writes, all for the UI only", async () => {
	const d = describeMemoryAdapter();
	expect([...d.queries].sort()).toEqual([
		"query:memory.context@1",
		"query:memory.item-history@1",
		"query:memory.items@1",
		"query:memory.short-term@1",
		"query:memory.status@1",
		"query:memory.tendencies@1",
	]);
	expect([...d.operations.keys()].sort()).toEqual([
		"memory.continuity-transition",
		"memory.delete-tendency",
		"memory.forget",
		"memory.resume",
		"memory.retract",
		"memory.set-enabled",
		"memory.stop",
	]);
	const h = await setup();
	expect(h.adapter.ref).toBe(MEMORY_ADAPTER_REF);
	expect(h.adapter.availableInTransaction(h.store.read((db) => db))).toBe(true);
	for (const name of d.operations.keys())
		expect(await codeOf(run(h, name, {}, "conversation"))).toBe(
			"capability_unavailable",
		);
	expect(await codeOf(run(h, "memory.nothing", {}))).toBe(
		"capability_unavailable",
	);
});

test("the shipped memory bundle registers against this adapter plus the existing ones with no issue", async () => {
	const h = await setup();
	const host = bundleHostOf([
		...hostAdapterDescriptions,
		{ ref: MEMORY_ADAPTER_REF, describe: describeMemoryAdapter },
		{ ref: WORLD_ADAPTER_REF, describe: describeWorldAdapter },
	]);
	const caps = createCapabilities(h.store, new Set(), {
		bundleHost: () => host,
	});
	const result = await h.store.write((db) =>
		caps.importBundleInTransaction(db, memoryBundle, host, { dryRun: true }),
	);
	expect(result.issues).toEqual([]);
	const artifact = memoryBundle.artifacts[0];
	expect(artifact.launcher).toMatchObject({
		label: "記憶",
		group: "管理と確認",
	});
	// Every action the collections offer names an operation this adapter registers.
	const operations = describeMemoryAdapter().operations;
	for (const action of artifact.actionBindings)
		expect(operations.get(action.operationId)?.inputSchemaRef).toBe(
			action.inputSchemaRef,
		);
});

test("status shows the connection and the switch needs a healthy memory to turn on", async () => {
	const h = await setup();
	// Memory starts connected; the screen offers the disconnect and not the connect.
	expect(read(h, "query:memory.status@1").items[0]).toMatchObject({
		id: "memory",
		enabled: true,
		healthy: true,
		state: "接続中",
		canConnect: false,
	});
	await run(h, "memory.set-enabled", { enabled: false });
	expect(read(h, "query:memory.status@1").items[0]).toMatchObject({
		enabled: false,
		state: "非接続",
		canConnect: true,
	});
	const on = await run(h, "memory.set-enabled", { enabled: true });
	expect(on.receipt).toMatchObject({ kind: "memory-enabled", enabled: true });
	expect(read(h, "query:memory.status@1").items[0]).toMatchObject({
		enabled: true,
		state: "接続中",
		canConnect: false,
	});
	expect(h.memory.status().enabled).toBe(true);
	expect(await codeOf(run(h, "memory.set-enabled", { enabled: "yes" }))).toBe(
		"invalid_input",
	);
	expect(await codeOf(run(h, "memory.set-enabled", {}))).toBe("invalid_input");
});

test("items page, search and sort; stop, resume and retract carry the revision the person saw", async () => {
	const h = await setup();
	const coffee = await h.remember("コーヒーが好き", "drink.coffee");
	const run1 = await h.remember("毎朝走る", "habit.run");
	const items = read(h, "query:memory.items@1");
	expect(items.total).toBe(2);
	expect(
		items.items.find((i: { id: string }) => i.id === coffee.id),
	).toMatchObject({
		id: coffee.id,
		revision: coffee.revision,
		kindLabel: "好み",
		text: "コーヒーが好き",
		status: "active",
		statusLabel: "利用中",
		quote: "「コーヒーが好き」",
	});
	expect(
		read(h, "query:memory.items@1", { q: "走る", pageSize: 10 }).items.map(
			(i: { id: string }) => i.id,
		),
	).toEqual([run1.id]);
	const sorted = read(h, "query:memory.items@1", {
		sort: "text",
		desc: true,
		pageSize: 10,
	});
	expect(sorted.items).toHaveLength(2);
	expect(
		read(h, "query:memory.items@1", { pageIndex: 1, pageSize: 10 }).items,
	).toEqual([]);
	expect(() => read(h, "query:memory.items@1", { pageSize: 7 })).toThrow(
		"invalid_input",
	);

	const stop = await run(h, "memory.stop", {
		id: coffee.id,
		expectedRevision: coffee.revision,
	});
	expect(stop.receipt).toMatchObject({ action: "stop", status: "inactive" });
	expect(
		read(h, "query:memory.items@1").items.map(
			(i: { id: string; status: string }) => [i.id, i.status],
		),
	).toContainEqual([coffee.id, "inactive"]);
	// A stale draft of the row is a conflict, and the item is unchanged.
	expect(
		await codeOf(
			run(h, "memory.resume", {
				id: coffee.id,
				expectedRevision: coffee.revision,
			}),
		),
	).toBe("revision_conflict");
	const stopped = (
		read(h, "query:memory.items@1").items as Array<{
			id: string;
			revision: number;
		}>
	).find((i) => i.id === coffee.id)!;
	await run(h, "memory.resume", {
		id: coffee.id,
		expectedRevision: stopped.revision,
	});
	const resumed = (
		read(h, "query:memory.items@1").items as Array<{
			id: string;
			revision: number;
			status: string;
		}>
	).find((i) => i.id === coffee.id)!;
	expect(resumed.status).toBe("active");
	await run(h, "memory.retract", {
		id: coffee.id,
		expectedRevision: resumed.revision,
	});
	// A retracted item leaves the current list and shows in the history, where it can still be forgotten.
	expect(
		read(h, "query:memory.items@1").items.map((i: { id: string }) => i.id),
	).toEqual([run1.id]);
	expect(
		read(h, "query:memory.item-history@1").items.map(
			(i: { id: string; statusLabel: string }) => [i.id, i.statusLabel],
		),
	).toEqual([[coffee.id, "撤回済み"]]);
	expect(
		await codeOf(
			run(h, "memory.stop", { id: "state:nothing", expectedRevision: 1 }),
		),
	).toBe("invalid_memory_item");
});

test("forget removes an item for good and says when it is not complete", async () => {
	const h = await setup();
	const item = await h.remember("コーヒーが好き", "drink.coffee");
	const forgotten = await run(h, "memory.forget", { id: item.id });
	expect(forgotten.receipt).toMatchObject({
		kind: "memory-forget",
		id: item.id,
		status: "completed",
		completed: true,
	});
	expect(read(h, "query:memory.items@1").total).toBe(0);
	expect(read(h, "query:memory.item-history@1").total).toBe(0);
	expect(await codeOf(run(h, "memory.forget", { id: item.id }))).toBe(
		"invalid_memory_item",
	);
	expect(await codeOf(run(h, "memory.forget", { id: "x" }))).toBe(
		"invalid_memory_item",
	);
});

test("a forget whose transaction rolls back is reconciled from the journal, not forgotten about", async () => {
	const h = await setup();
	const item = await h.remember("コーヒーが好き", "drink.coffee");
	// The action's own transaction fails after the entry reached the journal.
	const failing = h.store.write((db) => {
		h.memory.forgetInTransaction(db, item.id);
		throw new Error("outer_failure");
	});
	expect(await codeOf(failing)).toBe("outer_failure");
	// The journal carries the forget to completion once the writer queue reaches the reconcile.
	await h.store.write(() => undefined);
	expect(h.memory.status().healthy).toBe(true);
	expect(h.memory.list(true)).toEqual([]);
	// A refusal inside the transaction (a bad id) journals nothing and leaves memory open.
	await h.remember("毎朝走る", "habit.run");
	expect(await codeOf(run(h, "memory.forget", { id: "state:nothing" }))).toBe(
		"invalid_memory_item",
	);
	expect(h.memory.status().healthy).toBe(true);
	expect(h.memory.list(true)).toHaveLength(1);
});

test("tendencies, short-term notes and the context are read; notes and tendencies change with their revision", async () => {
	const h = await setup();
	const a = await h.remember("コーヒーが好き", "drink.coffee");
	const b = await h.remember("毎朝走る", "habit.run");
	const refs: AgentRefs = {
		m1: { namespace: "state", id: a.id, revision: a.revision },
		m2: { namespace: "state", id: b.id, revision: b.revision },
	};
	await h.store.write((db) =>
		h.memory.applyAgentOpInTransaction(
			db,
			{ conversationId: "main", refs, turns: [] },
			{ type: "tendency_add", text: "朝型", evidenceRefs: ["m1", "m2"] },
		),
	);
	const tendencies = read(h, "query:memory.tendencies@1").items;
	expect(tendencies).toMatchObject([{ text: "朝型", revision: 1 }]);
	await run(h, "memory.delete-tendency", { id: tendencies[0].id });
	expect(read(h, "query:memory.tendencies@1").items).toEqual([]);
	expect(
		await codeOf(run(h, "memory.delete-tendency", { id: tendencies[0].id })),
	).toBe("invalid_memory_item");

	const note = await h.continuity.add("main", {
		kind: "goal",
		text: "旅行の計画",
	});
	const notes = read(h, "query:memory.short-term@1").items;
	expect(notes).toMatchObject([
		{ id: note.id, revision: 1, kindLabel: "目的", text: "旅行の計画" },
	]);
	expect(
		await codeOf(
			run(h, "memory.continuity-transition", {
				id: note.id,
				expectedRevision: 5,
				status: "resolved",
			}),
		),
	).toBe("revision_conflict");
	const closed = await run(h, "memory.continuity-transition", {
		id: note.id,
		expectedRevision: 1,
		status: "resolved",
	});
	expect(closed.receipt).toMatchObject({
		kind: "memory-note",
		status: "resolved",
	});
	expect(read(h, "query:memory.short-term@1").items).toEqual([]);

	// No window has been built yet; once a run reads it, the screen shows that build.
	await run(h, "memory.set-enabled", { enabled: false });
	expect(read(h, "query:memory.context@1").items[0].state).toContain(
		"メモリーを利用していない",
	);
	await run(h, "memory.set-enabled", { enabled: true });
	const empty = read(h, "query:memory.context@1").items[0];
	expect(empty.state).toContain("まだ組み立てていません");
	expect(empty.state).toContain("次のターン");
	expect(empty.longTermText).toBeUndefined();
	const window = await h.store.write((db) =>
		h.memory.windowForRunInTransaction(db, "main"),
	);
	const built = read(h, "query:memory.context@1").items[0];
	expect(built).toMatchObject({ version: 1, pendingAdditions: 0 });
	expect(built.state).toContain("組み立て済み");
	// The rendered texts are shown (bounded), an empty layer says so.
	expect(built.longTermText).toBe(
		window!.longTerm.text === "" ? "（空）" : window!.longTerm.text,
	);
	expect(built.longTermText).toContain("コーヒーが好き");
	expect(built.shortTermText.length).toBeGreaterThan(0);
});

test("the memory bundle runs through the action ledger: a stale row is a conflict, forget is confirmed", async () => {
	const h = await setup();
	const registry = createAdapterRegistry([h.adapter]);
	const host = bundleHostOf(registry);
	const caps = createCapabilities(h.store, new Set(), {
		bundleHost: () => host,
	});
	const imported = await h.store.write((db) =>
		caps.importBundleInTransaction(db, memoryBundle, host),
	);
	expect(imported.issues).toEqual([]);
	const ledger = createActionRequests({
		store: h.store,
		capabilities: caps,
		registry,
		scope: "test-scope",
	});
	const revisionId = "artifact:settings.memory@2";
	expect(ledger.artifacts().map((a) => a.artifactRevisionId)).toContain(
		revisionId,
	);
	const item = await h.remember("コーヒーが好き", "drink.coffee");
	const rows = ledger.source(revisionId, "memory-items");
	const send = (actionId: string, source: string, input: unknown) => {
		const now = Date.now();
		return ledger.submit({
			version: 1,
			eventId: crypto.randomUUID(),
			eventCreatedAt: new Date(now).toISOString(),
			eventExpiresAt: new Date(now + 60_000).toISOString(),
			artifactId: "tab-1",
			artifactRevisionId: revisionId,
			source,
			sourceRevision: rows.revision,
			actionId,
			scopeRef: ledger.scopeRef,
			input,
		});
	};
	const stopped = await send("item-stop", "memory-items", {
		id: item.id,
		expectedRevision: item.revision,
	});
	expect(stopped.request.status).toBe("accepted");
	expect(stopped.request.result?.receipt).toBeUndefined();
	const stale = await send("item-resume", "memory-items", {
		id: item.id,
		expectedRevision: item.revision,
	});
	expect(stale.request).toMatchObject({
		status: "rejected",
		errorCode: "revision_conflict",
	});
	const forgot = await send("item-forget", "memory-items", { id: item.id });
	expect(forgot.request.status).toBe("accepted");
	expect(h.memory.list(true)).toEqual([]);
	// An input that is not the registered one never reaches the domain.
	await expect(
		send("item-stop", "memory-items", { id: item.id }),
	).rejects.toMatchObject({ code: "invalid_input" });
});
