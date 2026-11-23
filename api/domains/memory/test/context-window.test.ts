import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogging } from "../../../infrastructure/logger";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { createConversationService } from "../../conversation";
import { createContinuityFixture as createContinuityService } from "../../../application/world/state-services.fixture";
import { createMemoryService, type MemoryRecallInput } from "..";
import { memoryTestMigrations, saveItem } from "./memory.fixture";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-window-"));
	const store: SqliteStore = openStore(
		join(dir, "db.sqlite3"),
		memoryTestMigrations,
	);
	cleanups.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const time = { now: "2026-10-13T12:00:00.000Z" };
	const clock = () => time.now;
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store, clock);
	let counter = 0;
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: join(dir, "journal.jsonl"),
		clock,
		id: () => `id-${++counter}`,
	});
	expect((await memory.recover()).healthy).toBe(true);
	await conversation.append({
		id: "m1",
		conversationId: "c1",
		role: "user",
		text: "私はコーヒーが好きで、毎朝走っています",
		createdAt: "2026-10-01T00:00:00Z",
		runId: null,
	});
	// A message of its own: forgetting what the other items stand on leaves it.
	await conversation.append({
		id: "m-note",
		conversationId: "c1",
		role: "user",
		text: "メモの元の発言",
		createdAt: "2026-10-01T00:01:00Z",
		runId: null,
	});
	let n = 0;
	const remember = (
		text: string,
		kind: "preference" | "habit" = "preference",
		quote = "コーヒーが好き",
	) =>
		saveItem(store, memory, {
			conversationId: "c1",
			messageId: "m1",
			quote,
			kind,
			semanticKey: `key-${++n}`,
			text,
		});
	const stop = async (id: string, revision: number) => {
		const [result] = await store.write((db) =>
			memory.applyCurationInTransaction(db, {
				conversationId: "c1",
				items: [{ op: "stop", itemId: id, revision }],
			}),
		);
		if (result?.status !== "applied") throw new Error("stop_rejected");
		return must(memory.list(true).find((entry) => entry.id === id));
	};
	const forget = (id: string) =>
		memory.forget({ conversationId: "c1", itemIds: [id], messageIds: [] });
	const save = (input: Parameters<typeof saveItem>[2]) =>
		saveItem(store, memory, input);
	const read = (conversationId = "c1") =>
		store.write((db) => memory.windowForRunInTransaction(db, conversationId));
	return {
		dir,
		store,
		memory,
		continuity,
		conversation,
		time,
		remember,
		stop,
		forget,
		save,
		read,
	};
}
/** The texts the published profile shows, and those waiting beside it. */
const shown = (window: { profile: { items: Array<{ text: string }> } }) =>
	window.profile.items.map((item) => item.text);
const waiting = (window: { newMemories: Array<{ text: string }> }) =>
	window.newMemories.map((item) => item.text);
function must<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected_value");
	return value;
}

test("the first read publishes the profile and an unchanged input returns the same version and items", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	const first = must(await h.read());
	expect(first.version).toBe(1);
	expect(first.profile.items).toEqual([
		expect.objectContaining({
			kind: "preference",
			text: "コーヒーが好き",
			source: "user_said",
			negated: false,
		}),
	]);
	expect(first.profile.tokens).toBeGreaterThan(0);
	expect(first.newMemories).toEqual([]);
	const second = must(await h.read());
	expect(second.version).toBe(1);
	expect(second.buildId).toBe(first.buildId);
	expect(second.profile).toEqual(first.profile);
});

test("what the agent inferred is shown as an inference, never as the user's own words", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	await saveItem(h.store, h.memory, {
		conversationId: "c1",
		messageId: "m1",
		quote: "コーヒーが好き",
		kind: "preference",
		semanticKey: "inferred-key",
		text: "濃い味を好む",
		explicit: false,
	});
	const window = must(await h.read());
	const sources = Object.fromEntries(
		[...window.profile.items, ...window.newMemories].map((item) => [
			item.text,
			item.source,
		]),
	);
	expect(sources).toEqual({
		コーヒーが好き: "user_said",
		濃い味を好む: "inferred",
	});
});

