import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../infrastructure/sqlite";
import { migrations } from "./migrations";
import { offlineBundleHost } from "./toolchain-adapters";
import {
	builtinToolchainFunctions,
	createCapabilities,
	toolchainBuiltins,
	toolchainPassages,
	type Definition,
	type VectorSpace,
} from "../domains/capabilities";
import { createToolchainHistory } from "../domains/toolchain-history";
import { createRecipePorts } from "./toolchain-recipes";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
async function setup(backends = ["web", "history", "timer", "music", "dots"]) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-toolchains-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db"), migrations);
	const capabilities = createCapabilities(store, new Set(backends), {
		// Bundled toolchains (the timer) register as this host would register them.
		bundleHost: offlineBundleHost,
	});
	await capabilities.seed();
	return { store, capabilities, history: createToolchainHistory(store) };
}
const space: VectorSpace = {
	modelId: "fixture-e5",
	revision: "r1",
	artifactDigest: "d1",
	dimension: 8,
};
const oneHot = (i: number) =>
	Array.from({ length: space.dimension }, (_, j) => (j === i ? 1 : 0));

test("every builtin and bundled toolchain registers as a complete set with flat tool schemas", async () => {
	const { store, capabilities } = await setup([
		"web",
		"history",
		"timer",
		"music",
		"dots",
		"image",
		"excalidraw",
		"object-recognition",
		"claude-code",
		"steward",
		"world-query",
		"ocr",
		"ui-compositions",
		"kanban",
		"codex-tasks",
	]);
	const active = store.read((db) => capabilities.toolchainsInTransaction(db));
	expect(active.map((d) => d.functionName).sort()).toEqual(
		[...builtinToolchainFunctions].sort(),
	);
	for (const d of active) {
		const set = store.read((db) =>
			capabilities.toolchainSetInTransaction(db, d.revisionId),
		);
		expect(set.profile.length).toBeGreaterThan(0);
		expect(set.skills.length).toBeGreaterThan(0);
		for (const tool of set.tools)
			if (tool.schema) {
				expect(tool.schema.type).toBe("object");
				expect("oneOf" in tool.schema || "anyOf" in tool.schema).toBe(false);
			}
	}
});

test("a toolchain is offered only where its whole package is registered", async () => {
	const { store, capabilities } = await setup(["web"]);
	const ids = store.read((db) =>
		capabilities.toolchainsInTransaction(db).map((d) => d.id),
	);
	expect(ids).toContain("web.search");
	expect(ids).not.toContain("timers.manage");
	expect(ids).not.toContain("history.research");
});

test("an incomplete set or a reused function name is refused at registration", async () => {
	const { store, capabilities } = await setup(["web"]);
	const web = toolchainBuiltins.find((d) => d.id === "web.search")!;
	const broken: Definition[] = [
		{
			...web,
			id: "web.noexamples",
			functionName: "web_noexamples",
			examples: ["一つ"],
		},
		{
			...web,
			id: "web.noartifact",
			functionName: "web_noartifact",
			artifact: undefined,
		},
		{
			...web,
			id: "web.twopackages",
			functionName: "web_twopackages",
			dependencies: [web.packageRevisionId!, "package:web.search@1"],
		},
	];
	for (const d of broken)
		await expect(
			store.write((db) => capabilities.registerBuiltinInTransaction(db, d)),
		).rejects.toThrow("invalid_toolchain");
	await expect(
		store.write((db) =>
			capabilities.registerBuiltinInTransaction(db, {
				...web,
				id: "web.copy",
			}),
		),
	).rejects.toThrow("toolchain_function_conflict");
});

