import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilities } from "../../domains/capabilities";
import { createContinuityService } from "../../domains/continuity";
import { createConversationService } from "../../domains/conversation";
import { createMemoryService, profileItemFields } from "../../domains/memory";
import type { DecisionDto } from "../../domains/steward";
import {
	createActionRequests,
	createAdapterRegistry,
} from "../../domains/tool-runtime";
import { openStore, type SqliteStore } from "../../infrastructure/sqlite";
import { referenceJson } from "../../infrastructure/reference-json";
import {
	createMemoryAdapter,
	describeMemoryAdapter,
	MEMORY_ADAPTER_REF,
} from "./memory-adapter";
import { migrations } from "../migrations";
import {
	bundleHostOf,
	hostAdapterDescriptions,
} from "../toolchain/toolchain-adapters";
import { describeWorldAdapter, WORLD_ADAPTER_REF } from "./world-adapter";

const bundlePath = (name: string) =>
	join(
		import.meta.dir,
		`../../domains/capabilities/bundles/${name}.bundle.json`,
	);
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
	const adapter = createMemoryAdapter({ memory });
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
	const remember = async (text: string, semanticKey: string) => {
		const messageId = await say(`${text}。`);
		const [result] = await store!.write((db) =>
			memory.applyCurationInTransaction(db, {
				conversationId: "main",
				items: [
					{
						op: "remember",
						kind: "preference",
						key: semanticKey,
						text,
						messageId,
						quote: text,
						explicit: true,
					},
				],
			}),
		);
		if (result?.status !== "applied") throw new Error("remember_rejected");
		return memory.list(true).find((item) => item.id === result.id)!;
	};
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

