import { expect, test } from "bun:test";
import { parseCard } from "eumenes_router";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { offlineBundleHost } from "../../../application/toolchain/toolchain-adapters";
import {
	createCapabilities,
	migrations,
	ROUTER_PASSAGE_CHARS,
	routerPassage,
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
			{ bundleHost: offlineBundleHost },
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
		{ bundleHost: offlineBundleHost },
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

test("the search fills each kind's slots: the three closest dedicated toolchains, and general ones near the closest candidate", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-discovery-slots-"));
	const store = openStore(join(dir, "db"), migrations);
	const caps = createCapabilities(
		store,
		new Set([
			"web",
			"web-note",
			"history",
			"music",
			"image",
			"excalidraw",
			"dots",
		]),
		{ bundleHost: offlineBundleHost },
	);
	try {
		await caps.seed();
		const active = store.read((db) => caps.toolchainsInTransaction(db));
		const general = active.filter((d) => d.general);
		const dedicated = active.filter((d) => !d.general);
		expect(general.map((d) => d.id)).toContain("web.note");
		expect(general.find((d) => d.id === "web.search")?.selectable).toBe(false);
		expect(dedicated.length).toBeGreaterThan(3);
		/** Saves each toolchain's passages at `similarity` to the request [1, 0]. */
		const place = (similarity: (id: string) => number) =>
			store.write((db) =>
				caps.saveToolchainVectorsInTransaction(
					db,
					space,
					active.flatMap((d) => {
						const s = similarity(d.id);
						return toolchainPassages(d).map((text, item) => ({
							revisionId: d.revisionId,
							text,
							item,
							vector: [s, Math.sqrt(1 - s * s)],
						}));
					}),
				),
			);
		const rank = (id: string) => dedicated.findIndex((d) => d.id === id);
		const search = () =>
			store.read((db) =>
				caps.toolchainCandidatesInTransaction(db, {
					text: "",
					vector: { space, values: [1, 0] },
					available: () => true,
					strict: true,
					slots: true,
				}),
			);
		// The general toolchain is the closest: it is offered beside the three closest dedicated ones, marked general.
		await place((id) =>
			id === "web.note" || id === "web.search"
				? 1
				: rank(id) >= 0
					? 0.95 - rank(id) * 0.01
					: 0.5,
		);
		const near = search();
		// The withdrawn Web search is as close as the note toolchain, and is never offered.
		expect(near.map((c) => c.id)).toEqual([
			"web.note",
			...dedicated.slice(0, 3).map((d) => d.id),
		]);
		expect(near[0]!.general).toBe(true);
		expect(near.slice(1).every((c) => !c.general)).toBe(true);
		// A general toolchain farther than the slot's distance from the closest candidate is not offered.
		await place((id) =>
			id === "web.note" ? 0.9 : rank(id) >= 0 ? 0.99 - rank(id) * 0.01 : 0.5,
		);
		expect(search().map((c) => c.id)).toEqual(
			dedicated.slice(0, 3).map((d) => d.id),
		);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the router's offer is exactly the ids given, in their order, read tools among them; the router's cards are valid", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-router-offer-"));
	const store = openStore(join(dir, "db"), migrations);
	const caps = createCapabilities(
		store,
		new Set([
			"web",
			"web-note",
			"history",
			"music",
			"image",
			"excalidraw",
			"dots",
		]),
		{ bundleHost: offlineBundleHost },
	);
	try {
		await caps.seed();
		const active = store.read((db) => caps.toolchainsInTransaction(db));
		const [first, second] = active.map((d) => d.id) as [string, string];
		const offered = store.read((db) =>
			caps.toolchainCandidatesInTransaction(db, {
				text: "",
				available: (id) => id !== second,
				strict: true,
				ids: [second, "read_memory", first, "missing", first],
			}),
		);
		expect(offered.map((c) => c.id)).toEqual(["read_memory", first]);
		expect(offered[0]!.execution).toBe("read");
		const cards = store.read((db) => caps.routerCardsInTransaction(db));
		for (const card of cards) expect(parseCard(card)).toEqual(card);
		// The router is offered what selection may offer: not the Web search a revision withdrew.
		expect(cards.map((c) => c.id)).toEqual([
			...active.filter((d) => d.selectable !== false).map((d) => d.id),
			...cards.filter((c) => c.kind === "read").map((c) => c.id),
		]);
		expect(cards.map((c) => c.id)).not.toContain("web.search");
		expect(cards.find((c) => c.id === "read_memory")).toMatchObject({
			kind: "read",
			impact: "none",
		});
		expect(cards.find((c) => c.id === "web.note")?.kind).toBe("general");
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a router passage is the name, the summary and the first two use cases, at most the criterion's length", () => {
	expect(
		routerPassage({
			title: "天気予報",
			summary: "地名と日の天気を答える",
			useWhen: ["天気を聞かれた", "気温を聞かれた", "傘が要るか聞かれた"],
		}),
	).toBe("天気予報: 地名と日の天気を答える（天気を聞かれた／気温を聞かれた）");
	expect(routerPassage({ title: "計算", summary: "式を計算する" })).toBe(
		"計算: 式を計算する",
	);
	expect(
		routerPassage({ title: "長い", summary: "あ".repeat(400) }).length,
	).toBe(ROUTER_PASSAGE_CHARS);
});
