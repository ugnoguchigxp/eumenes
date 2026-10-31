import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createCapabilities,
	READ_TOOLS,
	type VectorSpace,
} from "../../domains/capabilities";
import { openStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import { offlineBundleHost } from "./toolchain-adapters";

/** Every backend a server offers, so all seeded toolchains compete with the read tools in the search. */
const backends = new Set([
	"docling",
	"web",
	"history",
	"timer",
	"music",
	"dots",
	"image",
	"ui-compositions",
	"excalidraw",
	"object-recognition",
	"ocr",
	"model3d",
	"compute",
	"browser",
	"shell",
	"claude-code",
	"kanban",
	"codex-tasks",
	"steward",
	"weather",
	"stock",
	"world-query",
]);

/**
 * A stand-in for the embedding model: character pairs hashed into a unit vector, so the search's own index, ranking
 * and slots run over every passage, deterministically. It checks that a request's words are in the right entry's
 * passages and nowhere closer, not how the product's model ranks them.
 */
const space: VectorSpace = {
	modelId: "fixture-character-pairs",
	revision: "1",
	artifactDigest: "fixture",
	dimension: 512,
};
function pairs(text: string): number[] {
	const vector = Array.from({ length: space.dimension }, () => 0);
	const chars = [...text.replace(/[\s、。？！「」（）]/gu, "")];
	for (let i = 0; i + 1 < chars.length; i++) {
		let hash = 0;
		for (const char of chars[i]! + chars[i + 1]!)
			hash = (hash * 31 + char.codePointAt(0)!) % space.dimension;
		vector[hash]! += 1;
	}
	const norm = Math.hypot(...vector) || 1;
	return vector.map((value) => value / norm);
}

const dir = mkdtempSync(join(tmpdir(), "eumenes-read-tools-search-"));
const store = openStore(join(dir, "db"), migrations);
const capabilities = createCapabilities(store, backends, {
	bundleHost: offlineBundleHost,
});
beforeAll(async () => {
	await capabilities.seed();
	// The index's own list of what to embed: the toolchains' passages and the read tools'.
	await store.write((db) =>
		capabilities.saveToolchainVectorsInTransaction(
			db,
			space,
			capabilities
				.pendingToolchainVectorsInTransaction(db, space)
				.map((row) => ({ ...row, vector: pairs(row.text) })),
		),
	);
});
afterAll(async () => {
	await store.close();
	rmSync(dir, { recursive: true, force: true });
});

const search = (
	text: string,
	available: (id: string) => boolean = () => true,
) =>
	store.read((db) =>
		capabilities.toolchainCandidatesInTransaction(db, {
			text,
			vector: { space, values: pairs(text) },
			available,
			strict: true,
			slots: true,
		}),
	);

test("the read tools are indexed with the toolchains but are no toolchain of the catalog", () => {
	const pending = store.read((db) =>
		capabilities.pendingToolchainVectorsInTransaction(db, space),
	);
	expect(pending).toEqual([]);
	const active = store.read((db) => capabilities.toolchainsInTransaction(db));
	expect(active.length).toBeGreaterThan(20);
	for (const tool of READ_TOOLS)
		expect(active.some((d) => d.id === tool.name)).toBe(false);
});

test("a read tool's card carries execution read and the JSON Schema of its arguments", () => {
	const [card] = search("会話ログを確認して");
	expect(card).toMatchObject({
		id: "read_history",
		functionName: "read_history",
		revisionId: "host:read_history@1",
		execution: "read",
	});
	expect(
		Object.keys(
			(card!.read!.parameters as { properties: Record<string, unknown> })
				.properties,
		).sort(),
	).toEqual(["from", "query", "speaker", "until"]);
	// What a provider's grammar may not take is left out; the host checks the full validator all the same.
	const text = JSON.stringify(card!.read!.parameters);
	for (const word of ["$schema", '"pattern"', '"format"'])
		expect(text).not.toContain(word);
});

test("a read tool that is not available now is not offered", () => {
	const ids = search("会話ログを確認して", (id) => id !== "read_history").map(
		(card) => card.id,
	);
	expect(ids).not.toContain("read_history");
});

test.each([
	["直近の会話ログをチェックしてくれる？", "read_history"],
	["前に私が何て言ったか確認して", "read_history"],
	["メモリーに何が残ってるかチェックして", "read_memory"],
	["私について記憶していることを教えて", "read_memory"],
	["さっきの依頼はどうして失敗したの？", "read_runs"],
	["実行ログを見せて", "read_runs"],
	["サブエージェントは何をしたの？", "read_agents"],
	["さっきの調べものでどのページを見た？", "read_agents"],
	["World だと Eumenes について何が記録されてる？", "read_world"],
	// Old conversations and the whole record go to the history investigation (a sub-agent), recent words to the read.
	["半年前の会話で決めたことを履歴から調べて", "history.research"],
	["これまでの会話全体から旅行の話の経緯を洗い出して", "history.research"],
])("「%s」 puts %s first in the search", (text, expected) => {
	expect(search(text)[0]?.id).toBe(expected);
});
