/**
 * The World assembly on its own: mode flag, the host-owned cursor secret,
 * enabling rules, quiet idle polling and the cursor-secret reset path.
 * Real temp-file store and production migrations; no model, no network.
 */
import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContinuityService } from "../domains/continuity";
import { createConversationService } from "../domains/conversation";
import { createMemoryService } from "../domains/memory";
import { openStore } from "../infrastructure/sqlite";
import { migrations } from "./migrations";
import {
	createWorldAssembly,
	defaultWorldJournalPath,
	resolveWorldCursorSecret,
	worldModeFromEnv,
	type WorldAssembly,
} from "./world";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-asm-"));
	dirs.push(dir);
	return dir;
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function assemble(
	dir: string,
	mode: "on" | "protect",
	cursorSecret?: string,
) {
	const dbPath = join(dir, "db.sqlite3");
	const store = openStore(dbPath, migrations);
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const memoryJournalPath = join(dir, "memory-forget-journal.jsonl");
	const memory = createMemoryService(
		store,
		conversation,
		createContinuityService(store),
		{ journalPath: memoryJournalPath },
	);
	const world: WorldAssembly = createWorldAssembly({
		store,
		conversation,
		memory,
		mode,
		journalPath: defaultWorldJournalPath(memoryJournalPath),
		cursorSecret: cursorSecret ?? resolveWorldCursorSecret({ dbPath, env: {} }),
		debounceMs: 20,
		pollMs: 60_000,
	});
	const recovery = await memory.recover();
	await world.recover({
		feedResyncRequired: recovery.feedResyncRequired === true,
	});
	closers.push(async () => {
		await world.close();
		await store.close().catch(() => {});
	});
	return {
		dbPath,
		store,
		conversation,
		memory,
		world,
		async close() {
			await world.close();
			await store.close();
			closers.length = 0;
		},
	};
}

test("mode flag: unset/off/0 mean nothing is assembled; protect and on are explicit; a typo fails startup", () => {
	for (const value of [undefined, "", "off", "OFF", "0", "false"])
		expect(worldModeFromEnv({ EUMENES_WORLD: value })).toBe("off");
	expect(worldModeFromEnv({})).toBe("off");
	expect(worldModeFromEnv({ EUMENES_WORLD: "protect" })).toBe("protect");
	for (const value of ["on", "ON", "1", "true"])
		expect(worldModeFromEnv({ EUMENES_WORLD: value })).toBe("on");
	for (const value of ["onn", "enabled", "2", "protected"])
		expect(() => worldModeFromEnv({ EUMENES_WORLD: value })).toThrow(
			"world_mode_invalid",
		);
});

test("cursor secret: host-owned file (dir 0700, file 0600), created once, stable, never from the database; env overrides; short values fail", () => {
	const dir = tempDir();
	const dbPath = join(dir, "data", "db.sqlite3");
	const file = join(dir, "data", "keys", "world-cursor.key");
	expect(existsSync(file)).toBe(false);
	const first = resolveWorldCursorSecret({ dbPath, env: {} });
	expect(first).toMatch(/^[0-9a-f]{64}$/);
	expect(statSync(file).mode & 0o777).toBe(0o600);
	expect(statSync(join(dir, "data", "keys")).mode & 0o777).toBe(0o700);
	// Stable across calls (and processes): the stored value, not a new random one.
	expect(resolveWorldCursorSecret({ dbPath, env: {} })).toBe(first);
	// A loosened file mode is tightened again.
	rmSync(file);
	writeFileSync(file, first, { mode: 0o644 });
	expect(resolveWorldCursorSecret({ dbPath, env: {} })).toBe(first);
	expect(statSync(file).mode & 0o777).toBe(0o600);
	// The environment wins; a short one is refused rather than used.
	const env = "e".repeat(40);
	expect(
		resolveWorldCursorSecret({
			dbPath,
			env: { EUMENES_WORLD_CURSOR_SECRET: env },
		}),
	).toBe(env);
	expect(() =>
		resolveWorldCursorSecret({
			dbPath,
			env: { EUMENES_WORLD_CURSOR_SECRET: "short" },
		}),
	).toThrow("world_cursor_secret_invalid");
	// A damaged file fails startup; it is never silently replaced (that would void every cursor).
	writeFileSync(file, "short", { mode: 0o600 });
	expect(() => resolveWorldCursorSecret({ dbPath, env: {} })).toThrow(
		"world_cursor_secret_invalid",
	);
	expect(readFileSync(file, "utf8")).toBe("short");
});

