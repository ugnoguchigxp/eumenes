import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	migrations as capabilityMigrations,
	type VectorSpace,
} from "../../capabilities";
import { createToolchainHistory, migrations } from "..";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function setup(now = () => 1_000_000) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-toolchain-history-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db"), [
		...capabilityMigrations,
		...migrations,
	]);
	return { store, history: createToolchainHistory(store, now) };
}
const space: VectorSpace = {
	modelId: "fixture",
	revision: "r1",
	artifactDigest: "d1",
	dimension: 4,
};
const unit = (i: number) => [0, 1, 2, 3].map((j) => (j === i ? 1 : 0));
const selection = (runId: string, extra: Record<string, unknown> = {}) => ({
	runId,
	conversationId: "main",
	retrieval: "embedding" as const,
	candidates: [],
	historyRefs: [],
	decision: "toolchain" as const,
	toolchainId: "web.search",
	toolchainRevisionId: "toolchain:web.search@1",
	functionName: "web_search",
	request: "鎌倉の天気",
	query: { space, vector: unit(0) },
	...extra,
});

test("a retried attempt replaces the decision and the first terminal outcome wins", async () => {
	const { store, history } = setup();
	await store.write((db) => {
		history.recordSelectionInTransaction(db, selection("run"));
		history.settleSelectionInTransaction(db, "run", { outcome: "failed" });
		// A new attempt of the same run starts a fresh trace.
		history.recordSelectionInTransaction(
			db,
			selection("run", { request: "鎌倉市の天気" }),
		);
		history.settleSelectionInTransaction(db, "run", { outcome: "answered" });
		history.settleSelectionInTransaction(db, "run", { outcome: "cancelled" });
	});
	expect(history.listSelections().items).toHaveLength(1);
	expect(history.getSelection("run")).toMatchObject({
		request: "鎌倉市の天気",
		outcome: "answered",
	});
	expect(store.read((db) => history.requestOfRunInTransaction(db, "run"))).toBe(
		"鎌倉市の天気",
	);
});

test("past selections are near, current and from other runs only", async () => {
	const { store, history } = setup();
	await store.write((db) => {
		history.recordSelectionInTransaction(db, selection("near"));
		history.recordSelectionInTransaction(
			db,
			selection("far", { query: { space, vector: unit(1) } }),
		);
		history.recordSelectionInTransaction(
			db,
			selection("answer", { decision: "answer", toolchainId: undefined }),
		);
	});
	const past = (exclude?: string, active = ["toolchain:web.search@1"]) =>
		store.read((db) =>
			history.similarSelectionsInTransaction(db, {
				space,
				vector: unit(0),
				activeRevisionIds: new Set(active),
				excludeRunId: exclude,
			}),
		);
	expect(past().map((p) => p.request)).toEqual(["鎌倉の天気"]);
	expect(past("near")).toEqual([]);
	expect(past(undefined, [])).toEqual([]);
	// Another vector space is never compared.
	expect(
		store.read((db) =>
			history.similarSelectionsInTransaction(db, {
				space: { ...space, revision: "r2" },
				vector: unit(0),
				activeRevisionIds: new Set(["toolchain:web.search@1"]),
			}),
		),
	).toEqual([]);
});

test("expired traces are pruned when a new decision is recorded", async () => {
	let now = 1_000_000;
	const { store, history } = setup(() => now);
	await store.write((db) =>
		history.recordSelectionInTransaction(db, selection("old")),
	);
	now += 31 * 24 * 60 * 60 * 1000;
	await store.write((db) =>
		history.recordSelectionInTransaction(db, selection("new")),
	);
	expect(history.getSelection("old")).toBeNull();
	expect(history.getSelection("new")).not.toBeNull();
});

