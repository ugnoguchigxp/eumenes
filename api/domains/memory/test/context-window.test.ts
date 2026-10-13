import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations as memoryPackageMigrations } from "eumenes-memory/sqlite";
import { configureLogging } from "../../../infrastructure/logger";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	migration as conversationMigration,
	avatarMotionMigration,
	answerDeliveryMigration,
	createConversationService,
} from "../../conversation";
import {
	createContinuityService,
	migration as continuityMigration,
	shortTermMigration,
} from "../../continuity";
import {
	agentHardeningMigration,
	turnVectorsMigration,
	contextWindowMigration,
	createMemoryService,
	migration,
} from "..";
import {
	LONG_TERM_BYTES,
	renderLongTerm,
	renderShortTerm,
	SHORT_TERM_BYTES,
	type StateLine,
} from "../service/context-render";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-window-"));
	const store: SqliteStore = openStore(join(dir, "db.sqlite3"), [
		conversationMigration,
		avatarMotionMigration,
		answerDeliveryMigration,
		continuityMigration,
		shortTermMigration,
		migration,
		contextWindowMigration,
		agentHardeningMigration,
		turnVectorsMigration,
		...memoryPackageMigrations,
	]);
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
	let n = 0;
	const remember = (
		text: string,
		kind: "preference" | "habit" = "preference",
		quote = "コーヒーが好き",
	) =>
		memory.remember({
			conversationId: "c1",
			messageId: "m1",
			quote,
			kind,
			semanticKey: `key-${++n}`,
			text,
			polarity: "affirmed",
		});
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
		read,
	};
}
const must = <T>(value: T | null | undefined): T => {
	if (value == null) throw new Error("expected_value");
	return value;
};

test("the first read builds a snapshot and an unchanged input returns the same version and strings", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	const first = must(await h.read());
	expect(first.version).toBe(1);
	expect(first.longTerm.text).toContain("- 好み: コーヒーが好き");
	expect(
		first.longTerm.text.startsWith("以下は本人について保存された参照情報です"),
	).toBe(true);
	const second = must(await h.read());
	expect(second.version).toBe(1);
	expect(second.buildId).toBe(first.buildId);
	expect(second.longTerm.text).toBe(first.longTerm.text);
	expect(second.shortTerm.text).toBe(first.shortTerm.text);
});

test("an empty memory renders no layers and is not treated as unavailable", async () => {
	const h = await setup();
	const window = must(await h.read());
	expect(window.longTerm.text).toBe("");
	expect(window.shortTerm.text).toBe("");
	await h.memory.setEnabled(false);
	expect(await h.read()).toBeNull();
});

test("a new registration reaches the short-term layer only; the fifth republishes the long-term layer", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	const base = must(await h.read());
	await h.remember("毎朝走っている", "habit", "毎朝走って");
	const added = must(await h.read());
	expect(added.version).toBe(base.version + 1);
	expect(added.longTerm.text).toBe(base.longTerm.text);
	expect(added.shortTerm.text).toContain("最近覚えたこと");
	expect(added.shortTerm.text).toContain("毎朝走っている");
	expect(added.shortTerm.pendingAdditions).toBe(1);
	for (const text of ["二", "三", "四"]) await h.remember(`${text}番目`);
	const four = must(await h.read());
	expect(four.longTerm.text).toBe(base.longTerm.text);
	expect(four.shortTerm.pendingAdditions).toBe(4);
	await h.remember("五番目");
	const five = must(await h.read());
	expect(five.longTerm.text).not.toBe(base.longTerm.text);
	for (const text of ["毎朝走っている", "二番目", "五番目"])
		expect(five.longTerm.text).toContain(text);
	expect(five.shortTerm.pendingAdditions).toBe(0);
	expect(five.shortTerm.text).toBe("");
});

test("the long-term layer is republished when the local date changes", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	const day1 = must(await h.read());
	expect(day1.longTerm.publishedOn).toBe("2026-10-13");
	h.time.now = "2026-10-13T13:00:00.000Z";
	expect(must(await h.read()).version).toBe(day1.version);
	h.time.now = "2026-10-15T12:00:00.000Z";
	const day2 = must(await h.read());
	expect(day2.version).toBe(day1.version + 1);
	expect(day2.longTerm.publishedOn).toBe("2026-10-15");
	expect(day2.longTerm.text).toBe(day1.longTerm.text);
});

