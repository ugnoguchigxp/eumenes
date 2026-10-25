import { afterEach, expect, test } from "bun:test";
import { sha256Hex } from "../../../infrastructure/digest";
import {
	dot,
	packVector,
	unpackVector,
	vectorSpaceKey,
} from "../../../infrastructure/vector";
import type { MemoryVectorSpace } from "../contracts";
import { putTurnVector } from "../repository";
import { RECALL_MIN_SCORE } from "../service/turn-recall";
import { setupMemory, type MemoryHarness } from "./memory.fixture";

const SPACE: MemoryVectorSpace = {
	modelId: "test-embed",
	revision: "1",
	artifactDigest: "digest",
	dimension: 3,
};
const OTHER: MemoryVectorSpace = { ...SPACE, revision: "2" };
const A = [1, 0, 0];
const B = [0, 1, 0];
const open: MemoryHarness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});
async function setup() {
	const h = await setupMemory();
	open.push(h);
	return h;
}

/** A user message and its answer, one run. */
async function exchange(
	h: MemoryHarness,
	user: string,
	answer: string | null,
	conversationId = "c1",
) {
	const userId = await h.say("user", user, conversationId);
	const answerId =
		answer === null
			? null
			: await h.say("assistant", answer, conversationId, `run-${userId}`);
	return { userId, answerId };
}
/** Stores a vector for a message as the memory agent would (digest of the text it read). */
async function embed(
	h: MemoryHarness,
	messageId: string,
	vector: number[],
	space: MemoryVectorSpace = SPACE,
	digestOf?: string,
) {
	await h.store.write((db) => {
		const found = h.conversation.messageInTransaction(db, messageId)!;
		putTurnVector(db, {
			messageId,
			conversationId: found.message.conversationId,
			ordinal: found.ordinal,
			space: vectorSpaceKey(space),
			vector: packVector(vector),
			digest: digestOf ?? sha256Hex(found.message.text),
			createdAt: h.time.now,
		});
	});
}
function recall(
	h: MemoryHarness,
	extra: Partial<
		Parameters<MemoryHarness["memory"]["recallTurnsInRead"]>[1]
	> = {},
) {
	return h.store.read((db) =>
		h.memory.recallTurnsInRead(db, {
			conversationId: "c1",
			space: SPACE,
			vector: A,
			limit: 3,
			minScore: RECALL_MIN_SCORE,
			...extra,
		}),
	);
}
/** The message ids a search found, in its order. */
const ids = (found: ReturnType<typeof recall>) =>
	found?.pins.map((pin) => pin.messageId) ?? [];

test("vector encoding and the space key are the toolchain embeddings' (shared implementation, pinned values)", () => {
	// Float32, little endian.
	expect([...packVector([1, -2])]).toEqual([0, 0, 128, 63, 0, 0, 0, 192]);
	expect([...unpackVector(packVector([0.5, 2]))]).toEqual([0.5, 2]);
	expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
	// The key rule capabilities used before it was shared: sha256 of the JSON array, first 32 hex characters.
	const legacy = new Bun.CryptoHasher("sha256")
		.update(
			JSON.stringify([
				SPACE.modelId,
				SPACE.revision,
				SPACE.artifactDigest,
				SPACE.dimension,
			]),
		)
		.digest("hex")
		.slice(0, 32);
	expect(vectorSpaceKey(SPACE)).toBe(legacy);
	expect(vectorSpaceKey(OTHER)).not.toBe(legacy);
});

test("an exchange left out of nothing is found whole, once, even when both its messages match", async () => {
	const h = await setup();
	const old = await exchange(h, "去年の京都旅行の話", "清水寺が良かったですね");
	const recent = await exchange(h, "最近の京都の話", "紅葉の季節ですね");
	await embed(h, old.userId, A);
	await embed(h, old.answerId!, A);
	await embed(h, recent.userId, A);
	const found = recall(h, { excludeMessageIds: [recent.userId] });
	expect(found!.pins).toEqual([
		{ messageId: old.userId, digest: sha256Hex("去年の京都旅行の話") },
		{ messageId: old.answerId!, digest: sha256Hex("清水寺が良かったですね") },
	]);
});

test("a vector of another space, another conversation or a low score is ignored", async () => {
	const h = await setup();
	const sameSpace = await exchange(h, "話題A", "回答A");
	const otherSpace = await exchange(h, "話題B", "回答B");
	const lowScore = await exchange(h, "話題C", "回答C");
	const elsewhere = await exchange(h, "話題D", "回答D", "c2");
	await embed(h, sameSpace.userId, A);
	await embed(h, otherSpace.userId, A, OTHER);
	await embed(h, lowScore.userId, B);
	await embed(h, elsewhere.userId, A);
	expect(ids(recall(h))).toEqual([sameSpace.userId, sameSpace.answerId!]);
	expect(recall(h, { vector: [0, 0, 1] })).toBeNull();
	// A query of another dimension is not comparable.
	expect(
		recall(h, { space: { ...SPACE, dimension: 2 }, vector: [1, 0] }),
	).toBeNull();
});