test("procedures: found by signature, suspended after three failures, disabled ones stay off", async () => {
	const { store, history } = setup();
	const proposal = {
		signature: "天気予報: 神奈川県鎌倉市",
		url: "https://example.com/kamakura",
		readHint: "予報欄",
	};
	const id = await store.write((db) =>
		history.saveRecipeInTransaction(db, "web.search", proposal),
	);
	const find = () =>
		store.read((db) =>
			history.findRecipesInTransaction(db, {
				toolchainId: "web.search",
				text: "鎌倉市の天気予報",
			}),
		);
	expect(find().map((r) => r.id)).toEqual([id]);
	// Another toolchain never sees it.
	expect(
		store.read((db) =>
			history.findRecipesInTransaction(db, {
				toolchainId: "web.research.luna",
				text: "鎌倉市の天気予報",
			}),
		),
	).toEqual([]);
	await store.write((db) => {
		for (let i = 0; i < 3; i++)
			history.recordRecipeResultInTransaction(db, id, false);
	});
	expect(find()).toEqual([]);
	await history.setRecipeState(id, "disabled");
	await store.write((db) =>
		history.saveRecipeInTransaction(db, "web.search", proposal),
	);
	expect(history.listRecipes()[0]!.state).toBe("disabled");
	await history.deleteRecipe(id);
	expect(history.listRecipes()).toEqual([]);
	await expect(history.deleteRecipe(id)).rejects.toThrow("recipe_not_found");
});

test("a proposal with an unbounded or malformed field is refused", async () => {
	const { store, history } = setup();
	for (const bad of [
		{ signature: "x".repeat(201), url: "https://example.com", readHint: "a" },
		{ signature: "a", url: "not a url", readHint: "a" },
		{ signature: "a", url: "https://example.com", readHint: "" },
	])
		await expect(
			store.write((db) =>
				history.saveRecipeInTransaction(db, "web.search", bad),
			),
		).rejects.toThrow();
	expect(history.listRecipes()).toEqual([]);
});

test("report upkeep: a cited read counts once, a failed read counts as a failure, only cited pages are kept", async () => {
	const { store, history } = setup();
	await store.write((db) =>
		history.recordSelectionInTransaction(db, selection("run")),
	);
	const url = "https://example.com/kamakura";
	const proposal = {
		signature: "天気予報: 神奈川県鎌倉市",
		url,
		readHint: "予報欄",
	};
	const settle = (
		input: Partial<Parameters<typeof history.settleRecipesInTransaction>[1]>,
	) =>
		store.write((db) =>
			history.settleRecipesInTransaction(db, {
				toolchainId: "web.search",
				runId: "run",
				lookedUp: true,
				offeredUrls: [],
				reads: [],
				citedPages: [],
				answered: true,
				proposal,
				...input,
			}),
		);
	// A page that only a snippet backs is not kept.
	await settle({ reads: [{ url, state: "succeeded" }] });
	expect(history.listRecipes()).toEqual([]);
	expect(history.getSelection("run")!.recipe).toBe("missed");
	// The read page backs the answer: kept, and the trace says so.
	await settle({ reads: [{ url, state: "succeeded" }], citedPages: [url] });
	expect(history.listRecipes()[0]).toMatchObject({ url, successes: 1 });
	expect(history.getSelection("run")!.recipe).toBe("saved");
	// The next run reuses it and proposes it again: one success, not two.
	await store.write((db) =>
		history.recordSelectionInTransaction(db, selection("run2")),
	);
	await settle({
		runId: "run2",
		offeredUrls: [url],
		reads: [{ url, state: "succeeded" }],
		citedPages: [url],
	});
	expect(history.listRecipes()[0]!.successes).toBe(2);
	expect(history.getSelection("run2")!.recipe).toBe("matched");
	// A refused read of the saved URL is a failure, even when another page answers.
	await settle({
		offeredUrls: [url],
		reads: [
			{ url, state: "failed" },
			{ url: "https://example.com/other", state: "succeeded" },
		],
		citedPages: ["https://example.com/other"],
		proposal: undefined,
	});
	expect(history.listRecipes()[0]).toMatchObject({
		consecutiveFailures: 1,
		state: "active",
	});
	// Not answered: nothing is kept.
	await settle({
		reads: [{ url: "https://example.com/new", state: "succeeded" }],
		citedPages: ["https://example.com/new"],
		answered: false,
		proposal: { ...proposal, signature: "別", url: "https://example.com/new" },
	});
	expect(history.listRecipes()).toHaveLength(1);
});
