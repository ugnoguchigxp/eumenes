import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { offlineBundleHost } from "../../../application/toolchain/toolchain-adapters";
import {
	bundleFiles,
	createCapabilities,
	migrations,
	type VectorSpace,
} from "..";

const space: VectorSpace = {
	modelId: "fixture-embedding",
	revision: "r1",
	artifactDigest: "d1",
	dimension: 2,
};

async function seeded() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-withdrawn-"));
	const store = openStore(join(dir, "db"), migrations);
	const caps = createCapabilities(store, new Set(["web", "web-note"]), {
		bundleHost: offlineBundleHost,
	});
	await caps.seed();
	return {
		store,
		caps,
		close: async () => {
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("the Web search is withdrawn from every selection, and still resolves for work that names it", async () => {
	const { store, caps, close } = await seeded();
	try {
		const active = store.read((db) => caps.toolchainsInTransaction(db));
		const search = active.find((d) => d.id === "web.search")!;
		const note = active.find((d) => d.id === "web.note")!;
		expect(search.revisionId).toBe("toolchain:web.search@11");
		expect(search.selectable).toBe(false);
		expect(note.selectable).toBeUndefined();

		// The search by embedding, the router's exact offer, the router's cards and the evaluation set.
		await store.write((db) =>
			caps.saveToolchainVectorsInTransaction(
				db,
				space,
				active.flatMap((d) =>
					[search, note].some((x) => x.id === d.id)
						? [d].flatMap((x) =>
								[`${x.title}: ${x.summary}`, ...x.useWhen].map(
									(text, item) => ({
										revisionId: x.revisionId,
										text,
										item,
										vector: [1, 0],
									}),
								),
							)
						: [],
				),
			),
		);
		const found = store.read((db) =>
			caps.toolchainCandidatesInTransaction(db, {
				text: "",
				vector: { space, values: [1, 0] },
				available: () => true,
				strict: true,
				slots: true,
			}),
		);
		expect(found.map((c) => c.id)).toContain("web.note");
		expect(found.map((c) => c.id)).not.toContain("web.search");
		const exact = (extra: object = {}) =>
			store.read((db) =>
				caps.toolchainCandidatesInTransaction(db, {
					text: "",
					available: () => true,
					strict: true,
					ids: ["web.search", "web.note"],
					...extra,
				}),
			);
		expect(exact().map((c) => c.id)).toEqual(["web.note"]);
		// A work asks for the card of its own revision, selectable or not.
		expect(exact({ unselectable: true }).map((c) => c.id)).toEqual([
			"web.search",
			"web.note",
		]);
		expect(
			store.read((db) => caps.routerCardsInTransaction(db)).map((c) => c.id),
		).not.toContain("web.search");
		expect(
			store
				.read((db) => caps.toolchainExamplesInTransaction(db))
				.map((e) => e.id),
		).not.toContain("web.search");
		const pending = store.read((db) =>
			caps.pendingToolchainVectorsInTransaction(db, space),
		);
		expect(pending.some((p) => p.revisionId === search.revisionId)).toBe(false);

		// It stays registered: its revision resolves, loads its set, and its function name is kept.
		const resolved = store.read((db) =>
			caps.resolveToolchainInTransaction(db, search.revisionId),
		);
		expect(resolved.toolchain.functionName).toBe("web_search");
		expect(
			store.read((db) => caps.toolchainSetInTransaction(db, search.revisionId))
				.package.revisionId,
		).toBe(resolved.packageRevisionId);
	} finally {
		await close();
	}
});

test("only a toolchain may be withdrawn from selection, and only by `false`", async () => {
	const { store, caps, close } = await seeded();
	try {
		const host = offlineBundleHost();
		const original = bundleFiles().find(
			(b) => b.name === "web-note.bundle.json",
		)!.raw;
		const attempt = (change: (bundle: any) => void) => {
			const bundle = structuredClone(original) as any;
			change(bundle);
			return store.write((db) =>
				caps.importBundleInTransaction(db, bundle, host, { dryRun: true }),
			);
		};
		// A new revision each time: a stored revision is never changed.
		const toolchain = (b: any) => {
			const d = b.definitions.find((x: any) => x.kind === "toolchain");
			d.revision = 2;
			return d;
		};
		expect(
			(await attempt((b) => (toolchain(b).selectable = false))).issues,
		).toEqual([]);
		for (const value of [true, "no", null])
			expect(
				(await attempt((b) => (toolchain(b).selectable = value))).issues.length,
			).toBeGreaterThan(0);
		expect(
			(
				await attempt((b) => {
					const d = b.definitions.find((x: any) => x.kind === "package");
					d.revision = 2;
					d.selectable = false;
				})
			).issues.length,
		).toBeGreaterThan(0);
	} finally {
		await close();
	}
});
