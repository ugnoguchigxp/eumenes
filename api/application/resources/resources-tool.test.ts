import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createContinuityService,
	eventsMigration,
	itemSourceMigration,
	migration,
	shortTermMigration,
} from "../../domains/continuity";
import type {
	ConversationResource,
	ConversationResourcePort,
} from "../../domains/dialogue";
import {
	createResourceRegistry,
	formatResourceUri,
	type ResourceAdapter,
	type ResourceKind,
	type ResourceRef,
} from "../../domains/resources";
import {
	createScreen,
	migrations as screenMigrations,
} from "../../domains/screen";
import { openStore } from "../../infrastructure/sqlite";
import type { InstantResult } from "../../domains/tool-runtime";
import {
	createResourcesToolAdapter,
	type InstantContext,
	RESOURCES_ANSWER_MAX_CHARS,
	RESOURCES_OPERATION,
} from "./resources-tool";
import { screenSettledEventInTransaction } from "./screen-events";

const signal = new AbortController().signal;
const NOW = Date.parse("2026-10-25T03:00:00.000Z");

const kinds: ResourceKind[] = [
	{
		kind: "image",
		label: "画像",
		owner: "image",
		actions: ["open", "read"],
		defaultAction: "open",
		actionLabels: { open: "表示する", read: "内容を伝える" },
	},
	{
		kind: "music.track",
		label: "曲",
		owner: "music",
		actions: ["open", "play", "read"],
		defaultAction: "play",
		actionLabels: { play: "再生する" },
	},
	{
		kind: "report",
		label: "調査報告",
		owner: "web-research",
		actions: ["open", "read"],
		defaultAction: "read",
		actionLabels: { read: "内容を伝える" },
	},
];

type Item = { id: string; label: string; createdAt: string; text: string };
const items: Record<string, Item[]> = {
	image: [
		{
			id: "i1",
			label: "決戦前の二人",
			createdAt: "2026-10-20T10:00:00+09:00",
			text: "画像の説明",
		},
	],
	"music.track": [
		{
			id: "t1",
			label: "日曜日の午後",
			createdAt: "2026-10-24T10:00:00+09:00",
			text: "曲の説明",
		},
	],
	report: [
		{
			id: "r1",
			label: "エージェント設計の講演",
			createdAt: "2026-10-21T10:00:00+09:00",
			text: "長い".repeat(2000),
		},
	],
};

function fakeAdapter(kind: string, prepared: string[]): ResourceAdapter {
	const ref = (item: Item): ResourceRef => ({
		uri: formatResourceUri(kind, item.id),
		kind,
		label: item.label,
		createdAt: item.createdAt,
	});
	const label = kinds.find((k) => k.kind === kind)!;
	return {
		kind,
		fromResultInTransaction: () => [],
		getInTransaction: (_db, id) => {
			const item = items[kind]!.find((i) => i.id === id);
			return item
				? {
						...ref(item),
						adapterRef: `adapter:${kind}`,
						targetRef: `target-${item.id}`,
						actions: label.actions,
					}
				: null;
		},
		search: async (query) =>
			items[kind]!.filter(
				(i) =>
					i.label.includes(query.text) &&
					(!query.since ||
						Date.parse(i.createdAt) >= Date.parse(query.since)) &&
					(!query.until || Date.parse(i.createdAt) <= Date.parse(query.until)),
			).map(ref),
		read: async (id) => ({ text: items[kind]!.find((i) => i.id === id)!.text }),
		prepareInTransaction: (_db, id, action) => {
			prepared.push(`${kind}:${id}:${action}`);
			return {
				adapterRef: `adapter:${kind}:prepared`,
				targetRef: `list-${id}`,
			};
		},
	};
}