test("cursor secret: keyDir moves the key out of the db dir and keeps the old key's value", () => {
	const dir = tempDir();
	const dbPath = join(dir, "data", "db.sqlite3");
	const legacy = join(dir, "data", "keys", "world-cursor.key");
	const keyDir = join(dir, "elsewhere");
	// (a) A fresh install with keyDir creates the key there and not beside the db.
	const created = resolveWorldCursorSecret({ dbPath, keyDir, env: {} });
	expect(existsSync(join(keyDir, "world-cursor.key"))).toBe(true);
	expect(existsSync(legacy)).toBe(false);
	expect(statSync(join(keyDir, "world-cursor.key")).mode & 0o777).toBe(0o600);
	expect(resolveWorldCursorSecret({ dbPath, keyDir, env: {} })).toBe(created);
	// (b) An existing key beside the db is copied (not moved) so stored cursors stay valid.
	const dir2 = tempDir();
	const dbPath2 = join(dir2, "data", "db.sqlite3");
	const legacy2 = join(dir2, "data", "keys", "world-cursor.key");
	const old = resolveWorldCursorSecret({ dbPath: dbPath2, env: {} });
	const keyDir2 = join(dir2, "moved");
	expect(
		resolveWorldCursorSecret({ dbPath: dbPath2, keyDir: keyDir2, env: {} }),
	).toBe(old);
	expect(readFileSync(join(keyDir2, "world-cursor.key"), "utf8")).toBe(old);
	expect(statSync(join(keyDir2, "world-cursor.key")).mode & 0o777).toBe(0o600);
	expect(readFileSync(legacy2, "utf8")).toBe(old);
	// (c) A blank keyDir behaves as before.
	expect(
		resolveWorldCursorSecret({ dbPath: dbPath2, keyDir: "  ", env: {} }),
	).toBe(old);
	expect(resolveWorldCursorSecret({ dbPath: dbPath2, env: {} })).toBe(old);
});

test("journal path sits next to the Memory journal", () => {
	expect(defaultWorldJournalPath("/data/x/memory-forget-journal.jsonl")).toBe(
		"/data/x/world-forget-journal.jsonl",
	);
});

test("protect: recovery opens the gate, World stays OFF, and turning it ON runs the initial sync first", async () => {
	const dir = tempDir();
	const h = await assemble(dir, "protect");
	expect(h.world.status()).toMatchObject({
		mode: "protect",
		gate: { open: true, reason: null },
		world: { enabled: false, usable: false },
		initialSyncComplete: false,
	});
	// The raw service refuses ON before the first feed pass was recorded ...
	await expect(h.world.service.setEnabled(true)).rejects.toThrow(
		"initial_sync_required",
	);
	// ... the assembly drains both feeds, records it, then enables.
	await h.conversation.append({
		id: "m1",
		conversationId: "c1",
		role: "user",
		text: "初期同期の前の発言。",
		createdAt: new Date().toISOString(),
		runId: null,
	});
	await h.conversation.retract({ messageId: "m1" });
	await h.world.setEnabled(true);
	expect(h.world.status()).toMatchObject({
		world: { enabled: true, usable: true },
		initialSyncComplete: true,
	});
	await h.world.setEnabled(false);
	expect(h.world.status().world.enabled).toBe(false);
});