test("a continuity addition appears in the short-term layer and leaves the long-term text alone", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	const base = must(await h.read());
	await h.continuity.add("c1", { kind: "goal", text: "Rustへ移行する" });
	const next = must(await h.read());
	expect(next.longTerm.text).toBe(base.longTerm.text);
	expect(next.shortTerm.text).toContain("目的");
	expect(next.shortTerm.text).toContain("- Rustへ移行する");
	// Another conversation has its own continuity.
	expect(must(await h.read("c2")).shortTerm.text).toBe("");
});

test("stop, retract, forget, the ON/OFF setting and the user closing a continuity item rebuild the long-term layer", async () => {
	const h = await setup();
	const a = await h.remember("コーヒーが好き");
	const b = await h.remember("毎朝走っている", "habit", "毎朝走って");
	const c = await h.remember("三つ目の事実");
	await h.remember("四つ目の事実");
	const goal = await h.continuity.add("c1", { kind: "goal", text: "目標" });
	let window = must(await h.read());
	expect(window.longTerm.text).toContain("コーヒーが好き");
	const seen = async () => {
		const next = must(await h.read());
		// A purge (forget) restarts the numbering: the build id is what always changes.
		expect(next.buildId).not.toBe(window.buildId);
		window = next;
		return next;
	};
	await h.memory.stop(a.id, a.revision);
	expect((await seen()).longTerm.text).not.toContain("コーヒーが好き");
	await h.memory.retract(b.id, b.revision);
	expect((await seen()).longTerm.text).not.toContain("毎朝走っている");
	await h.memory.forget(c.id);
	expect((await seen()).longTerm.text).not.toContain("三つ目の事実");
	const before = window.inputs.policyRevision;
	await h.memory.setEnabled(false);
	await h.memory.setEnabled(true);
	expect((await seen()).inputs.policyRevision).not.toBe(before);
	// Toggling to the same value is not a change.
	await h.memory.setEnabled(true);
	expect(must(await h.read()).version).toBe(window.version);
	const seq = (await h.read())!.inputs.immediateSeq;
	await h.continuity.transition(goal.id, {
		expectedRevision: 1,
		status: "resolved",
	});
	const closed = await seen();
	expect(closed.inputs.immediateSeq).toBeGreaterThan(seq);
	expect(closed.shortTerm.text).toBe("");
	expect(closed.longTerm.text).toContain("四つ目の事実");
});

test("replacing or denying a value is immediate; a plain addition and resuming are not", async () => {
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
	const stopped = await h.memory.stop(first.id, first.revision);
	expect(await seq()).toBe(start + 1);
	await h.memory.resume(first.id, stopped.revision);
	expect(await seq()).toBe(start + 1);
	await h.memory.remember({
		conversationId: "c1",
		messageId: "m1",
		quote: "コーヒーが好き",
		kind: "preference",
		semanticKey: "negated-key",
		text: "辛い物が好き",
		polarity: "negated",
	});
	expect(await seq()).toBe(start + 2);
	const window = must(await h.read());
	expect(window.longTerm.text).toContain("「辛い物が好き」ではない");
});

