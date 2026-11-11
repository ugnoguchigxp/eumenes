import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { configureLogging } from "../../../infrastructure/logger";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { migrations as capabilityMigrations } from "../../capabilities";
import { ROUTER_TRACE_RETENTION_MS, type RouterTrace } from "../contracts";
import {
	createToolchainHistory,
	migrations,
	registerToolchainHistory,
} from "..";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function setup(clock = { at: 1_000_000 }) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-router-history-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db"), [
		...capabilityMigrations,
		...migrations,
	]);
	stores.push(store);
	return {
		store,
		clock,
		history: createToolchainHistory(store, () => clock.at),
	};
}
const space = {
	modelId: "fixture",
	revision: "r1",
	artifactDigest: "d1",
	dimension: 4,
};
const other = { ...space, revision: "r2" };
const unit = (i: number) => [0, 1, 2, 3].map((j) => (j === i ? 1 : 0));
const trace = (
	decided: string | null,
	extra: Partial<RouterTrace> = {},
): RouterTrace => ({
	mode: "on",
	revision: "rev",
	model: null,
	candidates: [
		{
			id: "music.library",
			kind: "toolchain",
			raw: 0.5,
			correction: 0,
			p: 0.5,
			score: null,
		},
	],
	set: ["music.library", "music.create"],
	row: 3,
	decided,
	durationMs: 12,
	error: null,
	...extra,
});
const turn = (runId: string, extra: Record<string, unknown> = {}) => ({
	runId,
	conversationId: "main",
	messageId: `m-${runId}`,
	text: "コーヒータイムにぴったりな音楽をつくって",
	query: { space, vector: unit(0) },
	trace: trace("music.library"),
	...extra,
});
const feedback = (extra: Record<string, unknown> = {}) => ({
	conversationId: "main",
	messageId: "m1",
	runId: "run-1",
	source: "redirect" as const,
	text: "違う、作曲してほしい",
	query: { space, vector: unit(0) },
	wrongId: "music.library",
	rightId: "music.create",
	...extra,
});

test("the migration applies on a fresh database and on one that has the earlier migrations", async () => {
	const { store } = setup();
	const tables = (s: SqliteStore) =>
		s
			.read((db) =>
				db.query("SELECT name FROM sqlite_master WHERE type='table'").all(),
			)
			.map((t) => (t as { name: string }).name);
	expect(tables(store)).toEqual(
		expect.arrayContaining([
			"router_traces",
			"router_feedback",
			"toolchain_selections",
		]),
	);
	const dir = mkdtempSync(join(tmpdir(), "eumenes-router-migration-"));
	dirs.push(dir);
	const path = join(dir, "db");
	const before = migrations.filter(
		(m) => m.id !== "toolchain-history/0005-router",
	);
	let old = openStore(path, [...capabilityMigrations, ...before]);
	await old.write((db) =>
		db
			.query(
				"INSERT INTO toolchain_selections(id,run_id,conversation_id,retrieval,candidates_json,history_refs_json,decision,created_at,expires_at) VALUES('a','run-a','main','none','[]','[]','answer',1,2)",
			)
			.run(),
	);
	await old.close();
	old = openStore(path, [...capabilityMigrations, ...migrations]);
	stores.push(old);
	expect(tables(old)).toEqual(
		expect.arrayContaining(["router_traces", "router_feedback"]),
	);
	expect(
		createToolchainHistory(old, () => 1).getSelection("run-a"),
	).toMatchObject({
		runId: "run-a",
	});
});

test("a trace is replaced by a later write of its run and keeps the work it started", async () => {
	const { store, history } = setup();
	await store.write((db) => {
		history.recordRouterTraceInTransaction(db, turn("run"));
		history.linkRouterWorkInTransaction(db, "run", "t3");
		history.linkRouterWorkInTransaction(db, "absent", "t9");
		history.recordRouterTraceInTransaction(
			db,
			turn("run", { trace: trace("music.create", { set: ["music.create"] }) }),
		);
	});
	const row = store.read((db) =>
		history.latestRouterTraceInTransaction(db, {
			conversationId: "main",
			since: 0,
		}),
	);
	expect(row).toMatchObject({
		runId: "run",
		messageId: "m-run",
		text: "コーヒータイムにぴったりな音楽をつくって",
		decided: "music.create",
		workId: "t3",
		set: ["music.create"],
		createdAt: 1_000_000,
		query: { space, vector: unit(0) },
	});
	expect(
		store.read((db) =>
			db.query("SELECT COUNT(*) AS n FROM router_traces").get(),
		),
	).toEqual({ n: 1 });
});

