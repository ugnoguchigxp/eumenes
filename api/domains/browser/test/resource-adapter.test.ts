import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations as queueMigrations } from "../../queue";
import { parseResourceUri, resourceRefSchema } from "../../resources";
import { createBrowserResourceAdapter, migrations } from "..";

const OWNER = "owner";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanup.splice(0)) await c();
});
type Capture = {
	id: string;
	state?: string;
	owner?: string;
	range?: string;
	tabRef?: string;
	at?: number;
};
async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-browser-resource-"));
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	cleanup.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const adapter = createBrowserResourceAdapter({ store, owner: OWNER });
	const capture = (c: Capture) =>
		store.write((db) =>
			db
				.query(
					`INSERT INTO browser_captures(id,owner,conversation_id,origin,request_id,tab_ref,range,state,deadline,png_width,png_height,captured_at,created_at,updated_at)
					 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				)
				.run(
					c.id,
					c.owner ?? OWNER,
					"main",
					"conversation",
					`req-${c.id}`,
					c.tabRef ?? "tab-1",
					c.range ?? "viewport",
					c.state ?? "local_ready",
					Date.now() + 1000,
					1000,
					800,
					c.at ?? Date.parse("2026-10-20T00:00:00.000Z"),
					c.at ?? Date.parse("2026-10-20T00:00:00.000Z"),
					Date.now(),
				),
		);
	const tab = (tabRef: string, title: string, url: string) =>
		store.write((db) =>
			db
				.query(
					"INSERT INTO browser_tabs(tab_ref,connection_id,mcp_index,url,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
				)
				.run(tabRef, "conn", 0, url, title, "open", Date.now(), Date.now()),
		);
	return { store, adapter, capture, tab };
}
const signal = new AbortController().signal;

test("a finished capture maps to its resource; unfinished, failed and foreign ones map to nothing", async () => {
	const { store, adapter, capture, tab } = await setup();
	await tab("tab-1", "天気予報", "https://example.com/forecast?token=secret");
	await capture({ id: "c-done" });
	await capture({ id: "c-run", state: "capturing" });
	await capture({ id: "c-fail", state: "failed" });
	await capture({ id: "c-foreign", owner: "someone" });
	const refs = (result: unknown) =>
		store.read((db) =>
			adapter.fromResultInTransaction(db, result, { conversationId: "main" }),
		);
	const [ref] = refs({ captureId: "c-done", state: "local_ready" });
	expect(ref).toMatchObject({
		uri: "eumenes://capture/c-done",
		kind: "capture",
		label: "天気予報の撮影",
		createdAt: "2026-10-20T00:00:00.000Z",
	});
	expect(resourceRefSchema.safeParse(ref).success).toBe(true);
	expect(parseResourceUri(ref!.uri)?.id).toBe("c-done");
	for (const captureId of ["c-run", "c-fail", "c-foreign", "nope"])
		expect(refs({ captureId })).toEqual([]);
	expect(refs({})).toEqual([]);
	expect(refs("x")).toEqual([]);
});

test("get returns the screen target and the image path, and null otherwise; an unknown tab falls back to the range", async () => {
	const { store, adapter, capture } = await setup();
	await capture({ id: "c-done", range: "full-page", tabRef: "gone" });
	await capture({ id: "c-run", state: "encoding" });
	expect(
		store.read((db) => adapter.getInTransaction(db, "c-done")),
	).toMatchObject({
		adapterRef: "adapter:browser@1",
		targetRef: "c-done",
		actions: ["open", "read"],
		label: "ブラウザの撮影（ページ全体）",
		preview: "/api/browser/captures/c-done/content",
	});
	for (const id of ["c-run", "nope"])
		expect(store.read((db) => adapter.getInTransaction(db, id))).toBeNull();
});

test("search is newest first, filters by tab title, host and period", async () => {
	const { adapter, capture, tab } = await setup();
	await tab("tab-1", "天気予報", "https://weather.example.com/today");
	await tab("tab-2", "レシピ", "https://recipe.example.org/");
	await capture({
		id: "c-old",
		tabRef: "tab-1",
		at: Date.parse("2026-10-01T00:00:00.000Z"),
	});
	await capture({
		id: "c-new",
		tabRef: "tab-2",
		at: Date.parse("2026-10-20T00:00:00.000Z"),
	});
	await capture({
		id: "c-mid",
		tabRef: "tab-1",
		at: Date.parse("2026-10-10T00:00:00.000Z"),
	});
	const ids = async (query: Parameters<typeof adapter.search>[0]) =>
		(await adapter.search(query, signal)).map(
			(r) => parseResourceUri(r.uri)!.id,
		);
	expect(await ids({ text: "", limit: 10 })).toEqual([
		"c-new",
		"c-mid",
		"c-old",
	]);
	expect(await ids({ text: "天気", limit: 10 })).toEqual(["c-mid", "c-old"]);
	expect(await ids({ text: "recipe.example.org", limit: 10 })).toEqual([
		"c-new",
	]);
	expect(await ids({ text: "", limit: 1 })).toEqual(["c-new"]);
	expect(
		await ids({
			text: "",
			since: "2026-10-05T00:00:00.000Z",
			until: "2026-10-15T00:00:00.000Z",
			limit: 10,
		}),
	).toEqual(["c-mid"]);
});

test("read names the time, size and host only (never the path or query) and cuts a long title with a marker", async () => {
	const { adapter, capture, tab } = await setup();
	await tab("tab-1", "天気予報", "https://example.com/forecast?token=secret");
	await tab("tab-2", "長".repeat(3000), "https://example.org/");
	await capture({ id: "c-a", tabRef: "tab-1" });
	await capture({ id: "c-b", tabRef: "tab-2" });
	const a = (await adapter.read("c-a", signal)).text;
	expect(a).toContain("撮影: 2026-10-20T00:00:00.000Z");
	expect(a).toContain("大きさ: 1000×800");
	expect(a).toContain("ページ: example.com");
	expect(a).not.toContain("secret");
	const b = (await adapter.read("c-b", signal)).text;
	expect(estimateTextTokens(b)).toBeLessThanOrEqual(600);
	expect(b.endsWith("…（以下省略）")).toBe(true);
	await expect(adapter.read("nope", signal)).rejects.toThrow("item_not_found");
});