test("without vectors every available toolchain is offered; with vectors the top ones by similarity", async () => {
	const { store, capabilities } = await setup();
	const available = (id: string) => id !== "web.research.luna";
	const all = store.read((db) =>
		capabilities.toolchainCandidatesInTransaction(db, {
			text: "鎌倉の天気を教えて",
			available,
		}),
	);
	expect(all.map((c) => c.id)).not.toContain("web.research.luna");
	expect(all.map((c) => c.id).sort()).toEqual(
		[...toolchainBuiltins.map((d) => d.id), "timers.manage"]
			.filter(
				(id) =>
					available(id) &&
					store
						.read((db) => capabilities.toolchainsInTransaction(db))
						.some((d) => d.id === id),
			)
			.sort(),
	);
	// Toolchain i's passages point in direction i; the query points at web.search.
	const active = store.read((db) => capabilities.toolchainsInTransaction(db));
	await store.write((db) =>
		capabilities.saveToolchainVectorsInTransaction(
			db,
			space,
			active.flatMap((d, i) =>
				toolchainPassages(d).map((text, item) => ({
					revisionId: d.revisionId,
					item,
					text,
					vector: oneHot(i % space.dimension),
				})),
			),
		),
	);
	const web = active.findIndex((d) => d.id === "web.search");
	const ranked = store.read((db) =>
		capabilities.toolchainCandidatesInTransaction(db, {
			text: "鎌倉の天気を教えて",
			vector: { space, values: oneHot(web % space.dimension) },
			available,
		}),
	);
	expect(ranked[0]!.id).toBe("web.search");
	expect(ranked.length).toBeLessThanOrEqual(4);
	expect(ranked[0]!.score.similarity).toBe(1);
	// A vector of another space is never compared.
	const other = store.read((db) =>
		capabilities.toolchainCandidatesInTransaction(db, {
			text: "鎌倉の天気を教えて",
			vector: {
				space: { ...space, revision: "r2" },
				values: oneHot(web % space.dimension),
			},
			available,
		}),
	);
	expect(other.every((c) => c.score.similarity === null)).toBe(true);
});

test("a selection is traced from offer to outcome and later offered as reference data", async () => {
	const { store, capabilities, history } = await setup();
	const web = store.read((db) =>
		capabilities
			.toolchainsInTransaction(db)
			.find((d) => d.id === "web.search")!,
	);
	await store.write((db) => {
		history.recordSelectionInTransaction(db, {
			runId: "run-1",
			conversationId: "main",
			retrieval: "embedding",
			candidates: [
				{
					toolchainId: "web.search",
					revisionId: web.revisionId,
					functionName: "web_search",
					rank: 1,
					ftsRank: null,
					similarity: 0.9,
					fromHistory: false,
				},
			],
			historyRefs: [],
			decision: "toolchain",
			toolchainId: "web.search",
			toolchainRevisionId: web.revisionId,
			functionName: "web_search",
			request: "鎌倉の天気",
			query: { space, vector: oneHot(0) },
		});
		history.linkTaskInTransaction(db, "run-1", "task-1");
		history.settleSelectionInTransaction(db, "run-1", { outcome: "answered" });
		// The first terminal result wins.
		history.settleSelectionInTransaction(db, "run-1", { outcome: "failed" });
	});
	const saved = history.getSelection("run-1")!;
	expect(saved).toMatchObject({
		decision: "toolchain",
		functionName: "web_search",
		request: "鎌倉の天気",
		taskId: "task-1",
		outcome: "answered",
	});
	expect(history.listSelections({ runId: "run-1" }).items).toHaveLength(1);
	const past = store.read((db) =>
		history.similarSelectionsInTransaction(db, {
			space,
			vector: oneHot(0),
			activeRevisionIds: new Set([web.revisionId]),
			excludeRunId: "run-2",
		}),
	);
	expect(past).toEqual([
		expect.objectContaining({
			request: "鎌倉の天気",
			functionName: "web_search",
			outcome: "answered",
		}),
	]);
	// A retired revision or an unrelated request is not offered.
	expect(
		store.read((db) =>
			history.similarSelectionsInTransaction(db, {
				space,
				vector: oneHot(0),
				activeRevisionIds: new Set(),
			}),
		),
	).toEqual([]);
	expect(
		store.read((db) =>
			history.similarSelectionsInTransaction(db, {
				space,
				vector: oneHot(1),
				activeRevisionIds: new Set([web.revisionId]),
			}),
		),
	).toEqual([]);
});

