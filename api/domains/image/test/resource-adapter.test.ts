import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { migrations as queueMigrations } from "../../queue";
import { migrations, createImageResourceAdapter } from "..";
import type { ImageRecord } from "../contracts";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-image-resource-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [
		...queueMigrations,
		...migrations,
	]);
	stores.push(store);
	return { store, adapter: createImageResourceAdapter({ store }) };
}
let serial = 0;
async function insert(
	store: SqliteStore,
	change: Partial<ImageRecord> & { createdAt: number },
) {
	const id = crypto.randomUUID();
	const record: ImageRecord = {
		id,
		runId: `run-${serial++}`,
		conversationId: "main",
		state: "completed",
		title: "森",
		description: "",
		prompt: "a forest",
		action: "generate",
		width: 256,
		height: 256,
		format: "png",
		seed: 1,
		artifactId: `image_${serial}`,
		phase: "completed",
		errorCode: null,
		mime: "image/png",
		actualModel: null,
		updatedAt: change.createdAt,
		...change,
	};
	await store.write((db) =>
		db
			.query(
				"INSERT INTO image_generations(id,run_id,conversation_id,record_json,request_json,bindings_json,deadline) VALUES(?,?,?,?,?,?,?)",
			)
			.run(id, record.runId, "main", JSON.stringify(record), "{}", "{}", 0),
	);
	return record;
}
const controller = new AbortController();

test("a completed result maps to one image reference and an unfinished one to none", async () => {
	const { store, adapter } = setup();
	const done = await insert(store, {
		createdAt: Date.UTC(2026, 9, 1),
		title: "朝の森",
	});
	const failed = await insert(store, {
		createdAt: Date.UTC(2026, 9, 2),
		state: "failed",
		artifactId: null,
	});
	store.read((db) => {
		const refs = adapter.fromResultInTransaction(
			db,
			{
				state: "completed",
				title: "朝の森",
				imageRef: done.artifactId,
				url: `/api/images/${done.artifactId}/content`,
			},
			{ conversationId: "main" },
		);
		expect(refs).toEqual([
			{
				uri: `eumenes://image/${done.artifactId}`,
				kind: "image",
				label: "朝の森",
				createdAt: "2026-10-01T00:00:00.000Z",
			},
		]);
		// The generation record itself is accepted too.
		expect(
			adapter.fromResultInTransaction(db, done, { conversationId: "main" }),
		).toHaveLength(1);
		expect(
			adapter.fromResultInTransaction(
				db,
				{ ...done, state: "generating" },
				{ conversationId: "main" },
			),
		).toEqual([]);
		expect(
			adapter.fromResultInTransaction(db, failed, { conversationId: "main" }),
		).toEqual([]);
		expect(
			adapter.fromResultInTransaction(
				db,
				{
					state: "completed",
					imageRef: "image_missing",
				},
				{ conversationId: "main" },
			),
		).toEqual([]);
		expect(
			adapter.fromResultInTransaction(db, "text", { conversationId: "main" }),
		).toEqual([]);
	});
});

test("get resolves a generated image to the image screen and misses unknown ids", async () => {
	const { store, adapter } = setup();
	const done = await insert(store, { createdAt: 1_000_000 });
	await insert(store, {
		createdAt: 2_000_000,
		state: "failed",
		artifactId: "image_failed",
	});
	store.read((db) => {
		expect(adapter.getInTransaction(db, done.artifactId!)).toMatchObject({
			adapterRef: "adapter:image-screen@1",
			targetRef: done.artifactId,
			actions: ["open", "read"],
			preview: `/api/images/${done.artifactId}/content`,
		});
		expect(adapter.getInTransaction(db, "image_missing")).toBeNull();
		expect(adapter.getInTransaction(db, "image_failed")).toBeNull();
	});
});

test("an imported image resolves without a generation", async () => {
	const { store, adapter } = setup();
	const view = {
		requestId: crypto.randomUUID(),
		status: "succeeded",
		createdAt: 1,
		expiresAt: 2,
		retryAfterMs: 0,
		artifact: {
			id: "image_imported",
			createdAt: "2026-10-03T00:00:00.000Z",
			format: "webp",
			mimeType: "image/webp",
			width: 64,
			height: 32,
		},
	};
	await store.write((db) =>
		db
			.query(
				"INSERT INTO image_imports(request_id,principal,connection,original_digest,view_json,expires_at) VALUES(?,?,?,?,?,?)",
			)
			.run(view.requestId, "local", "c", "d", JSON.stringify(view), 2),
	);
	store.read((db) => {
		expect(adapter.getInTransaction(db, "image_imported")).toMatchObject({
			label: "画像 2026-10-03",
			targetRef: "image_imported",
		});
	});
});

test("search matches title and prompt, newest first, within the window", async () => {
	const { store, adapter } = setup();
	const old = await insert(store, {
		createdAt: Date.UTC(2026, 9, 1),
		title: "古い海",
	});
	const mid = await insert(store, {
		createdAt: Date.UTC(2026, 9, 2),
		title: "夜",
		prompt: "sea at night",
	});
	const fresh = await insert(store, {
		createdAt: Date.UTC(2026, 9, 3),
		title: "新しい海",
	});
	await insert(store, { createdAt: Date.UTC(2026, 9, 4), title: "森" });
	const sea = await adapter.search(
		{ text: "海", limit: 10 },
		controller.signal,
	);
	expect(sea.map((r) => r.uri)).toEqual([
		`eumenes://image/${fresh.artifactId}`,
		`eumenes://image/${old.artifactId}`,
	]);
	const byPrompt = await adapter.search(
		{ text: "SEA", limit: 10 },
		controller.signal,
	);
	expect(byPrompt.map((r) => r.uri)).toEqual([
		`eumenes://image/${mid.artifactId}`,
	]);
	const all = await adapter.search({ text: "", limit: 2 }, controller.signal);
	expect(all).toHaveLength(2);
	expect(Date.parse(all[0]!.createdAt)).toBeGreaterThan(
		Date.parse(all[1]!.createdAt),
	);
	const window = await adapter.search(
		{
			text: "",
			since: "2026-10-02T00:00:00.000Z",
			until: "2026-10-03T00:00:00.000Z",
			limit: 10,
		},
		controller.signal,
	);
	expect(window).toHaveLength(2);
});

test("read gives the request and stays within the token bound", async () => {
	const { store, adapter } = setup();
	const done = await insert(store, {
		createdAt: 1,
		title: "森",
		description: "静かな森",
		prompt: "あ".repeat(3000),
	});
	const { text } = await adapter.read(done.artifactId!, controller.signal);
	expect(text).toContain("森");
	expect(text).toContain("静かな森");
	expect(estimateTextTokens(text)).toBeLessThanOrEqual(600);
	await expect(
		adapter.read("image_missing", controller.signal),
	).rejects.toThrow("item_not_found");
});
