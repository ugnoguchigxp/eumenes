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
function fakeEmbed() {
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
			space: SPACE,
		};
	};
	return { state, embed };
}
const open: MemoryHarness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
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

test("turns are embedded as passages, the query as a query; failures and a missing embedder cost only the vectors", async () => {
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
		expect(await h.memory.vectors.embedQuery("京都", signal())).toBeNull();
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

test("a prefetched exchange whose message changed makes the run's window stale", async () => {
	const h = await setup();
	const old = await h.say("user", "京都の話をしたい");
	await h.window();
	const digest = sha256Hex("京都の話をしたい");
	await h.store.write((db) =>
		h.memory.windows.rebuildInTransaction(db, "c1", {
			refreshLongTerm: false,
			prefetch: {
				text: "京都の話",
				pins: [{ messageId: old, digest }],
				bytes: 12,
			},
		}),
	);
	const window = await h.window();
	expect(window.prefetch.pins).toHaveLength(1);
	const prepared = h.memory.preparedWindow(window);
	const verdict = () =>
		h.store.read((db) =>
			h.memory.validateWindowInTransaction(db, "run-x", prepared),
		);
	expect(verdict()).toEqual({ ok: true });
	await h.store.write((db) =>
		db.query("UPDATE messages SET text = ? WHERE id = ?").run("書き換え", old),
	);
	expect(verdict()).toEqual({ ok: false, reason: "memory_stale" });
	// The next prepare drops the changed pin instead of expiring every later run.
	expect((await h.window()).prefetch.pins).toEqual([]);
});