/** The conversation's ledger as a map: the contract the dialogue domain implements. */
function fakeLedger() {
	const rows: ConversationResource[] = [];
	const touched: string[] = [];
	const port: ConversationResourcePort = {
		enterInTransaction: (_db, input) => {
			let row = rows.find(
				(r) => r.conversationId === input.conversationId && r.uri === input.uri,
			);
			if (!row) {
				row = {
					id: `res${rows.length + 1}`,
					conversationId: input.conversationId,
					ref:
						rows.filter((r) => r.conversationId === input.conversationId)
							.length + 1,
					uri: input.uri,
					kind: input.kind,
					label: input.label,
					source: input.source,
					workId: input.workId ?? null,
					usedAt: "x",
					createdAt: "x",
					forgottenAt: null,
				};
				rows.push(row);
			}
			return row;
		},
		byRefInTransaction: (_db, conversationId, ref) =>
			rows.find(
				(r) =>
					r.conversationId === conversationId &&
					`a${r.ref}` === ref &&
					!r.forgottenAt,
			) ?? null,
		touchInTransaction: (_db, id) => {
			touched.push(id);
		},
		linkMessageInTransaction: () => {},
	};
	return { port, rows, touched };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const clean of cleanups.splice(0)) await clean();
});

function harness() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-resources-tool-"));
	const store = openStore(join(dir, "db.sqlite3"), [
		migration,
		shortTermMigration,
		itemSourceMigration,
		eventsMigration,
		{ id: "conversation/0001-init", sql: "SELECT 1" },
		...screenMigrations,
	]);
	cleanups.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const prepared: string[] = [];
	const registry = createResourceRegistry({
		kinds: () => kinds,
		adapters: kinds.map((k) => fakeAdapter(k.kind, prepared)),
	});
	const events = createContinuityService(store).events;
	const ledger = fakeLedger();
	let settle: ((db: Database, command: never) => void) | undefined;
	const screen = createScreen({
		store,
		now: () => NOW,
		onSettled: (db, command) => settle?.(db, command as never),
	});
	settle = (db, command) =>
		screenSettledEventInTransaction(
			{ events, ledger: ledger.port, registry },
			db,
			command,
		);
	const adapter = createResourcesToolAdapter({
		registry,
		ledger: ledger.port,
		screen,
		store,
		now: () => NOW,
	});
	const context = { conversationId: "main" };
	const run = async (input: unknown, ctx: typeof context | null = context) => {
		// The host passes the conversation as a fourth argument (the adapter contract is extended for it).
		const result = await (
			adapter.instant!.run as (
				...args: [string, unknown, AbortSignal, InstantContext?]
			) => Promise<InstantResult>
		)(RESOURCES_OPERATION, input, signal, ctx ?? undefined);
		return result.ok ? JSON.parse(result.answer) : result;
	};
	const commands = () =>
		store.read(
			(db) =>
				db
					.query(
						"SELECT seq, uri, action, adapter_ref AS adapterRef, target_ref AS targetRef, status FROM screen_commands ORDER BY seq",
					)
					.all() as Array<Record<string, unknown>>,
		);
	return { store, adapter, run, ledger, prepared, commands, screen, events };
}

test("describe: one write operation on the resourcesTool schema, answered instantly", () => {
	const { adapter } = harness();
	const described = adapter.describe();
	expect(described.instant).toBe(true);
	expect(described.operations.get(RESOURCES_OPERATION)).toEqual({
		inputSchemaRef: "builtin:resourcesTool",
		effect: "write",
	});
});

test("find returns numbered hits newest first, and enters them in the ledger as found", async () => {
	const { run, ledger } = harness();
	const result = await run({ operation: "find", query: "の", limit: 5 });
	expect(result).toEqual({
		ok: true,
		items: [
			{ item: "a1", kind: "曲", label: "日曜日の午後", createdAt: "10-24" },
			{
				item: "a2",
				kind: "調査報告",
				label: "エージェント設計の講演",
				createdAt: "10-21",
			},
			{ item: "a3", kind: "画像", label: "決戦前の二人", createdAt: "10-20" },
		],
	});
	expect(ledger.rows.map((r) => [r.kind, r.source])).toEqual([
		["music.track", "found"],
		["report", "found"],
		["image", "found"],
	]);
	// The same hit keeps its number.
	const again = await run({ operation: "find", query: "日曜日" });
	expect(again.items).toEqual([
		{ item: "a1", kind: "曲", label: "日曜日の午後", createdAt: "10-24" },
	]);
	expect(ledger.rows).toHaveLength(3);
});

