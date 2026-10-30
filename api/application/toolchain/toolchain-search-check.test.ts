import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import { offlineBundleHost } from "./toolchain-adapters";
import {
	createCapabilities,
	toolchainPassages,
	type VectorSpace,
} from "../../domains/capabilities";
import type { ToolchainRoutingPort } from "../../domains/dialogue";
import { createToolchainHistory } from "../../domains/toolchain-history";
import { createSearchCheck } from "./toolchain-search-check";

/**
 * The search check (the toolchain search and choice design, section 6): the toolchains chosen for past requests,
 * ranked again from their stored vectors and the index, and whether the search's slots offer them now.
 */
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const space: VectorSpace = {
	modelId: "fixture-e5",
	revision: "r1",
	artifactDigest: "d1",
	dimension: 4,
};
const oneHot = (i: number) =>
	Array.from({ length: space.dimension }, (_, j) => (j === i ? 1 : 0));

test("a past choice is ranked again from its stored vector; one the slots would not offer is listed by its toolchain only", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-search-check-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db"), migrations);
	const capabilities = createCapabilities(
		store,
		new Set(["web", "history", "music", "image"]),
		{ bundleHost: offlineBundleHost },
	);
	await capabilities.seed();
	const history = createToolchainHistory(store);
	const active = store.read((db) => capabilities.toolchainsInTransaction(db));
	expect(active.find((d) => d.id === "web.search")?.general).toBe(true);
	// The music toolchain is the one a music request is close to; every other toolchain is far from both requests.
	await store.write((db) =>
		capabilities.saveToolchainVectorsInTransaction(
			db,
			space,
			active.flatMap((d) =>
				toolchainPassages(d).map((text, item) => ({
					revisionId: d.revisionId,
					text,
					item,
					vector: d.id === "music.create" ? oneHot(0) : oneHot(3),
				})),
			),
		),
	);
	const choose = (runId: string, toolchainId: string, vector: number[]) =>
		store.write((db) =>
			history.recordSelectionInTransaction(db, {
				runId,
				conversationId: "main",
				retrieval: "embedding",
				candidates: [],
				historyRefs: [],
				decision: "toolchain",
				toolchainId,
				query: { space, vector },
			}),
		);
	await choose("r1", "music.create", oneHot(0));
	// The general toolchain chosen for this request is far from the closest candidate: the slots leave it out.
	await choose("r2", "web.search", oneHot(0));
	await choose("r3", "retired.chain", oneHot(0));
	const check = createSearchCheck({
		store,
		capabilities,
		history,
		routing: {
			catalogInTransaction: (db) =>
				capabilities
					.toolchainsInTransaction(db)
					.map((d) => ({ id: d.id, revisionId: d.revisionId })),
		} as Pick<ToolchainRoutingPort, "catalogInTransaction">,
	});
	const result = check.run();
	expect(result).toMatchObject({
		checked: 2,
		offered: 1,
		unavailable: 1,
		unindexed: 0,
		ranks: { "1": 1 },
	});
	expect(result.missed).toEqual([
		expect.objectContaining({ toolchainId: "web.search" }),
	]);
	expect(Object.keys(result.missed[0]!).sort()).toEqual([
		"createdAt",
		"rank",
		"selectionId",
		"toolchainId",
	]);
	await store.close();
});
