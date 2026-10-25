import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { parseResourceUri, resourceRefSchema } from "../../resources";
import { createDrawingResourceAdapter } from "..";
import { migrations, saveReference } from "../repository";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanup.splice(0)) await c();
});
function setup(conversationId = "main") {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-drawing-resource-"));
	const store = openStore(join(dir, "db"), [
		{ id: "queue/0001-init", sql: "SELECT 1" },
		...migrations,
	]);
	cleanup.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const adapter = createDrawingResourceAdapter({ store, conversationId });
	/** A saved drawing and, optionally, the session that opened it (its last operation is the only time kept). */
	const drawing = (
		title: string,
		change: {
			conversationId?: string;
			at?: number | null;
			revision?: number;
		} = {},
	) =>
		store.write((db) => {
			const id = saveReference(db, change.conversationId ?? "main", {
				id: crypto.randomUUID(),
				revision: change.revision ?? 1,
				title,
			});
			if (change.at !== null)
				db.query("INSERT INTO excalidraw_sessions VALUES(?,?,?,?)").run(
					crypto.randomUUID(),
					crypto.randomUUID(),
					"{}",
					JSON.stringify({
						referenceId: id,
						lastOperation: change.at ?? Date.parse("2026-10-20T00:00:00.000Z"),
					}),
				);
			return id;
		});
	return { store, adapter, drawing };
}
const signal = new AbortController().signal;

test("a completed drawing operation maps to its reference; other states, unknown and foreign references map to nothing", async () => {
	const { store, adapter, drawing } = setup();
	const id = await drawing("構成図");
	const foreign = await drawing("他の会話", { conversationId: "other" });
	const refs = (result: unknown) =>
		store.read((db) =>
			adapter.fromResultInTransaction(db, result, { conversationId: "main" }),
		);
	const [ref] = refs({ state: "completed", referenceId: id, action: "create" });
	expect(ref).toMatchObject({
		uri: `eumenes://drawing/${id}`,
		kind: "drawing",
		label: "構成図",
		createdAt: "2026-10-20T00:00:00.000Z",
	});
	expect(resourceRefSchema.safeParse(ref).success).toBe(true);
	expect(parseResourceUri(ref!.uri)?.id).toBe(id);
	expect(refs({ state: "failed", referenceId: id })).toEqual([]);
	expect(refs({ state: "completed", referenceId: null })).toEqual([]);
	expect(refs({ state: "completed", referenceId: foreign })).toEqual([]);
	expect(refs({ state: "completed", referenceId: "nope" })).toEqual([]);
	expect(refs([])).toEqual([]);
});

test("get returns the editor target and null for an unknown or other conversation's drawing", async () => {
	const { store, adapter, drawing } = setup();
	const id = await drawing("構成図", { revision: 3 });
	const foreign = await drawing("他の会話", { conversationId: "other" });
	expect(store.read((db) => adapter.getInTransaction(db, id))).toMatchObject({
		adapterRef: "adapter:excalidraw@1",
		targetRef: id,
		actions: ["open", "read"],
		preview: "版3",
	});
	for (const missing of [foreign, "nope"])
		expect(
			store.read((db) => adapter.getInTransaction(db, missing)),
		).toBeNull();
});

test("search is newest saved first, filters by title and period; a drawing without a session reads as the epoch", async () => {
	const { adapter, drawing } = setup();
	const old = await drawing("古い構成図", {
		at: Date.parse("2026-10-01T00:00:00.000Z"),
	});
	const fresh = await drawing("新しい見取り図", {
		at: Date.parse("2026-10-20T00:00:00.000Z"),
	});
	const mid = await drawing("中くらいの構成図", {
		at: Date.parse("2026-10-10T00:00:00.000Z"),
	});
	const bare = await drawing("記録なし", { at: null });
	const ids = async (query: Parameters<typeof adapter.search>[0]) =>
		(await adapter.search(query, signal)).map(
			(r) => parseResourceUri(r.uri)!.id,
		);
	expect(await ids({ text: "", limit: 10 })).toEqual([bare, mid, fresh, old]);
	expect(await ids({ text: "構成図", limit: 10 })).toEqual([mid, old]);
	expect(await ids({ text: "", limit: 1 })).toEqual([bare]);
	expect(
		await ids({
			text: "",
			since: "2026-10-05T00:00:00.000Z",
			until: "2026-10-15T00:00:00.000Z",
			limit: 10,
		}),
	).toEqual([mid]);
	expect(
		(await adapter.search({ text: "記録なし", limit: 1 }, signal))[0]!
			.createdAt,
	).toBe("1970-01-01T00:00:00.000Z");
});

test("read states the title, version and time within the bound", async () => {
	const { adapter, drawing } = setup();
	const id = await drawing("長".repeat(500), { revision: 2 });
	const bare = await drawing("記録なし", { at: null });
	const text = (await adapter.read(id, signal)).text;
	expect(text).toContain("版2");
	expect(text).toContain("操作時刻: 2026-10-20T00:00:00.000Z");
	expect([...text].length).toBeLessThan(300);
	expect((await adapter.read(bare, signal)).text).not.toContain("操作時刻");
	await expect(adapter.read("nope", signal)).rejects.toThrow("item_not_found");
});