test("a window stored before the sources were told apart is built again, so an inference stops reading as the user's words", async () => {
	const h = await setup();
	await saveItem(h.store, h.memory, {
		conversationId: "c1",
		messageId: "m1",
		quote: "コーヒーが好き",
		kind: "preference",
		semanticKey: "inferred-key",
		text: "濃い味を好む",
		explicit: false,
	});
	const first = must(await h.read());
	// As it was stored before: no format, and every State item the user's own words.
	await h.store.write((db) => {
		const row = db
			.query(
				"SELECT snapshot FROM memory_context_window WHERE conversation_id = 'c1'",
			)
			.get() as { snapshot: string };
		const old = JSON.parse(row.snapshot) as Record<string, unknown> & {
			profile: { items: Array<{ source: string }> };
		};
		delete old.format;
		for (const item of old.profile.items) item.source = "user_said";
		db.query(
			"UPDATE memory_context_window SET snapshot = ?, build_id = 'before' WHERE conversation_id = 'c1'",
		).run(JSON.stringify(old));
	});
	const rebuilt = must(await h.read());
	expect(rebuilt.version).toBe(first.version + 1);
	expect(rebuilt.profile.items.map((item) => item.source)).toEqual([
		"inferred",
	]);
});

test("an empty memory has an empty profile and is not treated as unavailable", async () => {
	const h = await setup();
	const window = must(await h.read());
	expect(window.profile.items).toEqual([]);
	await h.memory.setEnabled(false);
	expect(await h.read()).toBeNull();
});

test("additions wait in newMemories; a requested republish waits for the re-construction, which keeps the order and appends", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	await h.remember("紅茶も好き");
	const base = must(await h.read());
	expect(shown(base)).toEqual(["コーヒーが好き", "紅茶も好き"]);
	await h.remember("毎朝走っている", "habit", "毎朝走って");
	for (const text of ["二", "三", "四", "五"]) await h.remember(`${text}番目`);
	const five = must(await h.read());
	expect(five.version).toBeGreaterThan(base.version);
	expect(five.profile).toEqual(base.profile);
	expect(waiting(five)).toHaveLength(5);
	// The steward asks for a republish: it is only recorded.
	const requested = await h.store.write((db) =>
		h.memory.publishWindowInTransaction(db, "c1", { requestRepublish: true }),
	);
	expect(requested.republishRequested).toBe(true);
	expect(requested.profile).toEqual(base.profile);
	// The re-construction publishes: the earlier items keep their place, the new ones follow in their kind.
	const published = must(
		await h.store.write((db) =>
			h.memory.republishWindowInTransaction(db, "c1"),
		),
	);
	expect(published.republishRequested).toBe(false);
	expect(published.newMemories).toEqual([]);
	expect(shown(published)).toEqual([
		"コーヒーが好き",
		"紅茶も好き",
		"二番目",
		"三番目",
		"四番目",
		"五番目",
		"毎朝走っている",
	]);
});

test("the profile is not republished when the local date changes", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	const day1 = must(await h.read());
	h.time.now = "2026-10-15T12:00:00.000Z";
	const day2 = must(await h.read());
	expect(day2.version).toBe(day1.version);
	expect(day2.buildId).toBe(day1.buildId);
});

test("stop, forget and the ON/OFF setting republish the profile at once", async () => {
	const h = await setup();
	const a = await h.remember("コーヒーが好き");
	const b = await h.remember("毎朝走っている", "habit", "毎朝走って");
	await h.save({
		conversationId: "c1",
		messageId: "m-note",
		quote: "メモの元の発言",
		kind: "preference",
		semanticKey: "fourth",
		text: "四つ目の事実",
	});
	let window = must(await h.read());
	expect(shown(window)).toContain("コーヒーが好き");
	const seen = async () => {
		const next = must(await h.read());
		expect(next.buildId).not.toBe(window.buildId);
		window = next;
		return next;
	};
	await h.stop(a.id, a.revision);
	expect(shown(await seen())).not.toContain("コーヒーが好き");
	await h.forget(b.id);
	expect(shown(await seen())).not.toContain("毎朝走っている");
	const before = window.inputs.policyRevision;
	await h.memory.setEnabled(false);
	await h.memory.setEnabled(true);
	expect((await seen()).inputs.policyRevision).not.toBe(before);
	await h.memory.setEnabled(true);
	expect(must(await h.read()).version).toBe(window.version);
	expect(shown(window)).toContain("四つ目の事実");
});