test("protect forces an enabled World OFF at startup; on turns it ON once the initial sync is done", async () => {
	const dir = tempDir();
	let h = await assemble(dir, "on");
	expect(h.world.status().world.enabled).toBe(true);
	await h.close();
	h = await assemble(dir, "protect");
	expect(h.world.status().world.enabled).toBe(false);
	await h.close();
	h = await assemble(dir, "on");
	expect(h.world.status().world.enabled).toBe(true);
});

test("a closed gate (corrupt World journal) skips the passes and keeps World closed; nothing throws", async () => {
	const dir = tempDir();
	let h = await assemble(dir, "on");
	await h.close();
	// A damaged journal line, next to the Memory journal.
	writeFileSync(defaultWorldJournalPath(join(dir, "m")), "garbage\n");
	h = await assemble(dir, "on");
	expect(h.world.status().gate.open).toBe(false);
	expect(await h.world.pump()).toMatchObject({ status: "skipped" });
	expect(await h.world.pump({ full: true })).toMatchObject({
		status: "skipped",
	});
});

test("idle passes write nothing: no commit, so no change-stream traffic and no feedback loop", async () => {
	const dir = tempDir();
	const h = await assemble(dir, "on");
	let commits = 0;
	const stop = h.store.onCommit(() => {
		commits += 1;
	});
	for (let i = 0; i < 3; i++) {
		expect(await h.world.pump({ full: true })).toMatchObject({
			status: "ran",
			sourceChanges: 0,
			memoryChanges: 0,
			pendingForgets: 0,
		});
	}
	h.world.start();
	await pause(300);
	stop();
	expect(commits).toBe(0);
});

test("a retraction reaches World by commit notification alone", async () => {
	const dir = tempDir();
	const h = await assemble(dir, "on");
	h.world.start();
	await h.conversation.append({
		id: "m1",
		conversationId: "c1",
		role: "user",
		text: "忘れてほしい発言。",
		createdAt: new Date().toISOString(),
		runId: null,
	});
	await h.conversation.retract({ messageId: "m1" });
	const intakes = () =>
		h.store.read(
			(db) =>
				db.query("SELECT state FROM world_host_forget_intake").all() as {
					state: string;
				}[],
		);
	for (let i = 0; i < 300 && intakes().length === 0; i++) await pause(10);
	expect(intakes().length).toBeGreaterThan(0);
	for (let i = 0; i < 300 && intakes().some((r) => r.state !== "complete"); i++)
		await pause(10);
	expect(intakes().every((r) => r.state === "complete")).toBe(true);
});

test("a changed cursor secret does not wedge the feed: the stored cursor is reset through a restore and the feed is read again", async () => {
	const dir = tempDir();
	let h = await assemble(dir, "on", "a".repeat(40));
	await h.conversation.append({
		id: "m1",
		conversationId: "c1",
		role: "user",
		text: "最初の発言。",
		createdAt: new Date().toISOString(),
		runId: null,
	});
	expect(await h.world.pump()).toMatchObject({ status: "ran" });
	const epoch = (x: typeof h) =>
		x.store.read(
			(db) =>
				(
					db
						.query("SELECT restore_epoch FROM world_host_state WHERE id = 1")
						.get() as { restore_epoch: string }
				).restore_epoch,
		);
	const epochBefore = epoch(h);
	await h.close();
	// The host secret changed (e.g. the key file was replaced): old cursors cannot be decoded.
	h = await assemble(dir, "on", "b".repeat(40));
	expect(epoch(h)).toBe(epochBefore);
	expect(await h.world.pump()).toMatchObject({ status: "ran" });
	// The undecodable cursor was answered by a restore (new epoch), not ignored.
	expect(epoch(h)).not.toBe(epochBefore);
	await h.conversation.retract({ messageId: "m1" });
	expect(await h.world.pump()).toMatchObject({ status: "ran" });
	const intakes = h.store.read(
		(db) =>
			db.query("SELECT state FROM world_host_forget_intake").all() as {
				state: string;
			}[],
	);
	expect(intakes.length).toBeGreaterThan(0);
	expect(intakes.every((r) => r.state === "complete")).toBe(true);
});