test("find filters by the kind's display label and by day, and names the kinds when the label is unknown", async () => {
	const { run } = harness();
	expect(
		(await run({ operation: "find", query: "の", kind: "画像" })).items.map(
			(i: { kind: string }) => i.kind,
		),
	).toEqual(["画像"]);
	expect(
		(
			await run({
				operation: "find",
				query: "の",
				since: "2026-10-21",
				until: "2026-10-21",
			})
		).items.map((i: { label: string }) => i.label),
	).toEqual(["エージェント設計の講演"]);
	expect(await run({ operation: "find", query: "の", kind: "動画" })).toEqual({
		ok: false,
		code: "kind_unknown",
		kinds: ["画像", "曲", "調査報告"],
	});
});

test("open issues one screen command with the prepared adapterRef and targetRef, and touches the ledger", async () => {
	const { run, commands, ledger, prepared } = harness();
	await run({ operation: "find", query: "決戦" });
	expect(await run({ operation: "open", item: "a1" })).toEqual({
		ok: true,
		item: "a1",
		action: "open",
		kind: "画像",
	});
	expect(prepared).toEqual(["image:i1:open"]);
	expect(commands()).toEqual([
		{
			seq: 1,
			uri: "eumenes://image/i1",
			action: "open",
			adapterRef: "adapter:image:prepared",
			targetRef: "list-i1",
			status: "pending",
		},
	]);
	expect(ledger.touched).toEqual(["res1"]);
});

test("play on a track issues a play command", async () => {
	const { run, commands } = harness();
	await run({ operation: "find", query: "日曜日" });
	expect(await run({ operation: "play", item: "a1" })).toEqual({
		ok: true,
		item: "a1",
		action: "play",
		kind: "曲",
	});
	expect(commands()).toMatchObject([
		{ action: "play", uri: "eumenes://music.track/t1", targetRef: "list-t1" },
	]);
});

test("play on an image is refused with the allowed actions, and issues nothing", async () => {
	const { run, commands, ledger } = harness();
	await run({ operation: "find", query: "決戦" });
	expect(await run({ operation: "play", item: "a1" })).toEqual({
		ok: false,
		code: "action_not_allowed",
		kind: "画像",
		allowed: ["open", "read"],
	});
	expect(commands()).toEqual([]);
	expect(ledger.touched).toEqual([]);
});

test("an unknown number is item_not_found for open, play and read", async () => {
	const { run, commands } = harness();
	for (const operation of ["open", "play", "read"])
		expect(await run({ operation, item: "a99" })).toEqual({
			ok: false,
			code: "item_not_found",
		});
	expect(commands()).toEqual([]);
});

test("a resource the owner no longer has is item_not_found", async () => {
	const { run } = harness();
	await run({ operation: "find", query: "決戦" });
	items.image = [];
	try {
		expect(await run({ operation: "open", item: "a1" })).toEqual({
			ok: false,
			code: "item_not_found",
		});
	} finally {
		items.image = [
			{
				id: "i1",
				label: "決戦前の二人",
				createdAt: "2026-10-20T10:00:00+09:00",
				text: "画像の説明",
			},
		];
	}
});

test("read returns the owner's text, bounded to what one answer carries", async () => {
	const { run, ledger } = harness();
	await run({ operation: "find", query: "決戦" });
	expect(await run({ operation: "read", item: "a1" })).toEqual({
		ok: true,
		item: "a1",
		kind: "画像",
		text: "画像の説明",
	});
	expect(ledger.touched).toEqual(["res1"]);
	await run({ operation: "find", query: "講演" });
	const long = await adapterAnswer(run, "a2");
	expect(long.length).toBeLessThanOrEqual(RESOURCES_ANSWER_MAX_CHARS);
	expect(JSON.parse(long)).toMatchObject({
		ok: true,
		kind: "調査報告",
		truncated: true,
	});
});

