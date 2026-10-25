import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createCapabilities,
	migrations,
	toolchainPassages,
	type VectorSpace,
} from "..";

const space: VectorSpace = {
	modelId: "fixture-embedding",
	revision: "r1",
	artifactDigest: "d1",
	dimension: 2,
};
for (const targetId of ["music.create", "image.create", "excalidraw.edit"])
	test(`the current request embedding selects ${targetId} despite past choices and unrelated text matches`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "eumenes-current-intent-"));
		const store = openStore(join(dir, "db"), migrations);
		const caps = createCapabilities(
			store,
			new Set([
				"web",
				"history",
				"music",
				"image",
				"excalidraw",
				"dots",
				"object-recognition",
			]),
		);
		try {
			await caps.seed();
			const active = store.read((db) => caps.toolchainsInTransaction(db));
			expect(active.some((d) => d.id === targetId)).toBe(true);
			await store.write((db) =>
				caps.saveToolchainVectorsInTransaction(
					db,
					space,
					active.flatMap((d) =>
						toolchainPassages(d).map((text, item) => ({
							revisionId: d.revisionId,
							text,
							item,
							vector: d.id === targetId ? [1, 0] : [0, 1],
						})),
					),
				),
			);
			const cards = store.read((db) =>
				caps.toolchainCandidatesInTransaction(db, {
					text: "画像を作って、過去の話題を調べて",
					vector: { space, values: [1, 0] },
					fromHistory: active
						.filter((d) => d.id !== targetId)
						.reverse()
						.map((d) => d.id),
					available: (id) => id !== "history.research",
				}),
			);
			expect(cards[0]?.id).toBe(targetId);
			expect(cards[0]?.score.similarity).toBe(1);
			expect(cards.map((c) => c.score.similarity)).toEqual(
				cards.map((c) => c.score.similarity).sort((a, b) => b! - a!),
			);
			expect(cards.map((c) => c.id)).not.toContain("history.research");
			expect(cards.length).toBeLessThanOrEqual(4);
		} finally {
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

test("strict discovery has no all-catalog fallback and returns the top four", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-discovery-limit-"));
	const store = openStore(join(dir, "db"), migrations);
	const caps = createCapabilities(
		store,
		new Set([
			"web",
			"history",
			"music",
			"image",
			"excalidraw",
			"dots",
			"object-recognition",
		]),
	);
	try {
		await caps.seed();
		const active = store.read((db) => caps.toolchainsInTransaction(db));
		expect(active.length).toBeGreaterThan(4);
		const read = (withVector = true) =>
			store.read((db) =>
				caps.toolchainCandidatesInTransaction(db, {
					text: "用途",
					available: () => true,
					strict: true,
					vector: withVector ? { space, values: [1, 0] } : undefined,
				}),
			);
		expect(read()).toEqual([]);
		expect(read(false)).toEqual([]);
		await store.write((db) =>
			caps.saveToolchainVectorsInTransaction(
				db,
				space,
				active.flatMap((d, i) =>
					toolchainPassages(d).map((text, item) => ({
						revisionId: d.revisionId,
						text,
						item,
						vector: [1 - i / 100, i / 100],
					})),
				),
			),
		);
		const initial = read();
		expect(initial).toHaveLength(4);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