test("a saved procedure is found by its signature and suspended after three failed reads", async () => {
	const { store, history } = await setup(["web"]);
	const id = await store.write((db) =>
		history.saveRecipeInTransaction(db, "web.search", {
			signature: "天気予報: 神奈川県鎌倉市",
			url: "https://example.com/kamakura",
			readHint: "今日と明日の予報欄",
		}),
	);
	const find = () =>
		store.read((db) =>
			history.findRecipesInTransaction(db, {
				toolchainId: "web.search",
				text: "鎌倉市の天気予報",
			}),
		);
	expect(find().map((r) => r.id)).toEqual([id]);
	await store.write((db) => {
		for (let i = 0; i < 3; i++)
			history.recordRecipeResultInTransaction(db, id, false);
	});
	expect(find()).toEqual([]);
	expect(history.listRecipes("web.search")[0]!.state).toBe("suspended");
	// A new successful URL for the same signature brings it back.
	await store.write((db) =>
		history.saveRecipeInTransaction(db, "web.search", {
			signature: "天気予報: 神奈川県鎌倉市",
			url: "https://example.com/kamakura-v2",
			readHint: "予報欄",
		}),
	);
	expect(find()[0]!.url).toBe("https://example.com/kamakura-v2");
	// A procedure the user disabled is never revived by a report.
	await history.setRecipeState(id, "disabled");
	await store.write((db) =>
		history.saveRecipeInTransaction(db, "web.search", {
			signature: "天気予報: 神奈川県鎌倉市",
			url: "https://example.com/kamakura-v3",
			readHint: "予報欄",
		}),
	);
	expect(history.listRecipes()[0]!.state).toBe("disabled");
	expect(find()).toEqual([]);
});

test("a proposed procedure is kept only when the answer cites the page it read", async () => {
	const { store, history } = await setup(["web"]);
	const reads: Array<{ url: string; state: string }> = [];
	const tools = {
		invocationsInTransaction: () =>
			reads.map((r, i) => ({
				id: `inv-${i}`,
				arguments: { url: r.url },
				toolRevisionId: "tool:web.read@1",
				state: r.state,
				superseded: false,
			})),
		observationsInTransaction: () => [],
	};
	const ports = createRecipePorts(
		history,
		() => ({}) as never,
		() => tools as never,
	);
	const report = (url: string, basis: "page" | "snippet") =>
		({
			version: 2,
			outcome: "answered",
			summary: "晴れ",
			claims: [],
			limitations: [],
			sources: [{ sourceId: "s1", url, basis }],
		}) as never;
	const proposal = {
		signature: "天気予報: 神奈川県鎌倉市",
		url: "https://example.com/kamakura",
		readHint: "予報欄",
	};
	const hook = (r: unknown) =>
		store.write((db) =>
			ports.onSearchReport(db, {
				taskId: "task",
				rootRunId: "run",
				packageId: "web.recipe",
				report: r as never,
				recipe: proposal,
			}),
		);
	// Only a search snippet backs the answer: nothing is kept.
	await hook(report(proposal.url, "snippet"));
	expect(history.listRecipes()).toEqual([]);
	// The read page backs the answer: the procedure is kept.
	reads.push({ url: proposal.url, state: "succeeded" });
	await hook(report(proposal.url, "page"));
	expect(history.listRecipes().map((r) => r.url)).toEqual([proposal.url]);
	// Other packages never keep procedures.
	await store.write((db) =>
		ports.onSearchReport(db, {
			taskId: "task",
			rootRunId: "run",
			packageId: "web.search",
			report: report("https://example.com/other", "page"),
			recipe: {
				...proposal,
				signature: "別",
				url: "https://example.com/other",
			},
		}),
	);
	expect(history.listRecipes()).toHaveLength(1);
});