async function adapterAnswer(
	run: (input: unknown) => Promise<unknown>,
	item: string,
) {
	const result = (await run({ operation: "read", item })) as Record<
		string,
		unknown
	>;
	return JSON.stringify(result);
}

test("read of a kind that does not allow it is refused", async () => {
	const { run } = harness();
	const original = kinds[2]!.actions;
	kinds[2]!.actions = ["open"];
	try {
		await run({ operation: "find", query: "講演" });
		expect(await run({ operation: "read", item: "a1" })).toEqual({
			ok: false,
			code: "action_not_allowed",
			kind: "調査報告",
			allowed: ["open"],
		});
	} finally {
		kinds[2]!.actions = original;
	}
});

test("bad arguments and a missing conversation are failures of the call, not answers", async () => {
	const { run } = harness();
	expect(await run({ operation: "find" })).toEqual({
		ok: false,
		code: "invalid_input",
	});
	expect(await run({ operation: "play", item: "item-3" })).toEqual({
		ok: false,
		code: "invalid_input",
	});
	expect(await run({ operation: "play" })).toEqual({
		ok: false,
		code: "invalid_input",
	});
	expect(await run({ operation: "open", item: "a1", query: "x" })).toEqual({
		ok: false,
		code: "invalid_input",
	});
	expect(await run({ operation: "open", item: "a1" }, null)).toEqual({
		ok: false,
		code: "conversation_required",
	});
});

test("a settled screen command appends exactly one acted event, naming the resource by its number", async () => {
	const { run, screen, store, events } = harness();
	await run({ operation: "find", query: "日曜日" });
	await run({ operation: "play", item: "a1" });
	await run({ operation: "find", query: "決戦" });
	await run({ operation: "open", item: "a2" });
	const logged = () =>
		store.read((db) =>
			events
				.logInTransaction(db, "main")
				.filter((event) => event.type === "acted"),
		);
	expect(logged()).toEqual([]);
	expect(await screen.receipt(1, "blocked")).toMatchObject({ ok: true });
	expect(await screen.receipt(1, "done")).toEqual({
		ok: false,
		code: "command_settled",
	});
	expect(await screen.receipt(2, "done")).toMatchObject({ ok: true });
	const acted = logged();
	expect(acted).toHaveLength(2);
	expect(acted[0]!.by).toBe("host");
	expect(acted[0]!.text).toContain('"action":"screen.blocked"');
	expect(acted[0]!.text).toContain('"resource":"a1"');
	expect(acted[0]!.text).toContain('"operation":"play"');
	expect(acted[1]!.text).toContain('"action":"screen.done"');
	expect(acted[1]!.text).toContain('"resource":"a2"');
});

test("an unreceived command expires into one screen.expired event", async () => {
	const { run, store, events, screen } = harness();
	await run({ operation: "find", query: "日曜日" });
	await run({ operation: "play", item: "a1" });
	const later = createScreen({
		store,
		now: () => NOW + 60_000,
		onSettled: (db, command) =>
			screenSettledEventInTransaction(
				{
					events,
					ledger: { enterInTransaction: () => ({ ref: 1 }) as never },
					registry: {
						resolveInTransaction: () => ({ ok: false, code: "item_not_found" }),
					},
				},
				db,
				command,
			),
	});
	await store.write((db) => later.expireInTransaction(db));
	await store.write((db) => later.expireInTransaction(db));
	const acted = store.read((db) =>
		events.logInTransaction(db, "main").filter((e) => e.type === "acted"),
	);
	expect(acted).toHaveLength(1);
	expect(acted[0]!.text).toContain('"action":"screen.expired"');
	// The resource no longer resolves: the event names the operation only.
	expect(acted[0]!.text).not.toContain("resource");
	expect(screen.command(1)).toMatchObject({ status: "expired" });
});
