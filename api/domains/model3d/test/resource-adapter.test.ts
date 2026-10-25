import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations as queueMigrations } from "../../queue";
import { parseResourceUri, resourceRefSchema } from "../../resources";
import { createModel3dResourceAdapter, migrations } from "..";
import { rememberAssets } from "../repository";
import type { Model3dAsset } from "../contracts";

const OWNER = "owner";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanup.splice(0)) await c();
});
async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-model3d-resource-"));
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	cleanup.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const adapter = createModel3dResourceAdapter({ store, owner: OWNER });
	const remember = (...assets: Model3dAsset[]) =>
		store.write((db) => rememberAssets(db, OWNER, assets));
	const generation = (
		id: string,
		change: {
			state?: string;
			assetId?: string | null;
			deleted?: number;
			owner?: string;
		} = {},
	) =>
		store.write((db) =>
			db
				.query(
					`INSERT INTO model3d_generations(id,owner,conversation_id,origin,request_id,idempotency_key,title,tags_json,source_json,seed,state,asset_id,deleted,deadline,created_at,updated_at)
					 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				)
				.run(
					id,
					change.owner ?? OWNER,
					"main",
					"conversation",
					`req-${id}`,
					`key-${id}`,
					"ロボット",
					"[]",
					JSON.stringify({ type: "prompt", prompt: "ロボット" }),
					1,
					change.state ?? "completed",
					change.assetId === undefined ? "asset-1" : change.assetId,
					change.deleted ?? 0,
					Date.now() + 1000,
					Date.now(),
					Date.now(),
				),
		);
	return { store, adapter, remember, generation };
}
const asset = (
	id: string,
	title: string,
	createdAt: string,
	extra: Partial<Model3dAsset> = {},
): Model3dAsset => ({
	id,
	title,
	tags: ["ロボット"],
	createdAt,
	prompt: "白い背景に青緑のロボット",
	warnings: [],
	hasSource: true,
	...extra,
});
const signal = new AbortController().signal;

test("a completed generation maps to its asset; unfinished, deleted or unknown ones map to nothing", async () => {
	const { store, adapter, remember, generation } = await setup();
	await remember(
		asset("asset-1", "青緑のロボット", "2026-10-18T00:00:00.000Z"),
	);
	await generation("g-done");
	await generation("g-running", { state: "running", assetId: null });
	await generation("g-failed", { state: "failed", assetId: null });
	await generation("g-deleted", { deleted: 1 });
	await generation("g-foreign", { owner: "someone" });
	await generation("g-missing", { assetId: "asset-gone" });
	const refs = (result: unknown) =>
		store.read((db) =>
			adapter.fromResultInTransaction(db, result, { conversationId: "main" }),
		);
	const [done] = refs({
		generation: { id: "g-done", state: "completed", assetId: "asset-1" },
	});
	expect(done).toMatchObject({
		uri: "eumenes://model3d.asset/asset-1",
		kind: "model3d.asset",
		label: "青緑のロボット",
	});
	expect(resourceRefSchema.safeParse(done).success).toBe(true);
	expect(parseResourceUri(done!.uri)?.id).toBe("asset-1");
	expect(refs({ id: "g-done" })).toHaveLength(1);
	expect(refs({ assetRef: "asset-1" })).toHaveLength(1);
	for (const id of [
		"g-running",
		"g-failed",
		"g-deleted",
		"g-foreign",
		"g-missing",
		"nope",
	])
		expect(refs({ id })).toEqual([]);
	expect(refs({ assetRef: "asset-gone" })).toEqual([]);
	expect(refs(null)).toEqual([]);
	expect(refs("text")).toEqual([]);
});

test("get returns the screen target and null for an unknown asset", async () => {
	const { store, adapter, remember } = await setup();
	await remember(
		asset("asset-1", "青緑のロボット", "2026-10-18T00:00:00.000Z"),
	);
	const view = store.read((db) => adapter.getInTransaction(db, "asset-1"));
	expect(view).toMatchObject({
		adapterRef: "adapter:model3d@1",
		targetRef: "asset-1",
		actions: ["open", "read"],
		createdAt: "2026-10-18T00:00:00.000Z",
	});
	expect(
		store.read((db) => adapter.getInTransaction(db, "missing")),
	).toBeNull();
});

test("search is newest first, filters by text and period, and honours the limit", async () => {
	const { adapter, remember } = await setup();
	await remember(
		asset("a-old", "古いロボット", "2026-10-01T00:00:00.000Z"),
		asset("a-new", "新しいロボット", "2026-10-20T00:00:00.000Z"),
		asset("a-cat", "猫", "2026-10-10T00:00:00.000Z", {
			tags: ["動物"],
			prompt: "猫を描く",
		}),
	);
	const ids = async (query: Parameters<typeof adapter.search>[0]) =>
		(await adapter.search(query, signal)).map(
			(r) => parseResourceUri(r.uri)!.id,
		);
	expect(await ids({ text: "", limit: 10 })).toEqual([
		"a-new",
		"a-cat",
		"a-old",
	]);
	expect(await ids({ text: "ロボット", limit: 10 })).toEqual([
		"a-new",
		"a-old",
	]);
	expect(await ids({ text: "動物", limit: 10 })).toEqual(["a-cat"]);
	expect(await ids({ text: "", limit: 1 })).toEqual(["a-new"]);
	expect(
		await ids({
			text: "",
			since: "2026-10-05T00:00:00.000Z",
			until: "2026-10-15T00:00:00.000Z",
			limit: 10,
		}),
	).toEqual(["a-cat"]);
});

test("read is a short summary within 600 tokens; the index already keeps only the first 120 characters of the request", async () => {
	const { adapter, remember } = await setup();
	await remember(
		asset("a-long", "長い依頼", "2026-10-18T00:00:00.000Z", {
			tags: Array.from({ length: 8 }, (_, i) => `タグ${i}`),
			prompt: "あ".repeat(2000),
			warnings: ["注意".repeat(200), "二つ目".repeat(200), "三つ目"],
		}),
		asset("a-short", "短い依頼", "2026-10-18T00:00:00.000Z", { prompt: "猫" }),
		asset("a-none", "依頼なし", "2026-10-18T00:00:00.000Z", { prompt: null }),
	);
	const long = (await adapter.read("a-long", signal)).text;
	expect(estimateTextTokens(long)).toBeLessThanOrEqual(600);
	expect(long).toContain("3Dモデル「長い依頼」");
	expect(long).toContain(`依頼: ${"あ".repeat(120)}`);
	expect(long).not.toContain("あ".repeat(121));
	const short = (await adapter.read("a-short", signal)).text;
	expect(short).toContain("依頼: 猫");
	expect(short).not.toContain("省略");
	expect((await adapter.read("a-none", signal)).text).not.toContain("依頼:");
	await expect(adapter.read("missing", signal)).rejects.toThrow(
		"item_not_found",
	);
});