test("only a stop (or a forget) is immediate; additions, replacements and denials by the steward are not", async () => {
	const h = await setup();
	const first = await h.remember("コーヒーが好き");
	await h.read();
	const seq = () =>
		h.store.read(
			(db) =>
				(
					db
						.query(
							"SELECT COALESCE(MAX(seq),0) AS s FROM memory_immediate_change",
						)
						.get() as { s: number }
				).s,
		);
	const start = await seq();
	await h.remember("毎朝走っている", "habit", "毎朝走って");
	expect(await seq()).toBe(start);
	await h.remember("コーヒーが好きです", "preference", "コーヒーが好き");
	expect(await seq()).toBe(start);
	await h.stop(first.id, first.revision);
	expect(await seq()).toBe(start + 1);
	await h.save({
		conversationId: "c1",
		messageId: "m1",
		quote: "コーヒーが好き",
		kind: "preference",
		semanticKey: "negated-key",
		text: "辛い物が好き",
		polarity: "negated",
	});
	expect(await seq()).toBe(start + 1);
	const window = must(await h.read());
	expect(
		[...window.profile.items, ...window.newMemories].find(
			(item) => item.text === "辛い物が好き",
		),
	).toMatchObject({ negated: true });
});

test("an explicit correction republishes at once and leaves no old text; an inferred one keeps nothing of the old text either", async () => {
	const h = await setup();
	const a = await h.remember("コーヒーが好き");
	const b = await h.remember("毎朝走っている", "habit", "毎朝走って");
	const base = must(await h.read());
	expect(shown(base)).toContain("コーヒーが好き");
	const update = async (
		item: { id: string; revision: number },
		text: string,
		explicit: boolean,
	) => {
		const [result] = await h.store.write((db) =>
			h.memory.applyCurationInTransaction(db, {
				conversationId: "c1",
				items: [
					{
						op: "update",
						itemId: item.id,
						revision: item.revision,
						text,
						messageId: "m1",
						quote: "コーヒーが好き",
						explicit,
					},
				],
			}),
		);
		expect(result?.status).toBe("applied");
	};
	await update(b, "毎朝泳いでいる", false);
	const inferred = must(await h.read());
	for (const text of [...shown(inferred), ...waiting(inferred)])
		expect(text).not.toBe("毎朝走っている");
	expect(waiting(inferred)).toContain("毎朝泳いでいる");
	await update(a, "紅茶が好き", true);
	const corrected = must(await h.read());
	expect(corrected.buildId).not.toBe(inferred.buildId);
	expect(shown(corrected)).toContain("紅茶が好き");
	expect(shown(corrected)).not.toContain("コーヒーが好き");
	expect(waiting(corrected)).toEqual([]);
	const kinds = h.store.read(
		(db) =>
			db.query("SELECT kind FROM memory_immediate_change").all() as Array<{
				kind: string;
			}>,
	);
	expect(kinds.map((row) => row.kind)).toContain("state_correct");
});

/** The ranked read as the read tool uses it: everything is returned, suppressed records marked. */
const readTool = (
	h: Awaited<ReturnType<typeof setup>>,
	text: string,
	over: Partial<MemoryRecallInput> = {},
) =>
	must(
		h.memory.recall({
			text,
			limit: 10,
			shown: new Set(),
			omitShown: true,
			minScore: 0,
			...over,
		}),
	);