test("describe offers the memory queries and the one write (the connection switch), for the UI only", async () => {
	const d = describeMemoryAdapter();
	expect([...d.queries].sort()).toEqual([
		"query:memory.context@1",
		"query:memory.item-history@1",
		"query:memory.items@1",
		"query:memory.short-term@1",
		"query:memory.status@1",
		"query:memory.steward-decisions@1",
		"query:memory.steward-events@1",
		"query:memory.tendencies@1",
	]);
	expect([...d.operations.keys()]).toEqual(["memory.set-enabled"]);
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

test("items page, search and sort; memory content cannot be changed by hand", async () => {
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
	// Every manual change is gone: the adapter does not know them.
	for (const name of [
		"memory.stop",
		"memory.resume",
		"memory.retract",
		"memory.forget",
		"memory.delete-tendency",
		"memory.continuity-transition",
	])
		expect(
			await codeOf(run(h, name, { id: coffee.id, expectedRevision: 1 })),
		).toBe("capability_unavailable");
	expect(read(h, "query:memory.items@1").total).toBe(2);
	// A stopped item (the steward's decision) moves from the current list to the history.
	await h.store.write((db) =>
		h.memory.applyCurationInTransaction(db, {
			conversationId: "main",
			items: [{ op: "stop", itemId: coffee.id, revision: coffee.revision }],
		}),
	);
	expect(
		read(h, "query:memory.items@1").items.map(
			(i: { id: string; status: string }) => [i.id, i.status],
		),
	).toContainEqual([coffee.id, "inactive"]);
});

test("tendencies, short-term notes and the context are read", async () => {
	const h = await setup();
	const a = await h.remember("コーヒーが好き", "drink.coffee");
	const b = await h.remember("毎朝走る", "habit.run");
	await h.store.write((db) =>
		h.memory.applyCurationInTransaction(db, {
			conversationId: "main",
			items: [
				{
					op: "tendency_add",
					text: "朝型",
					evidence: [
						{ namespace: "state", id: a.id },
						{ namespace: "state", id: b.id },
					],
				},
			],
		}),
	);
	const tendencies = read(h, "query:memory.tendencies@1").items;
	expect(tendencies).toMatchObject([{ text: "朝型", revision: 1 }]);

	const noteSource = await h.say("旅行に行きたい。");
	const [added] = await h.store.write((db) =>
		h.memory.applyCurationInTransaction(db, {
			conversationId: "main",
			items: [
				{
					op: "note_add",
					kind: "goal",
					text: "旅行の計画",
					messageIds: [noteSource],
				},
			],
		}),
	);
	if (added?.status !== "applied") throw new Error("note_rejected");
	const notes = read(h, "query:memory.short-term@1").items;
	expect(notes).toMatchObject([
		{ id: added.id, revision: 1, kindLabel: "目的", text: "旅行の計画" },
	]);

	// No window has been built yet; once a run reads it, the screen shows that build.
	await run(h, "memory.set-enabled", { enabled: false });
	expect(read(h, "query:memory.context@1").items[0].state).toContain(
		"メモリーを利用していない",
	);
	await run(h, "memory.set-enabled", { enabled: true });
	const empty = read(h, "query:memory.context@1").items[0];
	expect(empty.state).toContain("まだ組み立てていません");
	expect(empty.state).toContain("次の生成");
	expect(empty.profileText).toBeUndefined();
	const window = await h.store.write((db) =>
		h.memory.windowForRunInTransaction(db, "main"),
	);
	const built = read(h, "query:memory.context@1").items[0];
	expect(built).toMatchObject({ version: 1, newMemories: 0 });
	expect(built.state).toContain("組み立て済み");
	// The published profile is shown (bounded) with its size; the short-term notes are not part of it.
	expect(built.profileText).toBe(
		window!.profile.items.length === 0
			? "（空）"
			: referenceJson(window!.profile.items.map(profileItemFields)),
	);
	expect(built.profileText).toContain("コーヒーが好き");
	expect(built.profileText).not.toContain("旅行の計画");
	expect(built.profile).toBe(`約 ${window!.profile.tokens} token`);
});

test("the steward timeline shows decisions with their proposal, result and window change, and the event log", async () => {
	const h = await setup();
	const decision = (
		over: Partial<DecisionDto> & Pick<DecisionDto, "id" | "step">,
	): DecisionDto => ({
		conversationId: "main",
		jobId: `job-${over.id}`,
		createdAt: "2026-10-14T01:02:03.000Z",
		output: null,
		results: null,
		windowVersionBefore: null,
		windowVersionAfter: null,
		durationMs: null,
		outputTokens: null,
		errorCode: null,
		...over,
	});
	const decisions: DecisionDto[] = [
		decision({
			id: 2,
			step: "curate-memory",
			output: { remember: [{}, {}], stop: [], notes: [{}] },
			results: [
				{ section: "remember", status: "applied" },
				{ section: "remember", status: "rejected", code: "blocked_source" },
				{ section: "notes", status: "applied" },
			],
			windowVersionBefore: 3,
			windowVersionAfter: 4,
			durationMs: 1500,
			outputTokens: 120,
		}),
		decision({
			id: 1,
			step: "summarize",
			output: { summary: "旅行の相談" },
			results: [{ status: "applied", from: 1, to: 4, count: 4 }],
			windowVersionBefore: null,
			windowVersionAfter: 1,
		}),
		decision({ id: 0, step: "refine-summary", errorCode: "stale_window" }),
	];
	const seen: Array<[string, number | undefined]> = [];
	const adapter = createMemoryAdapter({
		memory: h.memory,
		steward: {
			decisions: (conversationId, limit) => {
				seen.push([conversationId, limit]);
				return decisions;
			},
			events: (conversationId) =>
				h.store.read((db) =>
					h.continuity.events.logInTransaction(db, conversationId),
				),
		},
	});
	const readWith = (query: string) =>
		h.store.read((db) =>
			adapter.sourceInTransaction(db, query, undefined, undefined),
		)!.data as Record<string, any>;
	const rows = readWith("query:memory.steward-decisions@1").items;
	expect(seen).toEqual([["main", 50]]);
	expect(rows.map((r: { id: string }) => r.id)).toEqual(["2", "1", "0"]);
	expect(rows[0]).toMatchObject({
		stepLabel: "記憶の判断",
		proposal: "remember 2件 / notes 1件",
		result: "適用 2件 / 却下 1件（blocked_source）",
		windowDiff: "版 3 → 4",
		cost: "1.5秒 / 120 tokens",
	});
	expect(rows[1]).toMatchObject({
		stepLabel: "経緯の要約の準備",
		proposal: "summary: 旅行の相談",
		windowDiff: "版 1",
	});
	expect(rows[2]).toMatchObject({
		stepLabel: "経緯の要約の統合",
		result: "採用せず（stale_window）",
		windowDiff: "変更なし",
	});

	const input = await h.say("旅行に行きたい");
	await h.store.write((db) => {
		h.continuity.events.appendInTransaction(db, {
			conversationId: "main",
			at: "2026-10-14T01:00:00.000Z",
			type: "said",
			by: "user",
			fields: { text: "旅行に行きたい" },
			messageIds: [input],
		});
		h.continuity.events.appendInTransaction(db, {
			conversationId: "main",
			at: "2026-10-14T01:00:05.000Z",
			type: "delivered",
			by: "host",
			fields: { ref: "e1", heard: "full" },
		});
		h.continuity.events.markCuratedInTransaction(db, "main", [1]);
	});
	// Newest first: time, type, by, a short text and whether the steward has read it.
	expect(readWith("query:memory.steward-events@1").items).toMatchObject([
		{
			id: "e2",
			typeLabel: "配信結果",
			byLabel: "ホスト",
			text: "ref: e1 / heard: full",
			curatedLabel: "反映待ち",
		},
		{
			id: "e1",
			typeLabel: "発言",
			byLabel: "利用者",
			text: "旅行に行きたい",
			curatedLabel: "反映済み",
		},
	]);
	// A forgotten event shows only that it existed.
	await h.store.write((db) =>
		h.continuity.events.forgetMessagesInTransaction(
			db,
			[input],
			"2026-10-14T02:00:00.000Z",
		),
	);
	expect(
		readWith("query:memory.steward-events@1").items.map(
			(row: { text: string }) => row.text,
		),
	).toEqual(["ref: e1 / heard: full", "忘却により本文を消去しました"]);
	// Without a steward the timeline is empty, not an error.
	expect(read(h, "query:memory.steward-decisions@1").items).toEqual([]);
});

test("the memory bundle runs through the action ledger: only the connection switch is offered", async () => {
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
	const revisionId = "artifact:settings.memory@5";
	expect(ledger.artifacts().map((a) => a.artifactRevisionId)).toContain(
		revisionId,
	);
	const artifact = memoryBundle.artifacts[0];
	expect(
		artifact.actionBindings.map((a: { actionId: string }) => a.actionId),
	).toEqual(["connect", "disconnect"]);
	const item = await h.remember("コーヒーが好き", "drink.coffee");
	const status = ledger.source(revisionId, "memory-status");
	const send = (actionId: string, input: unknown) => {
		const now = Date.now();
		return ledger.submit({
			version: 1,
			eventId: crypto.randomUUID(),
			eventCreatedAt: new Date(now).toISOString(),
			eventExpiresAt: new Date(now + 60_000).toISOString(),
			artifactId: "tab-1",
			artifactRevisionId: revisionId,
			source: "memory-status",
			sourceRevision: status.revision,
			actionId,
			scopeRef: ledger.scopeRef,
			input,
		});
	};
	const off = await send("disconnect", { enabled: false });
	expect(off.request.status).toBe("accepted");
	expect(h.memory.status().enabled).toBe(false);
	// The item actions of the earlier revision do not exist any more.
	await expect(send("item-stop", { id: item.id })).rejects.toBeDefined();
	expect(h.memory.list(true)).toHaveLength(1);
});
