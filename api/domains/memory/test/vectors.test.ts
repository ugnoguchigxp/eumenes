import { afterEach, expect, test } from "bun:test";
import { sha256Hex } from "../../../infrastructure/digest";
import type { MemoryEmbed, MemoryVectorSpace } from "../contracts";
import { setupMemory, type MemoryHarness } from "./memory.fixture";

const SPACE: MemoryVectorSpace = {
	modelId: "test-embed",
	revision: "1",
	artifactDigest: "digest",
	dimension: 3,
};
const vectorOf = (text: string) =>
	text.includes("京都")
		? [1, 0, 0]
		: text.includes("北海道")
			? [0, 1, 0]
			: [0, 0, 1];
function fakeEmbed(space = SPACE) {
	const state = {
		calls: [] as Array<{ texts: string[]; type: "query" | "passage" }>,
		mode: "ok" as "ok" | "throw" | "short",
	};
	const embed: MemoryEmbed = async (texts, type) => {
		state.calls.push({ texts, type });
		if (state.mode === "throw") throw new Error("embedding_unavailable");
		const vectors = texts.map(vectorOf);
		return {
			vectors: state.mode === "short" ? vectors.slice(1) : vectors,
			space,
		};
	};
	return { state, embed };
}
const open: MemoryHarness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});

test("rebuilds a legacy vector from the whole message and recalls its tail only in the new space", async () => {
	const space = { ...SPACE, embeddingSpace: { tokenizerDigest: "current" } };
	const e = fakeEmbed(space);
	const h = await setup(e.embed);
	const text = "あ".repeat(1600) + "京都で待ち合わせ";
	const messageId = await h.say("user", text);
	await h.store.write((db) =>
		h.memory.vectors.saveTurnVectors(
			db,
			{
				conversationId: "c1",
				digests: { [messageId]: sha256Hex(text) },
			},
			{ space: SPACE, items: [{ messageId, vector: [0, 0, 1] }] },
		),
	);
	const recall = (current: MemoryVectorSpace) =>
		h.store.read((db) =>
			h.memory.recallTurnsInRead(db, {
				conversationId: "c1",
				vector: [1, 0, 0],
				space: current,
				limit: 1,
				minScore: 0.8,
			}),
		);
	expect(recall(space)).toBeNull();
	expect(await h.memory.vectors.refreshTurns(space, signal())).toBe(1);
	expect(e.state.calls[0]?.texts.join("")).toBe(text);
	expect(recall(space)?.pins.map((pin) => pin.messageId)).toEqual([messageId]);
	expect(
		recall({ ...space, embeddingSpace: { tokenizerDigest: "other" } }),
	).toBeNull();
	expect(await h.memory.vectors.refreshTurns(space, signal())).toBe(0);
});
async function setup(embed?: MemoryEmbed) {
	const h = await setupMemory(embed ? { embed } : {});
	open.push(h);
	return h;
}
const signal = () => new AbortController().signal;
const rows = (h: MemoryHarness) =>
	h.store.read(
		(db) =>
			db
				.query(
					"SELECT message_id AS messageId, digest FROM memory_turn_vector ORDER BY ordinal",
				)
				.all() as Array<{ messageId: string; digest: string }>,
	);

test("turns are embedded as passages and failed query embeddings are reported", async () => {
	const e = fakeEmbed();
	const h = await setup(e.embed);
	const turns = [
		{ messageId: "a", text: "京都の話をしたい" },
		{ messageId: "b", text: "  " },
		{ messageId: "c", text: "北海道の話" },
	];
	const embedded = await h.memory.vectors.embedTurns(turns, signal());
	expect(embedded?.items.map((i) => i.messageId)).toEqual(["a", "c"]);
	expect(e.state.calls[0]).toEqual({
		texts: ["京都の話をしたい", "北海道の話"],
		type: "passage",
	});
	const query = await h.memory.vectors.embedQuery("京都", signal());
	expect(query?.vector).toEqual([1, 0, 0]);
	expect(e.state.calls[1]?.type).toBe("query");
	for (const mode of ["throw", "short"] as const) {
		e.state.mode = mode;
		expect(await h.memory.vectors.embedTurns(turns, signal())).toBeNull();
		await expect(h.memory.vectors.embedQuery("京都", signal())).rejects.toThrow(
			"embedding_",
		);
	}
	const none = await setup();
	expect(await none.memory.vectors.embedTurns(turns, signal())).toBeNull();
});

test("saved turn vectors carry the digest of the whole message and are never kept for a blocked message", async () => {
	const e = fakeEmbed();
	const h = await setup(e.embed);
	const user = await h.say("user", "京都の話をしたい");
	const long = await h.say("user", "あ".repeat(2500));
	const scheduled = await h.say("user", "【定期】朝の確認");
	await h.store.write((db) =>
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "c1",
			messageIds: [scheduled],
			reason: "scheduled_prompt",
		}),
	);
	const vectors = await h.memory.vectors.embedTurns(
		[user, long, scheduled].map((messageId, i) => ({
			messageId,
			text: ["京都の話をしたい", "あ".repeat(2000), "【定期】朝の確認"][i]!,
		})),
		signal(),
	);
	await h.store.write((db) =>
		h.memory.vectors.saveTurnVectors(
			db,
			{
				conversationId: "c1",
				digests: {
					[user]: sha256Hex("京都の話をしたい"),
					[long]: sha256Hex("あ".repeat(2500)),
					[scheduled]: sha256Hex("【定期】朝の確認"),
				},
			},
			vectors,
		),
	);
	const stored = rows(h);
	expect(stored.map((r) => r.messageId)).toEqual([user, long]);
	expect(stored[1]!.digest).toBe(sha256Hex("あ".repeat(2500)));
});
