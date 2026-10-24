import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogging } from "../../../infrastructure/logger";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { createConversationService } from "../../conversation";
import { type ContinuityKind, createContinuityService } from "../../continuity";
import { createMemoryService } from "..";
import { memoryTestMigrations, saveItem } from "./memory.fixture";
import {
	REFERENCE_WINDOW_TOKENS,
	planWindow,
} from "../../../infrastructure/context-budget";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(stateBudget?: number) {
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
		...(stateBudget
			? {
					windowPlan: () => {
						const plan = planWindow({
							window: REFERENCE_WINDOW_TOKENS,
							fixed: 0,
						});
						return {
							...plan,
							sections: { ...plan.sections, state: stateBudget },
						};
					},
				}
			: {}),
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
	// The notes come from a message of their own, so forgetting what the items stand on leaves them.
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
	/** A short-term note through the steward's save contract; a refusal throws its reason. */
	const note = async (input: { kind: ContinuityKind; text: string }) => {
		const [result] = await store.write((db) =>
			memory.applyCurationInTransaction(db, {
				conversationId: "c1",
				items: [{ op: "note_add", ...input, messageIds: ["m-note"] }],
			}),
		);
		if (result?.status !== "applied")
			throw new Error(result?.status === "rejected" ? result.reason : "failed");
		return { id: must(result.id), revision: must(result.revision) };
	};
	const closeNote = async (id: string, revision: number) => {
		const [result] = await store.write((db) =>
			memory.applyCurationInTransaction(db, {
				conversationId: "c1",
				items: [{ op: "note_close", noteId: id, revision, status: "resolved" }],
			}),
		);
		return result?.status === "applied";
	};
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
		note,
		closeNote,
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

test("the memory tool's query matches a natural Japanese sentence by character pairs", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	await h.remember("毎朝走っている", "habit", "毎朝走って");
	const find = (query: string, itemIds: string[] = []) =>
		must(
			h.store.read((db) =>
				h.memory.readItemsInTransaction(db, {
					query,
					itemIds,
					shown: new Set(),
					limit: 10,
				}),
			),
		);
	const texts = (rows: Array<Record<string, unknown>>) =>
		rows.map((row) => row.text);
	expect(texts(find("私はコーヒーが好きでしたっけ"))).toEqual([
		"コーヒーが好き",
	]);
	expect(texts(find("毎朝走ってる？"))).toEqual(["毎朝走っている"]);
	expect(find("全く関係のない話")).toEqual([]);
	expect(find("")).toEqual([]);
	const [first] = find("コーヒー");
	expect(texts(find("", [String(first!.id)]))).toEqual(["コーヒーが好き"]);
});

test("a rolled-back rebuild is discarded: the next read uses the committed row", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	const committed = must(await h.read());
	await expect(
		h.store.write((db) => {
			h.memory.windows.rebuildInTransaction(db, "c1", {
				republish: true,
				addNotices: ["rolled back"],
			});
			throw new Error("abort");
		}),
	).rejects.toThrow("abort");
	const next = must(await h.read());
	expect(next.buildId).toBe(committed.buildId);
	expect(next.version).toBe(committed.version);
	expect(next.notices).toEqual([]);
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
	// A pinned message whose text no longer matches expires the run.
	const pinned = {
		...prepared,
		pins: [{ messageId: "m1", digest: "0".repeat(64) }],
	};
	expect(await validate("run-1", pinned)).toEqual({
		ok: false,
		reason: "memory_stale",
	});
	expect(
		await h.store.read((db) =>
			h.memory.validateWindowInTransaction(db, "run-1", prepared, [
				{ messageId: "missing", digest: "x" },
			]),
		),
	).toEqual({ ok: false, reason: "memory_stale" });
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

test("usage receipts and notices: adoption records the window; the notice is shown once", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	await h.store.write((db) => {
		h.memory.windows.rebuildInTransaction(db, "c1", {
			republish: false,
			addNotices: ["保存できませんでした"],
		});
	});
	const window = must(await h.read());
	expect(window.notices.map((n) => n.text)).toEqual(["保存できませんでした"]);
	const prepared = h.memory.preparedWindow(window);
	await h.store.write((db) => {
		h.memory.recordUsageInTransaction(db, "run-1", "c1", prepared);
		h.memory.clearNoticesInTransaction(db, "c1", prepared.noticeIds);
	});
	const receipt = h.memory.usage("run-1");
	expect(receipt).toMatchObject({
		viewDigest: `window:${window.version}:${window.buildId}`,
		stateRevision: String(window.inputs.immediateSeq),
		viewSchema: 3,
	});
	expect(receipt?.itemIds).toEqual(window.profile.items.map((item) => item.id));
	expect(must(await h.read()).notices).toEqual([]);
	// No notices to clear is a no-op (no new version).
	const version = must(await h.read()).version;
	await h.store.write((db) => h.memory.clearNoticesInTransaction(db, "c1", []));
	expect(must(await h.read()).version).toBe(version);
});

