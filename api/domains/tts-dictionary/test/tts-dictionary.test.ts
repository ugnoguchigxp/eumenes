import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openStore } from "../../../infrastructure/sqlite";
import { createTtsDictionary, migration, registerTtsDictionary } from "..";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanup.splice(0)) await c();
});
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "tts-dict-"));
	const store = openStore(join(dir, "db.sqlite3"), [migration]);
	cleanup.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return createTtsDictionary(store);
}
test("saves, applies longest match first, and rebuilds after change", async () => {
	const d = setup();
	await d.save({
		original: null,
		entry: { written: "今日", spoken: "きょう" },
		expected: { spoken: null },
	});
	await d.save({
		original: null,
		entry: { written: "今日び", spoken: "こんにちび" },
		expected: { spoken: null },
	});
	expect(d.apply("今日は今日びだ")).toBe("きょうはこんにちびだ");
	await d.save({
		original: "今日",
		entry: { written: "今日", spoken: "こんにち" },
		expected: { spoken: "きょう" },
	});
	expect(d.apply("今日")).toBe("こんにち");
});
test("stale expectations and duplicate headwords conflict; delete is guarded", async () => {
	const d = setup();
	const add = (written: string, spoken: string) =>
		d.save({
			original: null,
			entry: { written, spoken },
			expected: { spoken: null },
		});
	await add("A", "えー");
	await expect(add("A", "びー")).rejects.toThrow("revision_conflict");
	await expect(
		d.delete({ written: "A", expected: { spoken: "x" } }),
	).rejects.toThrow("revision_conflict");
	expect(
		(await d.delete({ written: "A", expected: { spoken: "えー" } })).length,
	).toBe(0);
	expect(
		(await d.delete({ written: "A", expected: { spoken: "x" } })).length,
	).toBe(0);
});
test("HTTP validation rejects malformed entries", async () => {
	const app = new Hono();
	registerTtsDictionary(app, setup());
	const post = (path: string, body: unknown) =>
		app.request(path, { method: "POST", body: JSON.stringify(body) });
	expect(
		(
			await post("/api/tts-dictionary/save", {
				original: null,
				entry: { written: " x", spoken: "y" },
				expected: { spoken: null },
			})
		).status,
	).toBe(400);
	const ok = await post("/api/tts-dictionary/save", {
		original: null,
		entry: { written: "x", spoken: "y" },
		expected: { spoken: null },
	});
	expect(ok.status).toBe(200);
	expect(await (await app.request("/api/tts-dictionary")).json()).toEqual({
		entries: [{ written: "x", spoken: "y" }],
	});
});
const add = (d: ReturnType<typeof setup>, written: string, spoken: string) =>
	d.save({
		original: null,
		entry: { written, spoken },
		expected: { spoken: null },
	});
test("Latin headwords match whole words only; surrogate pairs and CJK still match", async () => {
	const d = setup();
	await add(d, "AI", "エーアイ");
	await add(d, "😀", "えがお");
	expect(d.apply("MAIN と AI と AIs")).toBe("MAIN と エーアイ と AIs");
	expect(d.apply("a😀b")).toBe("aえがおb");
});
test("a reading that would empty or inflate the chunk keeps the original text", async () => {
	const d = setup();
	await add(d, "(笑)", "");
	await add(d, "長", "あ".repeat(400));
	expect(d.apply("(笑)")).toBe("(笑)");
	expect(d.apply("こんにちは(笑)")).toBe("こんにちは");
	expect(d.apply("長".repeat(11))).toBe("長".repeat(11));
});
test("rename moves the row atomically and refuses stale or conflicting renames", async () => {
	const d = setup();
	await add(d, "A", "えー");
	await add(d, "B", "びー");
	await expect(
		d.save({
			original: "A",
			entry: { written: "B", spoken: "x" },
			expected: { spoken: "えー" },
		}),
	).rejects.toThrow("revision_conflict");
	await expect(
		d.save({
			original: "A",
			entry: { written: "C", spoken: "しー" },
			expected: { spoken: "stale" },
		}),
	).rejects.toThrow("revision_conflict");
	const entries = await d.save({
		original: "A",
		entry: { written: "C", spoken: "しー" },
		expected: { spoken: "えー" },
	});
	expect(entries.map((e) => e.written)).toEqual(["B", "C"]);
});
test("HTTP rejects boundary headwords, normalizes to NFC, and deletes", async () => {
	const app = new Hono();
	registerTtsDictionary(app, setup());
	const post = (path: string, body: unknown) =>
		app.request(path, { method: "POST", body: JSON.stringify(body) });
	const save = (written: string, spoken: string) =>
		post("/api/tts-dictionary/save", {
			original: null,
			entry: { written, spoken },
			expected: { spoken: null },
		});
	expect((await save("Node.js", "ノード")).status).toBe(400);
	expect((await save("\ud800", "x")).status).toBe(400);
	expect((await save("が".normalize("NFD"), "が")).status).toBe(200);
	const removed = await post("/api/tts-dictionary/delete", {
		written: "が",
		expected: { spoken: "が" },
	});
	expect(await removed.json()).toEqual({ entries: [] });
});