test("a rolled-back rebuild is discarded: the next read uses the committed row", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	const committed = must(await h.read());
	await expect(
		h.store.write((db) => {
			h.memory.windows.rebuildInTransaction(db, "c1", {
				refreshLongTerm: true,
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

test("the same inputs always render the same strings", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	await h.remember("毎朝走っている", "habit", "毎朝走って");
	await h.continuity.add("c1", { kind: "decision", text: "週に3回走る" });
	const one = await h.store.write((db) =>
		h.memory.windows.rebuildInTransaction(db, "c1", { refreshLongTerm: true }),
	);
	const two = await h.store.write((db) =>
		h.memory.windows.rebuildInTransaction(db, "c1", { refreshLongTerm: true }),
	);
	expect(two.version).toBe(one.version + 1);
	expect(two.longTerm.text).toBe(one.longTerm.text);
	expect(two.shortTerm.text).toBe(one.shortTerm.text);
});

test("an expired period is not rendered; a stated period is", async () => {
	const h = await setup();
	await h.memory.remember({
		conversationId: "c1",
		messageId: "m1",
		quote: "コーヒーが好き",
		kind: "preference",
		semanticKey: "coffee",
		text: "コーヒーが好き",
		polarity: "affirmed",
		validity: {
			from: { precision: "month", year: 2026, month: 9 },
			basis: "stated",
		},
	});
	await h.memory.remember({
		conversationId: "c1",
		messageId: "m1",
		quote: "毎朝走って",
		kind: "habit",
		semanticKey: "old",
		text: "昔の習慣",
		polarity: "affirmed",
		validity: {
			until: { precision: "year", year: 2020 },
			basis: "stated",
		},
	});
	const window = must(await h.read());
	expect(window.longTerm.text).toContain(
		"- 好み: コーヒーが好き（2026年9月から）",
	);
	expect(window.longTerm.text).not.toContain("昔の習慣");
	expect(window.shortTerm.text).not.toContain("昔の習慣");
});

test("over budget the long-term layer keeps constraints first and logs only the count", async () => {
	const lines: string[] = [];
	configureLogging({
		level: "info",
		destination: { write: (l) => void lines.push(l) },
	});
	const line = (kind: string, i: number, order: number): StateLine => ({
		itemId: `state:${kind}${i}`,
		revision: 1,
		kind,
		text: `${kind}-${i}-` + "あ".repeat(1500),
		negated: false,
		period: "",
		order,
	});
	const states = [
		...Array.from({ length: 8 }, (_, i) => line("habit", i, i)),
		...Array.from({ length: 8 }, (_, i) => line("preference", i, 100 + i)),
		line("constraint", 0, 1),
	];
	const rendered = renderLongTerm(states, [
		{ id: "t1", revision: 1, text: "傾向", order: "2026-10-01" },
	]);
	expect(rendered.bytes).toBeLessThanOrEqual(LONG_TERM_BYTES);
	expect(rendered.text).toContain("constraint-0-");
	// Newest preferences before older ones; habits after preferences.
	expect(rendered.text).toContain("preference-7-");
	expect(rendered.text).not.toContain("habit-0-");
	expect(rendered.omitted.length).toBeGreaterThan(0);
	expect(rendered.manifest.length + rendered.omitted.length).toBe(
		states.length + 1,
	);
	const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
	const trimmed = logged.find((l) => l.event === "memory.long_term_trimmed");
	expect(trimmed?.omitted).toBe(rendered.omitted.length);
	expect(JSON.stringify(logged)).not.toContain("あああ");
});

test("over budget the short-term layer keeps recent additions, then open questions first, and counts what it left out", () => {
	const note = (kind: string, i: number) => ({
		id: `${kind}${i}`,
		kind,
		text: `${kind}-${i}-` + "い".repeat(1000),
		order: `2026-10-0${i + 1}`,
	});
	const notes = [
		...Array.from({ length: 4 }, (_, i) => note("memo", i)),
		...Array.from({ length: 4 }, (_, i) => note("open_question", i)),
		...Array.from({ length: 4 }, (_, i) => note("goal", i)),
	];
	const recent: StateLine[] = Array.from({ length: 6 }, (_, i) => ({
		itemId: `state:r${i}`,
		revision: 1,
		kind: "preference",
		text: `recent-${i}`,
		negated: false,
		period: "",
		order: i,
	}));
	const rendered = renderShortTerm(recent, notes);
	expect(rendered.bytes).toBeLessThanOrEqual(SHORT_TERM_BYTES);
	expect(rendered.fullBytes).toBeGreaterThan(SHORT_TERM_BYTES);
	expect(rendered.pendingAdditions).toBe(6);
	expect(rendered.omitted).toBeGreaterThan(0);
	for (let i = 0; i < 6; i++) expect(rendered.text).toContain(`recent-${i}`);
	expect(rendered.text).toContain("open_question-3-");
	expect(rendered.text).not.toContain("memo-0-");
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
	await h.continuity.add("c1", { kind: "goal", text: "目標" });
	expect(await validate()).toEqual({ ok: true });
	// A change attributed to the run itself is not a reason to expire it; anyone else's is.
	await h.store.write((db) =>
		h.memory.windows.recordImmediateInTransaction(db, "state_replace", "run-1"),
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
	await h.memory.stop(item.id, item.revision);
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
			refreshLongTerm: false,
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
	expect(receipt?.itemIds).toEqual(
		window.longTerm.manifest.map((m) => m.itemId),
	);
	expect(must(await h.read()).notices).toEqual([]);
	// No notices to clear is a no-op (no new version).
	const version = must(await h.read()).version;
	await h.store.write((db) => h.memory.clearNoticesInTransaction(db, "c1", []));
	expect(must(await h.read()).version).toBe(version);
});

test("the continuity guard limits the short-term layer to its budget", async () => {
	const h = await setup();
	let count = 0;
	let error: unknown;
	try {
		for (; count < 30; count++)
			await h.continuity.add("c1", {
				kind: "goal",
				text: `${count}`.padStart(3, "0") + "う".repeat(497),
			});
	} catch (caught) {
		error = caught;
	}
	expect((error as Error).message).toBe("invalid_continuity_limit");
	expect(count).toBeGreaterThan(3);
	expect(count).toBeLessThan(10);
	// The refused addition rolled back with it.
	expect(h.continuity.list("c1")).toHaveLength(count);
});

test("S0-3: expired items do not count toward the active-item limit", async () => {
	const h = await setup();
	const until = Date.parse("2026-10-20T00:00:00.000Z");
	const add = (key: string, validUntilMs: number | null = until) =>
		h.memory.remember({
			conversationId: "c1",
			messageId: "m1",
			quote: "コーヒーが好き",
			kind: "preference",
			semanticKey: key,
			text: `項目 ${key}`,
			polarity: "affirmed",
			...(validUntilMs === null ? {} : { validUntilMs }),
		});
	for (let i = 0; i < 100; i++) await add(`k${i}`);
	await expect(add("over", null)).rejects.toThrow("invalid_memory_limit");
	// Replacing a fact under the same key is still allowed at the limit.
	await add("k0");
	h.time.now = "2026-10-21T00:00:00.000Z";
	await add("over", null);
	// Expired items stay stored (status unchanged) but are not rendered.
	expect(h.memory.list()).toHaveLength(101);
	const window = must(await h.read());
	expect(window.longTerm.text).toContain("項目 over");
	expect(window.longTerm.text).not.toContain("項目 k1\n");
});

const MIGRATIONS = [
	conversationMigration,
	avatarMotionMigration,
	answerDeliveryMigration,
	continuityMigration,
	shortTermMigration,
	migration,
	contextWindowMigration,
	agentHardeningMigration,
	turnVectorsMigration,
	...memoryPackageMigrations,
];
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
		await h.memory.forget(item.id);
		expect(windowRows(h)).toEqual([]);
		// The next read builds from State again and does not bring the value back.
		if (off) await h.memory.setEnabled(true);
		const next = must(await h.read());
		expect(next.longTerm.text + next.shortTerm.text).not.toContain(
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
	await h.memory.forget(item.id);
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
	h.time.now = "2026-10-13T00:00:00.000Z";
	const until = Date.parse("2026-10-13T06:00:00.000Z");
	const from = Date.parse("2026-10-13T09:00:00.000Z");
	const add = (key: string, text: string, period: object) =>
		h.memory.remember({
			conversationId: "c1",
			messageId: "m1",
			quote: "コーヒーが好き",
			kind: "preference",
			semanticKey: key,
			text,
			polarity: "affirmed",
			...period,
		});
	await add("ending", "終わる習慣", { validUntilMs: until });
	await add("starting", "始まる習慣", { validFromMs: from });
	const early = must(await h.read());
	expect(early.longTerm.text).toContain("終わる習慣");
	expect(early.longTerm.text).not.toContain("始まる習慣");
	expect(early.nextBoundaryMs).toBe(until);
	// Still before the first boundary: nothing is rebuilt.
	h.time.now = "2026-10-13T05:59:00.000Z";
	expect(must(await h.read()).version).toBe(early.version);
	h.time.now = "2026-10-13T06:00:00.000Z";
	const ended = must(await h.read());
	expect(ended.version).toBeGreaterThan(early.version);
	expect(ended.longTerm.text).not.toContain("終わる習慣");
	expect(ended.nextBoundaryMs).toBe(from);
	h.time.now = "2026-10-13T09:00:00.000Z";
	const started = must(await h.read());
	expect(started.longTerm.text).toContain("始まる習慣");
	expect(started.nextBoundaryMs).toBeNull();
	expect(must(await h.read()).version).toBe(started.version);
});

test("clearing notices is a light edit: no re-render, tolerant of a missing window; notice text is capped", async () => {
	const h = await setup();
	await h.remember("コーヒーが好き");
	await h.store.write((db) => {
		h.memory.windows.rebuildInTransaction(db, "c1", {
			refreshLongTerm: true,
			addNotices: ["あ".repeat(500), "二つ目"],
		});
	});
	const window = must(await h.read());
	expect([...window.notices[0]!.text]).toHaveLength(200);
	await h.store.write((db) =>
		h.memory.clearNoticesInTransaction(db, "c1", [window.notices[0]!.id]),
	);
	const after = must(await h.read());
	expect(after.version).toBe(window.version + 1);
	expect(after.notices.map((n) => n.text)).toEqual(["二つ目"]);
	expect(after.longTerm).toEqual(window.longTerm);
	expect(after.shortTerm).toEqual(window.shortTerm);
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
		prefetchBytes: 0,
		noticeIds: [],
		windowStartOrdinal: 0,
	};
	expect(
		store.read((db) => memory.validateWindowInTransaction(db, "r", prepared)),
	).toEqual({ ok: false, reason: "memory_unavailable" });
	expect(
		await store.write((db) => memory.windowForRunInTransaction(db, "c1")),
	).toBeNull();
});
