import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createCapabilities,
	migrations,
	type VectorSpace,
} from "../../domains/capabilities";
import { openStore } from "../../infrastructure/sqlite";
import { offlineBundleHost } from "./toolchain-adapters";
import { createVectorRefresh } from "./toolchain-vectors";

test("publishes a complete toolchain index without reusing legacy or other-space vectors", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-embedding-index-"));
	const store = openStore(join(dir, "db"), migrations);
	try {
		const caps = createCapabilities(store, new Set(["image", "music"]), {
			bundleHost: offlineBundleHost,
		});
		await caps.seed();
		const unknown: VectorSpace = {
			modelId: "same-model",
			revision: "same-revision",
			artifactDigest: "same-artifact",
			dimension: 512,
		};
		const space = { ...unknown, embeddingSpace: { tokenizerDigest: "one" } };
		const other = { ...space, embeddingSpace: { tokenizerDigest: "two" } };
		const unit = (dimension: number) => [1, ...Array(dimension - 1).fill(0)];
		const legacy = { ...unknown, dimension: 384 };
		for (const old of [legacy, unknown, other]) {
			await store.write((db) => {
				const pending = caps.pendingToolchainVectorsInTransaction(db, old);
				caps.saveToolchainVectorsInTransaction(
					db,
					old,
					pending.map((row) => ({
						...row,
						vector: unit(old.dimension),
					})),
				);
			});
		}
		const missing = () =>
			store.read((db) => caps.pendingToolchainVectorsInTransaction(db, space))
				.length;
		const initial = missing();
		expect(initial).toBeGreaterThan(32);
		let calls = 0;
		let changeSpace = true;
		const refresh = createVectorRefresh(store, caps, async (texts) => ({
			space: changeSpace && ++calls === 3 ? other : space,
			vectors: texts.map(() => unit(space.dimension)),
		}));
		const search = () =>
			store.read((db) =>
				caps.toolchainCandidatesInTransaction(db, {
					text: "日本語の依頼",
					vector: { space, values: unit(space.dimension) },
					available: () => true,
					strict: true,
				}),
			);
		expect(search()).toEqual([]);
		expect(await refresh.refresh()).toBeUndefined();
		expect(missing()).toBe(initial);
		expect(search()).toEqual([]);
		changeSpace = false;
		expect(await refresh.refresh()).toEqual(space);
		expect(missing()).toBe(0);
		expect(search().length).toBeGreaterThan(0);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
