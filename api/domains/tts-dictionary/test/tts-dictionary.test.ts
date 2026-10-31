import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createTtsDictionary } from "..";
import { deleteSchema, saveSchema } from "../contracts";
import { migration } from "../repository";
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
	const service = createTtsDictionary(store);
	return {
		...service,
		list: () => store.read((db) => service.listInTransaction(db)),
		save: (input: Parameters<typeof service.saveInTransaction>[1]) =>
			store.write((db) => service.saveInTransaction(db, input)),
		delete: (input: Parameters<typeof service.deleteInTransaction>[1]) =>
			store.write((db) => service.deleteInTransaction(db, input)),
	};
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
test("validation rejects malformed entries", async () => {
	const d = setup();
	expect(
		saveSchema.safeParse({
			original: null,
			entry: { written: " x", spoken: "y" },
			expected: { spoken: null },
		}).success,
	).toBe(false);
	await d.save(
		saveSchema.parse({
			original: null,
			entry: { written: "x", spoken: "y" },
			expected: { spoken: null },
		}),
	);
	expect(d.list()).toEqual([{ written: "x", spoken: "y" }]);
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
test("validation rejects boundary headwords, normalizes to NFC, and deletes", async () => {
	const d = setup();
	const save = (written: string, spoken: string) =>
		saveSchema.safeParse({
			original: null,
			entry: { written, spoken },
			expected: { spoken: null },
		});
	expect(save("Node.js", "ノード").success).toBe(false);
	expect(save("\ud800", "x").success).toBe(false);
	const parsed = save("が".normalize("NFD"), "が");
	expect(parsed.success).toBe(true);
	await d.save(parsed.data!);
	const removed = await d.delete(
		deleteSchema.parse({ written: "が", expected: { spoken: "が" } }),
	);
	expect(removed).toEqual([]);
});