test("the read tool's ranked read matches a natural Japanese sentence and leaves out what the always-on section shows", async () => {
	const h = await setup();
	const coffee = await h.remember("コーヒーが好き");
	await h.remember("毎朝走っている", "habit", "毎朝走って");
	const texts = (read: ReturnType<typeof readTool>) =>
		read.items.map((item) => item.text);
	expect(texts(readTool(h, "私はコーヒーが好きでしたっけ"))).toEqual([
		"コーヒーが好き",
	]);
	expect(texts(readTool(h, "毎朝走ってる？"))).toEqual(["毎朝走っている"]);
	expect(readTool(h, "全く関係のない話")).toEqual({
		total: 2,
		matched: 0,
		items: [],
	});
	// Without words: every record, newest first, and the counts. The limit bounds the items, not the counts.
	expect(readTool(h, "")).toMatchObject({ total: 2, matched: 2 });
	expect(texts(readTool(h, ""))).toEqual(["毎朝走っている", "コーヒーが好き"]);
	expect(readTool(h, "", { limit: 1 })).toMatchObject({ total: 2, matched: 2 });
	expect(texts(readTool(h, "", { limit: 1 }))).toEqual(["毎朝走っている"]);
	// What the always-on section shows is left out, and not counted as matched.
	const shown = new Set([coffee.id]);
	expect(readTool(h, "", { shown })).toMatchObject({ total: 2, matched: 1 });
	expect(texts(readTool(h, "コーヒー", { shown }))).toEqual([]);
	// Kept (the per-turn section does), it is marked.
	expect(readTool(h, "コーヒー", { shown, omitShown: false }).items).toEqual([
		{
			id: coffee.id,
			revision: coffee.revision,
			kind: "preference",
			text: "コーヒーが好き",
			source: "user_said",
			inProfile: true,
			score: expect.any(Number),
		},
	]);
	// A suppressed record is still read by the tool (it says it is not to be brought up), and the mark is shown.
	await h.store.write((db) =>
		h.memory.suppressInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-s",
			target: { itemId: coffee.id },
		}),
	);
	expect(readTool(h, "コーヒー").items).toEqual([
		expect.objectContaining({ id: coffee.id, suppressed: true }),
	]);
	expect(readTool(h, "毎朝走って").items[0]).not.toHaveProperty("suppressed");
	await h.memory.setEnabled(false);
	expect(
		h.memory.recall({
			text: "",
			limit: 10,
			shown: new Set(),
			omitShown: true,
			minScore: 0,
		}),
	).toBeNull();
});

test("a rolled-back rebuild is discarded: the next read uses the committed row", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	const committed = must(await h.read());
	await expect(
		h.store.write((db) => {
			h.memory.windows.rebuildInTransaction(db, "c1", { republish: true });
			throw new Error("abort");
		}),
	).rejects.toThrow("abort");
	const next = must(await h.read());
	expect(next.buildId).toBe(committed.buildId);
	expect(next.version).toBe(committed.version);
});

test("the same inputs always give the same profile", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	await h.remember("毎朝走っている", "habit", "毎朝走って");
	const one = await h.store.write((db) =>
		h.memory.windows.rebuildInTransaction(db, "c1", { republish: true }),
	);
	const two = await h.store.write((db) =>
		h.memory.windows.rebuildInTransaction(db, "c1", { republish: true }),
	);
	expect(two.version).toBe(one.version + 1);
	expect(two.profile).toEqual(one.profile);
});

test("an expired period is left out; a stated period is shown as absolute days", async () => {
	const h = await setup();
	await h.save({
		conversationId: "c1",
		messageId: "m1",
		quote: "コーヒーが好き",
		kind: "preference",
		semanticKey: "coffee",
		text: "コーヒーが好き",
		validFrom: "2026-09",
	});
	await h.save({
		conversationId: "c1",
		messageId: "m1",
		quote: "毎朝走って",
		kind: "habit",
		semanticKey: "old",
		text: "昔の習慣",
		validUntil: "2020",
	});
	const window = must(await h.read());
	expect(window.profile.items).toEqual([
		expect.objectContaining({ text: "コーヒーが好き", since: "2026-09" }),
	]);
	expect(waiting(window)).not.toContain("昔の習慣");
});