test("the text is capped and a trace without a vector reads back with query null", async () => {
	const { store, history } = setup();
	await store.write((db) =>
		history.recordRouterTraceInTransaction(
			db,
			turn("run", { text: "あ".repeat(3000), query: null }),
		),
	);
	const row = store.read((db) =>
		history.latestRouterTraceInTransaction(db, {
			conversationId: "main",
			since: 0,
		}),
	);
	expect(row?.text).toHaveLength(2000);
	expect(row?.query).toBeNull();
});

test("the latest trace is the newest of the conversation made since the bound, whatever it decided", async () => {
	const { store, history, clock } = setup();
	await store.write((db) => {
		clock.at = 1000;
		history.recordRouterTraceInTransaction(db, turn("old"));
		clock.at = 2000;
		history.recordRouterTraceInTransaction(db, turn("mid"));
		clock.at = 3000;
		history.recordRouterTraceInTransaction(
			db,
			turn("none", { trace: trace(null) }),
		);
		history.recordRouterTraceInTransaction(
			db,
			turn("elsewhere", { conversationId: "side" }),
		);
	});
	const latest = (since: number, conversationId = "main") =>
		store.read((db) =>
			history.latestRouterTraceInTransaction(db, { conversationId, since }),
		);
	// The newest, though it decided nothing (a question back or a failure is a turn too).
	expect(latest(0)).toMatchObject({
		runId: "none",
		decided: null,
		row: 3,
		mode: "on",
	});
	expect(latest(2000)?.runId).toBe("none");
	expect(latest(3000)?.runId).toBe("none");
	expect(latest(3001)).toBeNull();
	expect(latest(0, "side")?.runId).toBe("elsewhere");
	expect(latest(0, "empty")).toBeNull();
});

test("an expired trace is not returned and is deleted by the next write", async () => {
	const { store, history, clock } = setup();
	await store.write((db) =>
		history.recordRouterTraceInTransaction(db, turn("run")),
	);
	clock.at += ROUTER_TRACE_RETENTION_MS;
	expect(
		store.read((db) =>
			history.latestRouterTraceInTransaction(db, {
				conversationId: "main",
				since: 0,
			}),
		),
	).toBeNull();
	await store.write((db) =>
		history.recordRouterTraceInTransaction(db, turn("next")),
	);
	expect(
		store.read((db) => db.query("SELECT run_id FROM router_traces").all()),
	).toEqual([{ run_id: "next" }]);
});

test("near corrections: threshold, own space, active only, nearest first, limit", async () => {
	const { store, history, clock } = setup();
	const ids = await store.write((db) => {
		const add = (vector: number[], extra: Record<string, unknown> = {}) => {
			clock.at += 1;
			return history.recordRouterFeedbackInTransaction(
				db,
				feedback({ query: { space, vector }, ...extra }),
			);
		};
		return {
			exact: add(unit(0), { rightId: "exact" }),
			close: add([0.9, Math.sqrt(1 - 0.81), 0, 0], { rightId: "close" }),
			far: add(unit(1), { rightId: "far" }),
			retracted: add(unit(0), { rightId: "retracted" }),
			foreign: history.recordRouterFeedbackInTransaction(
				db,
				feedback({
					query: { space: other, vector: unit(0) },
					rightId: "foreign",
				}),
			),
		};
	});
	await store.write((db) =>
		history.setRouterFeedbackStateInTransaction(db, ids.retracted, "retracted"),
	);
	const near = (threshold: number, limit?: number) =>
		store.read((db) =>
			history.nearRouterFeedbackInTransaction(db, {
				space,
				vector: unit(0),
				threshold,
				limit,
			}),
		);
	expect(near(0.85).map((f) => f.rightId)).toEqual(["exact", "close"]);
	expect(near(0.95).map((f) => f.rightId)).toEqual(["exact"]);
	expect(near(0.85)[0]).toMatchObject({
		id: ids.exact,
		wrongId: "music.library",
		similarity: 1,
	});
	expect(near(-1, 1)).toHaveLength(1);
	expect(near(-1).map((f) => f.rightId)).toEqual(["exact", "close", "far"]);
});

test("without a limit at most five corrections come back", async () => {
	const { store, history } = setup();
	await store.write((db) => {
		for (let i = 0; i < 7; i++)
			history.recordRouterFeedbackInTransaction(
				db,
				feedback({ rightId: `r${i}` }),
			);
	});
	expect(
		store.read((db) =>
			history.nearRouterFeedbackInTransaction(db, {
				space,
				vector: unit(0),
				threshold: 0.5,
			}),
		),
	).toHaveLength(5);
});