test("the continuity guard limits the short-term notes to the state section of the window plan", async () => {
	// A state section of 4k tokens; each note is about 500 tokens.
	const h = await setup(4000);
	let count = 0;
	let error: unknown;
	try {
		for (; count < 30; count++)
			await h.note({
				kind: "goal",
				text: `${count}`.padStart(3, "0") + "う".repeat(497),
			});
	} catch (caught) {
		error = caught;
	}
	expect((error as Error).message).toBe("limit_reached");
	expect(count).toBeGreaterThan(3);
	expect(count).toBeLessThan(9);
	// The refused addition rolled back with it.
	expect(h.continuity.list("c1")).toHaveLength(count);
});

test("S0-3: expired items do not count toward the active-item limit", async () => {
	const h = await setup();
	// Through the 19th, inclusive: expired from 2026-10-20T00:00:00Z.
	const until: string | null = "2026-10-19";
	const add = (key: string, validUntil: string | null = until) =>
		h.save({
			conversationId: "c1",
			messageId: "m1",
			quote: "コーヒーが好き",
			kind: "preference",
			semanticKey: key,
			text: `項目 ${key}`,
			...(validUntil === null ? {} : { validUntil }),
		});
	for (let i = 0; i < 100; i++) await add(`k${i}`);
	await expect(add("over", null)).rejects.toThrow("limit_reached");
	// Replacing a fact under the same key is still allowed at the limit.
	await add("k0");
	h.time.now = "2026-10-21T00:00:00.000Z";
	await add("over", null);
	// Expired items stay stored (status unchanged) but are not rendered.
	expect(h.memory.list()).toHaveLength(101);
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

test("clearing notices is a light edit: no re-render, tolerant of a missing window; a long notice is kept whole", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	await h.store.write((db) => {
		h.memory.windows.rebuildInTransaction(db, "c1", {
			republish: true,
			addNotices: ["あ".repeat(500), "二つ目"],
		});
	});
	const window = must(await h.read());
	expect([...window.notices[0]!.text]).toHaveLength(500);
	await h.store.write((db) =>
		h.memory.clearNoticesInTransaction(db, "c1", [window.notices[0]!.id]),
	);
	const after = must(await h.read());
	expect(after.version).toBe(window.version + 1);
	expect(after.notices.map((n) => n.text)).toEqual(["二つ目"]);
	expect(after.profile).toEqual(window.profile);
	// Unknown ids and a purged window do not throw and do not bump the version.
	await h.store.write((db) =>
		h.memory.clearNoticesInTransaction(db, "c1", ["unknown"]),
	);
	expect(must(await h.read()).version).toBe(after.version);
	await h.store.write((db) => {
		h.memory.windows.purgeInTransaction(db);
		h.memory.clearNoticesInTransaction(db, "c1", ["x"]);
	});
	expect(windowRows(h)).toEqual([]);
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