test("the count limit holds, best matches first, and a hit must stay close to the best one", async () => {
	const h = await setup();
	const near = (score: number) => [score, Math.sqrt(1 - score * score), 0];
	const made: Array<{ userId: string; answerId: string | null }> = [];
	for (const score of [0.9, 0.99, 0.97, 0.98]) {
		const e = await exchange(h, `質問${score}`, `回答${score}`);
		await embed(h, e.userId, near(score));
		made.push(e);
	}
	const users = (found: ReturnType<typeof recall>) =>
		ids(found).filter((id) => made.some((e) => e.userId === id));
	// 0.99, 0.98, 0.97 in that order; 0.9 is above the floor but too far from the best.
	expect(users(recall(h, { limit: 3 }))).toEqual([
		made[1]!.userId,
		made[3]!.userId,
		made[2]!.userId,
	]);
	expect(users(recall(h, { limit: 1 }))).toEqual([made[1]!.userId]);
	expect(users(recall(h, { minScore: 0.985 }))).toEqual([made[1]!.userId]);
	expect(recall(h, { minScore: 0.995 })).toBeNull();
	expect(recall(h, { limit: 0 })).toBeNull();
});

test("left-out messages, blocked messages and changed texts are never found", async () => {
	const h = await setup();
	const used = await exchange(h, "すでに使った話", "使った回答");
	const scheduled = await exchange(h, "定期の問い合わせ", "定期の回答");
	const edited = await exchange(h, "直す前の話", "直す前の回答");
	const fine = await exchange(h, "大丈夫な話", "大丈夫な回答");
	for (const e of [used, scheduled, edited, fine]) await embed(h, e.userId, A);
	// The answer of a scheduled run carries a vector too; the exchange is dropped as a whole.
	await embed(h, scheduled.answerId!, A);
	await h.store.write((db) =>
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "c1",
			messageIds: [scheduled.userId],
			reason: "scheduled_prompt",
		}),
	);
	// The text changed after it was embedded: the vector no longer stands for it.
	await h.store.write((db) =>
		db
			.query("UPDATE messages SET text = ? WHERE id = ?")
			.run("直した後の話", edited.userId),
	);
	expect(ids(recall(h, { excludeMessageIds: [used.userId] }))).toEqual([
		fine.userId,
		fine.answerId!,
	]);
});

test("an exchange without an adopted answer is found by its user message alone", async () => {
	const h = await setup();
	const e = await exchange(h, "答えられなかった質問", null);
	await embed(h, e.userId, A);
	expect(ids(recall(h))).toEqual([e.userId]);
});

test("the search is off with memory off", async () => {
	const h = await setup();
	const e = await exchange(h, "覚えている話", "覚えている回答");
	await embed(h, e.userId, A);
	expect(recall(h)).not.toBeNull();
	await h.memory.setEnabled(false);
	expect(recall(h)).toBeNull();
});

test("the search gives up at the attempt cap", async () => {
	const h = await setup();
	// 55 better matches that can never be found (scheduled prompts), then one that could.
	for (let i = 0; i < 55; i++) {
		const e = await exchange(h, `定期${i}`, `定期回答${i}`);
		await embed(h, e.userId, A);
		await h.store.write((db) =>
			h.memory.blockMessagesInTransaction(db, {
				conversationId: "c1",
				messageIds: [e.userId],
				reason: "scheduled_prompt",
			}),
		);
	}
	const good = await exchange(h, "拾える話", "拾える回答");
	await embed(h, good.userId, [0.99, Math.sqrt(1 - 0.99 * 0.99), 0]);
	expect(recall(h)).toBeNull();
	// Without the noise it is found.
	await h.store.write((db) =>
		db
			.query("DELETE FROM memory_turn_vector WHERE message_id != ?")
			.run(good.userId),
	);
	expect(ids(recall(h))).toEqual([good.userId, good.answerId!]);
});

test("retracting a message drops its vector and its exchange partner's", async () => {
	const h = await setup();
	const kept = await exchange(h, "残る話", "残る回答");
	const gone = await exchange(h, "消す話", "消す回答");
	for (const id of [kept.userId, kept.answerId!, gone.userId, gone.answerId!])
		await embed(h, id, A);
	const vectors = () =>
		h.store
			.read(
				(db) =>
					db
						.query("SELECT message_id AS id FROM memory_turn_vector")
						.all() as Array<{ id: string }>,
			)
			.map((r) => r.id)
			.sort();
	expect(vectors()).toHaveLength(4);
	await h.conversation.retract({ messageId: gone.userId });
	expect(vectors()).toEqual([kept.userId, kept.answerId!].sort());
	expect(ids(recall(h))).toEqual([kept.userId, kept.answerId!]);
	// Retracting only the answer drops the user's vector with it too (the exchange is one thing).
	await h.conversation.retract({ messageId: kept.answerId! });
	expect(vectors()).toEqual([]);
});

test("there is no ordinal boundary: a hidden exchange between shown ones is found, and a shown one is not", async () => {
	const h = await setup();
	const shownOld = await exchange(h, "最初の京都の話", "清水寺の話ですね");
	const hidden = await exchange(h, "二番目の京都の話", "紅葉の話ですね");
	const shownNew = await exchange(h, "三番目の京都の話", "嵐山の話ですね");
	for (const turn of [shownOld, hidden, shownNew])
		await embed(h, turn.userId, A);
	expect(
		ids(recall(h, { excludeMessageIds: [shownOld.userId, shownNew.userId] })),
	).toEqual([hidden.userId, hidden.answerId!]);
});