test("corrections preserve source order, old vectors, search limits and host validation", async () => {
	const { store, history, clock } = setup();
	const events: unknown[] = [];
	configureLogging({
		level: "info",
		destination: {
			write(line) {
				const event = JSON.parse(line);
				if (event.event.startsWith("toolchain.router_feedback_"))
					events.push(event);
			},
		},
	});
	try {
		const { oldest, first, tied, legacy } = await store.write((db) => {
			const oldest = history.recordRouterFeedbackInTransaction(
				db,
				feedback({ rightId: "oldest" }),
			);
			clock.at += 1;
			const first = history.recordRouterFeedbackInTransaction(
				db,
				feedback({ rightId: "first" }),
			);
			const tied = history.recordRouterFeedbackInTransaction(
				db,
				feedback({
					rightId: "tied",
					text: "字".repeat(2001),
					messageIds: ["related", "m1", "related"],
				}),
			);
			const legacy = history.recordRouterFeedbackInTransaction(
				db,
				feedback({
					rightId: "",
					query: { space, vector: [1] },
				}),
			);
			return { oldest, first, tied, legacy };
		});
		const row = (id: string) =>
			store.read((db) =>
				db
					.query(
						"SELECT message_ids_json, length(query_text) AS chars, length(query_vector) AS bytes FROM router_feedback WHERE id=?",
					)
					.get(id),
			);
		expect(row(tied)).toEqual({
			message_ids_json: '["m1","related"]',
			chars: 2000,
			bytes: 16,
		});
		expect(row(legacy)).toMatchObject({ message_ids_json: '["m1"]', bytes: 4 });
		const near = (threshold: number, limit?: number, vector = unit(0)) =>
			store
				.read((db) =>
					history.nearRouterFeedbackInTransaction(db, {
						space,
						vector,
						threshold,
						limit,
					}),
				)
				.map(({ id }) => id);
		expect(near(1)).toEqual([tied, first, oldest]);
		expect(near(1, 0)).toEqual([]);
		expect(near(1, 1.9)).toEqual([tied]);
		expect(near(1, undefined, [1])).toEqual([legacy]);
		expect(near(Number.NaN)).toEqual([]);
		await expect(
			store.write((db) =>
				history.setRouterFeedbackStateInTransaction(
					db,
					tied,
					"invalid" as never,
				),
			),
		).rejects.toThrow("CHECK constraint failed");
		expect(await history.setRouterFeedbackState(tied, "conflict")).toBe(true);
		expect(await history.setRouterFeedbackState("missing", "conflict")).toBe(
			false,
		);
		expect(near(1)).toEqual([first, oldest]);
		expect(events).toMatchObject([
			...[oldest, first, tied, legacy].map((subjectId) => ({
				event: "toolchain.router_feedback_recorded",
				subjectId,
				runId: "run-1",
				source: "redirect",
			})),
			{
				event: "toolchain.router_feedback_state",
				subjectId: tied,
				phase: "conflict",
			},
		]);
	} finally {
		configureLogging({ level: "silent" });
	}
});

test("a correction starts active; its state changes and the list is newest first with a filter and a bounded limit", async () => {
	const { store, history, clock } = setup();
	const ids = await store.write((db) =>
		["a", "b", "c"].map((rightId) => {
			clock.at += 10;
			return history.recordRouterFeedbackInTransaction(
				db,
				feedback({ rightId, messageId: `m-${rightId}` }),
			);
		}),
	);
	const list = (filter?: { state?: "active" | "conflict"; limit?: number }) =>
		store.read((db) => history.listRouterFeedbackInTransaction(db, filter));
	expect(list().map((f) => f.rightId)).toEqual(["c", "b", "a"]);
	expect(list()[0]).toMatchObject({
		id: ids[2],
		conversationId: "main",
		messageId: "m-c",
		runId: "run-1",
		source: "redirect",
		text: "違う、作曲してほしい",
		wrongId: "music.library",
		state: "active",
		createdAt: 1_000_030,
		updatedAt: 1_000_030,
	});
	clock.at += 10;
	expect(
		await store.write((db) =>
			history.setRouterFeedbackStateInTransaction(db, ids[1]!, "conflict"),
		),
	).toBe(true);
	expect(
		await store.write((db) =>
			history.setRouterFeedbackStateInTransaction(db, "unknown", "stale"),
		),
	).toBe(false);
	expect(list({ state: "conflict" })).toMatchObject([
		{
			id: ids[1],
			state: "conflict",
			updatedAt: 1_000_040,
			createdAt: 1_000_020,
		},
	]);
	expect(list({ state: "active" })).toHaveLength(2);
	expect(list({ limit: 1 })).toHaveLength(1);
	expect(list({ limit: 0 })).toHaveLength(1);
	expect(list({ limit: 100000 })).toHaveLength(3);
});

