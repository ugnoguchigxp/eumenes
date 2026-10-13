import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { migrations as capabilities } from "../../capabilities";
import {
	createToolchainHistory,
	migrations,
	registerToolchainHistory,
} from "..";
import { recipePageQuerySchema, selectionPageQuerySchema } from "../contracts";

let store: SqliteStore, dir: string;
afterEach(async () => {
	if (store) await store.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
});
test("history and procedures have global literal search, API sorting, stable pagination and last-page clamping", async () => {
	dir = mkdtempSync(join(tmpdir(), "history-pages-"));
	store = openStore(join(dir, "db"), [...capabilities, ...migrations]);
	const history = createToolchainHistory(store, () => 1000000);
	await store.write((db) => {
		for (let i = 0; i < 65; i++) {
			const key = String(i).padStart(3, "0");
			history.recordSelectionInTransaction(db, {
				runId: "run-" + key,
				conversationId: "fixture",
				retrieval: "none",
				candidates: [],
				historyRefs: [],
				decision: "toolchain",
				functionName: "process-" + key,
				request: "依頼-" + key,
			});
			history.settleSelectionInTransaction(db, "run-" + key, {
				outcome: i % 2 ? "failed" : "answered",
			});
			history.saveRecipeInTransaction(db, "web.search", {
				signature: "手順-" + key,
				url: "https://example.com/" + key,
				readHint: i === 64 ? "literal_%'検索" : "本文",
			});
		}
	});
	const selection = (v: object = {}) =>
		history.selectionPage(selectionPageQuerySchema.parse(v));
	const recipe = (v: object = {}) =>
		history.recipePage(recipePageQuerySchema.parse(v));
	expect(selection({ q: "依頼-064" })).toMatchObject({
		total: 1,
		items: [{ functionName: "process-064" }],
	});
	expect(selection({ q: "回答できた" }).total).toBe(33);
	expect(recipe({ q: "有効" }).total).toBe(65);
	const ids = Array.from({ length: 7 }, (_, pageIndex) =>
		selection({ pageIndex }).items.map((r) => r.id),
	).flat();
	expect(new Set(ids).size).toBe(65);
	expect(
		selection({ sort: "process", desc: false }).items[0]?.functionName,
	).toBe("process-000");
	expect(
		selection({ sort: "process", desc: true }).items[0]?.functionName,
	).toBe("process-064");
	expect(
		selection({ sort: "outcome", desc: false }).items.every(
			(r) => r.outcome === "answered",
		),
	).toBe(true);
	expect(recipe({ q: "_%'" })).toMatchObject({
		total: 1,
		items: [{ signature: "手順-064" }],
	});
	expect(
		recipe({ sort: "signature", desc: false, pageIndex: 1 }).items[0]
			?.signature,
	).toBe("手順-010");
	for (const sort of ["updatedAt", "state", "successes", "failures"] as const)
		expect(recipe({ sort }).items).toHaveLength(10);
	const last = recipe({ pageIndex: 999 });
	expect(last.pageIndex).toBe(6);
	expect(last.items).toHaveLength(5);
	for (const row of last.items) await history.deleteRecipe(row.id);
	expect(recipe({ pageIndex: 6 })).toMatchObject({ pageIndex: 5, total: 60 });
	const app = new Hono();
	registerToolchainHistory(app, history);
	for (const endpoint of ["selections", "recipes"])
		for (const raw of [
			"sort=sql;injection",
			"pageSize=0",
			"pageIndex=-1",
			"desc=evil",
			"q=" + "x".repeat(201),
		])
			expect(
				(await app.request(`/api/toolchain-history/${endpoint}/page?${raw}`))
					.status,
			).toBe(400);
	expect(
		(await app.request("/api/toolchain-history/selections/page")).status,
	).toBe(200);
});