test("window validation: additions keep a run valid; stop, own-run changes, settings and pins decide the rest", async () => {
	const h = await setup();
	const item = await h.remember("コーヒーが好き");
	const window = must(await h.read());
	const prepared = h.memory.preparedWindow(window);
	const validate = (runId = "run-1", extra = prepared) =>
		h.store.read((db) =>
			h.memory.validateWindowInTransaction(db, runId, extra),
		);
	expect(await validate()).toEqual({ ok: true });
	// An addition during the run does not expire it.
	await h.remember("毎朝走っている", "habit", "毎朝走って");
	expect(await validate()).toEqual({ ok: true });
	// A change attributed to the run itself is not a reason to expire it; anyone else's is.
	await h.store.write((db) =>
		h.memory.windows.recordImmediateInTransaction(db, "state_stop", "run-1"),
	);
	expect(await validate("run-1")).toEqual({ ok: true });
	expect(await validate("run-2")).toEqual({
		ok: false,
		reason: "memory_stale",
	});
	// A stop expires it.
	const second = must(await h.read());
	const preparedSecond = h.memory.preparedWindow(second);
	expect(await validate("run-3", preparedSecond)).toEqual({ ok: true });
	await h.stop(item.id, item.revision);
	expect(await validate("run-3", preparedSecond)).toEqual({
		ok: false,
		reason: "memory_stale",
	});
	// OFF is unavailable.
	await h.memory.setEnabled(false);
	expect(await validate("run-3", preparedSecond)).toEqual({
		ok: false,
		reason: "memory_unavailable",
	});
});

test("usage receipts: adoption records the window it read", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	const window = must(await h.read());
	const prepared = h.memory.preparedWindow(window);
	await h.store.write((db) =>
		h.memory.recordUsageInTransaction(db, "run-1", "c1", prepared),
	);
	const receipt = h.memory.usage("run-1");
	expect(receipt).toMatchObject({
		viewDigest: `window:${window.version}:${window.buildId}`,
		stateRevision: String(window.inputs.immediateSeq),
		viewSchema: 3,
	});
	expect(receipt?.itemIds).toEqual(window.profile.items.map((item) => item.id));
});

test("S0-3: expired items stay stored but are not rendered, and nothing counts them against a limit", async () => {
	const h = await setup();
	// Through the 19th, inclusive: expired from 2026-10-20T00:00:00Z.
	const add = (key: string, validUntil: string | null = "2026-10-19") =>
		h.save({
			conversationId: "c1",
			messageId: "m1",
			quote: "コーヒーが好き",
			kind: "preference",
			semanticKey: key,
			text: `項目 ${key}`,
			...(validUntil === null ? {} : { validUntil }),
		});
	for (let i = 0; i < 101; i++) await add(`k${i}`);
	await add("over", null);
	h.time.now = "2026-10-21T00:00:00.000Z";
	expect(h.memory.list()).toHaveLength(102);
	const window = must(await h.read());
	const texts = [...shown(window), ...waiting(window)];
	expect(texts).toContain("項目 over");
	expect(texts).not.toContain("項目 k1");
});

const MIGRATIONS = memoryTestMigrations;
const windowRows = (h: Awaited<ReturnType<typeof setup>>) =>
	h.store.read(
		(db) =>
			db.query("SELECT snapshot FROM memory_context_window").all() as {
				snapshot: string;
			}[],
	);

test("forgetting purges every stored window, also with memory OFF", async () => {
	for (const off of [false, true]) {
		const h = await setup();
		const item = await h.remember("秘密の趣味が好き");
		await h.read("c1");
		await h.read("c2");
		expect(windowRows(h)).toHaveLength(2);
		expect(windowRows(h).some((r) => r.snapshot.includes("秘密の趣味"))).toBe(
			true,
		);
		if (off) await h.memory.setEnabled(false);
		await h.forget(item.id);
		expect(windowRows(h)).toEqual([]);
		// The next read builds from State again and does not bring the value back.
		if (off) await h.memory.setEnabled(true);
		const next = must(await h.read());
		expect([...shown(next), ...waiting(next)].join()).not.toContain(
			"秘密の趣味",
		);
		expect(windowRows(h).some((r) => r.snapshot.includes("秘密の趣味"))).toBe(
			false,
		);
	}
});