test("forgetting messages removes their traces and corrections and nothing else", async () => {
	const { store, history } = setup();
	await store.write((db) => {
		history.recordRouterTraceInTransaction(
			db,
			turn("a", { messageId: "gone" }),
		);
		history.recordRouterTraceInTransaction(
			db,
			turn("b", { messageId: "kept" }),
		);
		history.recordRouterFeedbackInTransaction(
			db,
			feedback({ messageId: "gone" }),
		);
		history.recordRouterFeedbackInTransaction(
			db,
			feedback({ messageId: "gone2" }),
		);
		history.recordRouterFeedbackInTransaction(
			db,
			feedback({ messageId: "kept" }),
		);
	});
	expect(
		await store.write((db) => history.forgetRouterInTransaction(db, [])),
	).toBe(0);
	expect(
		await store.write((db) =>
			history.forgetRouterInTransaction(db, ["gone", "gone2", "none"]),
		),
	).toBe(3);
	const left = (table: string) =>
		store.read((db) => db.query(`SELECT message_id FROM ${table}`).all());
	expect(left("router_traces")).toEqual([{ message_id: "kept" }]);
	expect(left("router_feedback")).toEqual([{ message_id: "kept" }]);
});

test("a trace or correction made from several messages is removed by a forget of any of them", async () => {
	const { store, history } = setup();
	await store.write((db) => {
		history.recordRouterTraceInTransaction(
			db,
			turn("joined", { messageId: "now", messageIds: ["asked", "now"] }),
		);
		history.recordRouterFeedbackInTransaction(
			db,
			feedback({ messageId: "now", messageIds: ["asked", "now"] }),
		);
		history.recordRouterTraceInTransaction(
			db,
			turn("other", { messageId: "kept" }),
		);
	});
	// The record lists every message, the primary one first and each once.
	expect(
		store.read(
			(db) =>
				history.latestRouterTraceInTransaction(db, {
					conversationId: "main",
					since: 0,
				})?.messageIds,
		),
	).toEqual(["kept"]);
	expect(
		store.read((db) =>
			db
				.query(
					"SELECT message_ids_json FROM router_traces WHERE run_id='joined'",
				)
				.get(),
		),
	).toEqual({ message_ids_json: JSON.stringify(["now", "asked"]) });
	expect(
		await store.write((db) => history.forgetRouterInTransaction(db, ["asked"])),
	).toBe(2);
	const left = (table: string) =>
		store.read((db) => db.query(`SELECT message_id FROM ${table}`).all());
	expect(left("router_traces")).toEqual([{ message_id: "kept" }]);
	expect(left("router_feedback")).toEqual([]);
});

test("forgetting more messages than one statement binds still removes them all", async () => {
	const { store, history } = setup();
	const ids = Array.from({ length: 1200 }, (_, i) => `m${i}`);
	await store.write((db) => {
		for (const messageId of ids)
			history.recordRouterFeedbackInTransaction(db, feedback({ messageId }));
	});
	expect(
		await store.write((db) => history.forgetRouterInTransaction(db, ids)),
	).toBe(1200);
});

test("the review API lists corrections with their text and changes their state", async () => {
	const { store, history } = setup();
	const id = await store.write((db) =>
		history.recordRouterFeedbackInTransaction(db, feedback()),
	);
	const app = new Hono();
	registerToolchainHistory(app, history);
	const get = (path: string) =>
		app.request(`/api/toolchain-history/router-feedback${path}`);
	const post = (key: string, body: unknown) =>
		app.request(`/api/toolchain-history/router-feedback/${key}/state`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const listed = (await (await get("?state=active&limit=10")).json()) as {
		items: Array<{ id: string; text: string }>;
	};
	expect(listed.items).toMatchObject([{ id, text: "違う、作曲してほしい" }]);
	expect((await get("?state=bogus")).status).toBe(400);
	expect((await get("?limit=x")).status).toBe(400);
	expect((await post(id, { state: "bogus" })).status).toBe(400);
	expect((await post(id, { state: "retracted", extra: 1 })).status).toBe(400);
	expect((await post("unknown", { state: "retracted" })).status).toBe(404);
	expect((await post(id, { state: "retracted" })).status).toBe(200);
	expect(
		((await (await get("?state=active")).json()) as { items: unknown[] }).items,
	).toEqual([]);
	expect(
		((await (await get("?state=retracted")).json()) as { items: unknown[] })
			.items,
	).toHaveLength(1);
});
