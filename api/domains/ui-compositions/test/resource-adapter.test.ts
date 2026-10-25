import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { openStore } from "../../../infrastructure/sqlite";
import { parseResourceUri, resourceRefSchema } from "../../resources";
import { createUiCompositionResourceAdapter } from "..";
import {
	insertComposition,
	migrations as domainMigrations,
} from "../repository";

/** This domain's migrations alone: the queue ordering of the first one does not matter here. */
const migrations = domainMigrations.map((m) => ({
	...m,
	after: m.after?.filter((id) => id.startsWith("ui-compositions/")),
}));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanup.splice(0)) await c();
});
const survey = {
	view: "layout",
	direction: "stack",
	children: [
		{ view: "text-block", title: "a", body: "b" },
		{ view: "info-card", title: "c", body: "d" },
		{ view: "info-card", title: "e", body: "f" },
		{
			view: "form",
			fields: [{ id: "name", label: "お名前", type: "text" }],
		},
	],
};
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-ui-resource-"));
	const store = openStore(join(dir, "db"), migrations);
	cleanup.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const adapter = createUiCompositionResourceAdapter({ store });
	const save = (
		id: string,
		title: string,
		createdAt: string,
		change: { scope?: string; definition?: unknown; fields?: unknown } = {},
	) =>
		store.write((db) =>
			insertComposition(db, {
				id,
				scope: change.scope ?? "default",
				title,
				definition_json: JSON.stringify(change.definition ?? survey),
				fields_json:
					change.fields === undefined
						? JSON.stringify([{ id: "name", label: "お名前", type: "text" }])
						: JSON.stringify(change.fields),
				created_at: Date.parse(createdAt),
			}),
		);
	return { store, adapter, save };
}
const signal = new AbortController().signal;

test("a save receipt or work state maps to the saved composition; drafts, deletions and unknown ids map to nothing", async () => {
	const { store, adapter, save } = await setup();
	await save("c-1", "アンケート", "2026-10-20T00:00:00.000Z");
	await save("c-other", "別のスコープ", "2026-10-20T00:00:00.000Z", {
		scope: "elsewhere",
	});
	const refs = (result: unknown) =>
		store.read((db) =>
			adapter.fromResultInTransaction(db, result, { conversationId: "main" }),
		);
	const [ref] = refs({ projectId: "c-1", state: "saved", savedRevision: 1 });
	expect(ref).toMatchObject({
		uri: "eumenes://ui.composition/c-1",
		kind: "ui.composition",
		label: "アンケート",
		createdAt: "2026-10-20T00:00:00.000Z",
	});
	expect(resourceRefSchema.safeParse(ref).success).toBe(true);
	expect(parseResourceUri(ref!.uri)?.id).toBe("c-1");
	expect(refs({ savedRef: "c-1", dirty: false })).toHaveLength(1);
	expect(refs({ projectId: "c-1", state: "drafted" })).toEqual([]);
	expect(refs({ projectId: "c-1", state: "deleted" })).toEqual([]);
	expect(refs({ projectId: "gone", state: "saved" })).toEqual([]);
	expect(refs({ projectId: "c-other", state: "saved" })).toEqual([]);
	expect(refs({ savedRef: null })).toEqual([]);
	expect(refs(3)).toEqual([]);
});

test("get returns the studio target and the saved version, and null for an unknown or foreign-scope id", async () => {
	const { store, adapter, save } = await setup();
	await save("c-1", "アンケート", "2026-10-20T00:00:00.000Z");
	await save("c-other", "別", "2026-10-20T00:00:00.000Z", {
		scope: "elsewhere",
	});
	expect(store.read((db) => adapter.getInTransaction(db, "c-1"))).toMatchObject(
		{
			adapterRef: "adapter:ui-compositions@1",
			targetRef: "c-1",
			actions: ["open", "read"],
			preview: "版1",
		},
	);
	for (const id of ["c-other", "nope"])
		expect(store.read((db) => adapter.getInTransaction(db, id))).toBeNull();
});

test("search is newest first by creation, filters by title and period", async () => {
	const { adapter, save } = await setup();
	await save("c-old", "古いアンケート", "2026-10-01T00:00:00.000Z");
	await save("c-new", "新しい見積", "2026-10-20T00:00:00.000Z");
	await save("c-mid", "中くらいのアンケート", "2026-10-10T00:00:00.000Z");
	const ids = async (query: Parameters<typeof adapter.search>[0]) =>
		(await adapter.search(query, signal)).map(
			(r) => parseResourceUri(r.uri)!.id,
		);
	expect(await ids({ text: "", limit: 10 })).toEqual([
		"c-new",
		"c-mid",
		"c-old",
	]);
	expect(await ids({ text: "アンケート", limit: 10 })).toEqual([
		"c-mid",
		"c-old",
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

test("read summarises the parts and form fields and stays within 600 tokens", async () => {
	const { adapter, save } = await setup();
	await save("c-1", "アンケート", "2026-10-20T00:00:00.000Z");
	const text = (await adapter.read("c-1", signal)).text;
	expect(text).toContain("画面「アンケート」（版1）");
	expect(text).toContain("部品: info-card×2、form×1、layout×1、text-block×1");
	expect(text).toContain("入力項目: お名前");
	await save("c-big", "長".repeat(500), "2026-10-21T00:00:00.000Z", {
		fields: Array.from({ length: 8 }, (_, i) => ({
			id: `f${i}`,
			label: "項目".repeat(50),
			type: "text",
		})),
	});
	const big = (await adapter.read("c-big", signal)).text;
	expect(estimateTextTokens(big)).toBeLessThanOrEqual(600);
	await expect(adapter.read("nope", signal)).rejects.toThrow("item_not_found");
});