test("a forget re-applied by recovery purges windows and records the immediate change", async () => {
	const h = await setup();
	const item = await h.remember("秘密の趣味が好き");
	await h.read();
	await h.store.write((db) => db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
	const backup = join(h.dir, "backup.sqlite3");
	copyFileSync(join(h.dir, "db.sqlite3"), backup);
	await h.forget(item.id);
	await h.store.close();
	// The old database (with the rendered window) comes back; the journal wins.
	copyFileSync(backup, join(h.dir, "db.sqlite3"));
	const store = openStore(join(h.dir, "db.sqlite3"), MIGRATIONS);
	cleanups.push(() => store.close());
	const memory = createMemoryService(
		store,
		createConversationService(store),
		createContinuityService(store),
		{ journalPath: join(h.dir, "journal.jsonl") },
	);
	expect(await memory.recover()).toMatchObject({ healthy: true, reapplied: 1 });
	const rows = store.read(
		(db) =>
			db.query("SELECT snapshot FROM memory_context_window").all() as {
				snapshot: string;
			}[],
	);
	expect(rows).toEqual([]);
	const kinds = store.read(
		(db) =>
			db.query("SELECT kind FROM memory_immediate_change").all() as {
				kind: string;
			}[],
	);
	expect(kinds.map((k) => k.kind)).toContain("state_forget");
});

test("a validity boundary crossed by time refreshes the layers without waiting for the date to change", async () => {
	const h = await setup();
	// The local date of these instants does not change in UTC+9 between the first and the last of them.
	h.time.now = "2026-10-13T16:00:00.000Z";
	// "Through the 13th" ends at 2026-10-14T00:00:00Z; "from the 15th" starts at 2026-10-15T00:00:00Z.
	const until = Date.parse("2026-10-14T00:00:00.000Z");
	const from = Date.parse("2026-10-15T00:00:00.000Z");
	const add = (key: string, text: string, period: object) =>
		h.save({
			conversationId: "c1",
			messageId: "m1",
			quote: "コーヒーが好き",
			kind: "preference",
			semanticKey: key,
			text,
			...period,
		});
	await add("ending", "終わる習慣", { validUntil: "2026-10-13" });
	await add("starting", "始まる習慣", { validFrom: "2026-10-15" });
	const early = must(await h.read());
	expect(shown(early)).toContain("終わる習慣");
	expect(shown(early)).not.toContain("始まる習慣");
	expect(early.nextBoundaryMs).toBe(until);
	// Still before the first boundary: nothing is rebuilt.
	h.time.now = "2026-10-13T23:59:00.000Z";
	expect(must(await h.read()).version).toBe(early.version);
	h.time.now = "2026-10-14T00:00:00.000Z";
	const ended = must(await h.read());
	expect(ended.version).toBeGreaterThan(early.version);
	expect(shown(ended)).not.toContain("終わる習慣");
	expect(ended.nextBoundaryMs).toBe(from);
	h.time.now = "2026-10-15T00:00:00.000Z";
	const started = must(await h.read());
	expect(shown(started)).toContain("始まる習慣");
	expect(started.nextBoundaryMs).toBeNull();
	expect(must(await h.read()).version).toBe(started.version);
});

test("an unhealthy memory fails validation as unavailable", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-unhealthy-"));
	const store = openStore(join(dir, "db.sqlite3"), MIGRATIONS);
	cleanups.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	// recover() was never run: healthy is false.
	const memory = createMemoryService(
		store,
		createConversationService(store),
		createContinuityService(store),
		{ journalPath: join(dir, "journal.jsonl") },
	);
	const prepared = {
		conversationId: "c1",
		version: 1,
		buildId: "b",
		immediateSeq: 0,
		policyRevision: "1",
		manifest: [],
		pins: [],
		prefetchTokens: 0,
		noticeIds: [],
		shownMessageIds: [],
	};
	expect(
		store.read((db) => memory.validateWindowInTransaction(db, "r", prepared)),
	).toEqual({ ok: false, reason: "memory_unavailable" });
	expect(
		await store.write((db) => memory.windowForRunInTransaction(db, "c1")),
	).toBeNull();
});
