import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { configureLogging } from "../../../infrastructure/logger";
import type { ForgetPurge } from "../contracts";
import { appendJournal, blockJournalPathOf } from "../service/journal";
import type { BlockJournalEntry } from "../service/journal";
import { setupMemory, type MemoryHarness } from "./memory.fixture";

const open: MemoryHarness[] = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const h of open.splice(0)) await h.close();
});
async function setup() {
	const h = await setupMemory();
	open.push(h);
	return h;
}
const exchange = async (h: MemoryHarness, user: string, answer: string) => {
	const runId = `run-${h.time.now}-${user}`;
	const inputMessageId = await h.say("user", user, "c1", runId);
	const answerMessageId = await h.say("assistant", answer, "c1", runId);
	await h.store.write((db) =>
		h.memory.recordExchangeInTransaction(db, {
			conversationId: "c1",
			runId,
			inputMessageId,
			answerMessageId,
			outcome: "answered",
		}),
	);
	return { inputMessageId, answerMessageId };
};
const mergeOf = async (h: MemoryHarness) => {
	const a = await h.seed("コーヒーが好き", "drink.coffee");
	const b = await h.seed("紅茶が好き", "drink.tea");
	const other = await h.seed("毎朝走る", "run", "毎朝走る", "habit");
	const [merged] = await h.curate([
		{
			op: "merge",
			sources: [
				{ itemId: a.id, revision: a.revision },
				{ itemId: b.id, revision: b.revision },
			],
			key: "drink",
			text: "コーヒーと紅茶が好き",
		},
	]);
	if (merged?.status !== "applied") throw new Error("merge rejected");
	return { a, b, other, mergedId: merged.id as string };
};
const stateIds = (h: MemoryHarness) => h.memory.list(true).map((i) => i.id);

test("forgetting a merged item also forgets what it was merged from", async () => {
	const h = await setup();
	const { a, b, other, mergedId } = await mergeOf(h);
	expect(stateIds(h)).toContain(a.id);
	const outcome = await h.forget([mergedId]);
	expect(new Set(outcome.forgottenItemIds)).toEqual(
		new Set([mergedId, a.id, b.id]),
	);
	expect(stateIds(h)).toEqual([other.id]);
	// No lineage is left behind, and no text of the sources.
	expect(
		h.store.read(
			(db) =>
				(
					db.query("SELECT COUNT(*) AS n FROM memory_item_merge").get() as {
						n: number;
					}
				).n,
		),
	).toBe(0);
});

test("forgetting a merge source also forgets the merged item and the other sources", async () => {
	const h = await setup();
	const { a, b, other, mergedId } = await mergeOf(h);
	const outcome = await h.forget([a.id]);
	expect(new Set(outcome.forgottenItemIds)).toEqual(
		new Set([mergedId, a.id, b.id]),
	);
	expect(stateIds(h)).toEqual([other.id]);
});

test("the lineage is followed through repeated merges and the versions of each fact", async () => {
	const h = await setup();
	const { a, b, other: habit, mergedId } = await mergeOf(h);
	const other = await h.seed("辛いものが好き", "food.spicy");
	const merged = h.memory.list(true).find((item) => item.id === mergedId)!;
	const [second] = await h.curate([
		{
			op: "merge",
			sources: [
				{ itemId: mergedId, revision: merged.revision },
				{ itemId: other.id, revision: other.revision },
			],
			key: "habits",
			text: "飲み物と運動",
		},
	]);
	if (second?.status !== "applied") throw new Error("merge rejected");
	const outcome = await h.forget([b.id]);
	expect(new Set(outcome.forgottenItemIds)).toEqual(
		new Set([a.id, b.id, mergedId, other.id, second.id as string]),
	);
	// Only what has nothing to do with the lineage stays.
	expect(stateIds(h)).toEqual([habit.id]);
});

test("forgetting one item leaves the other items that rest on the same message", async () => {
	const h = await setup();
	// One message carries three facts; the user asks to forget only one of them.
	const e1 = await exchange(
		h,
		"私は野口です。辛いものが苦手で、コーヒーはブラック派です",
		"了解",
	);
	const remember = async (key: string, text: string, quote: string) => {
		const [result] = await h.curate([
			{
				op: "remember",
				kind: "preference",
				key,
				text,
				messageId: e1.inputMessageId,
				quote,
			},
		]);
		if (result?.status !== "applied") throw new Error("rejected");
		return result.id as string;
	};
	const name = await remember("identity.name", "名前は野口", "野口です");
	const spicy = await remember(
		"food.spicy",
		"辛いものが苦手",
		"辛いものが苦手",
	);
	const coffee = await remember(
		"drink.coffee",
		"コーヒーはブラック",
		"ブラック派",
	);
	const outcome = await h.forget([coffee], []);
	expect(outcome.forgottenItemIds).toEqual([coffee]);
	// The message leaves the context, but the facts the user did not name stay.
	expect(outcome.blockedMessageIds).toContain(e1.inputMessageId);
	expect(new Set(stateIds(h))).toEqual(new Set([name, spicy]));
});

test("forgetting only a message blocks it without forgetting the items that rest on it", async () => {
	const h = await setup();
	const e1 = await exchange(h, "私は辛いものが好きです", "了解");
	const spicy = await h.remember({
		conversationId: "c1",
		messageId: e1.inputMessageId,
		quote: "辛いものが好き",
		kind: "preference",
		semanticKey: "food.spicy",
		text: "辛いものが好き",
	});
	const outcome = await h.forget([], [e1.inputMessageId]);
	expect(outcome.forgottenItemIds).toEqual([]);
	expect(outcome.blockedMessageIds.sort()).toEqual(
		[e1.inputMessageId, e1.answerMessageId].sort(),
	);
	expect(stateIds(h)).toEqual([spicy.id]);
});

test("a replacement or merge by the steward does not expire a run in flight; a stop does", async () => {
	const h = await setup();
	const a = await h.seed("コーヒーが好き", "drink.coffee");
	const b = await h.seed("紅茶が好き", "drink.tea");
	const prepared = async () => {
		const window = await h.window();
		return h.memory.preparedWindow(window);
	};
	const validate = (window: Awaited<ReturnType<typeof prepared>>) =>
		h.store.write((db) =>
			h.memory.validateWindowInTransaction(db, "run-x", window),
		);
	let window = await prepared();
	// A replacement (the steward's update, even with a denial).
	const [updated] = await h.curate(
		[
			{
				op: "update",
				itemId: a.id,
				revision: a.revision,
				text: "コーヒーは苦手",
				negated: true,
				messageId: a.sourceMessageIds[0]!,
				quote: "コーヒーが好き",
			},
		],
		"seed",
	);
	expect(updated?.status).toBe("applied");
	expect(await validate(window)).toEqual({ ok: true });
	// A merge.
	const newer = h.memory.list(false);
	const [x, y] = [
		newer.find((i) => i.semanticKey === "drink.coffee")!,
		newer.find((i) => i.id === b.id)!,
	];
	const [merged] = await h.curate([
		{
			op: "merge",
			sources: [
				{ itemId: x.id, revision: x.revision },
				{ itemId: y.id, revision: y.revision },
			],
			key: "drink",
			text: "飲み物の話",
		},
	]);
	expect(merged?.status).toBe("applied");
	expect(await validate(window)).toEqual({ ok: true });
	// A stop is content that must not be used any more.
	const mergedItem = h.memory
		.list(false)
		.find((i) => i.semanticKey === "drink")!;
	await h.stop(mergedItem.id, mergedItem.revision);
	expect(await validate(window)).toEqual({ ok: false, reason: "memory_stale" });
	window = await prepared();
	expect(await validate(window)).toEqual({ ok: true });
});

test("the purge hook is told which conversations' summaries the forget deleted", async () => {
	const h = await setup();
	const purges: ForgetPurge[] = [];
	h.memory.registerForgetPurge((_db, purge) => {
		purges.push(purge);
	});
	const e1 = await exchange(h, "住所は大阪です", "了解");
	const e2 = await exchange(h, "好きな色は青です", "了解");
	await h.store.write((db) =>
		h.memory.writeSummaryInTransaction(db, {
			conversationId: "c1",
			text: "住所と色の話",
			included: [e1.inputMessageId, e2.inputMessageId],
			expectedRevision: 0,
		}),
	);
	await h.forget([], [e1.inputMessageId]);
	expect(purges).toHaveLength(1);
	expect(purges[0]?.deletedSummaryConversationIds).toEqual(["c1"]);
	// Nothing stood on this message in a summary: the list is empty.
	const e3 = await exchange(h, "晴れでした", "そうですね");
	await h.forget([], [e3.inputMessageId]);
	expect(purges[1]?.deletedSummaryConversationIds).toEqual([]);
});

test("a restart re-applies only the lines the database has not recorded", async () => {
	const h = await setup();
	const purges: ForgetPurge[] = [];
	h.memory.registerForgetPurge((_db, purge) => {
		purges.push(purge);
	});
	const e1 = await exchange(h, "住所は大阪です", "了解");
	await h.forget([], [e1.inputMessageId]);
	expect(purges).toHaveLength(1);
	expect(await h.memory.recover()).toMatchObject({ healthy: true });
	expect(purges).toHaveLength(1);
	// A restored older database lost the marks: the line is applied again.
	await h.store.write((db) =>
		db.query("DELETE FROM memory_block_applied").run(),
	);
	await h.memory.recover();
	expect(purges).toHaveLength(2);
	await h.memory.recover();
	expect(purges).toHaveLength(2);
});

test("while memory is unhealthy the block journal's messages stay hidden, even those the database does not know", async () => {
	const h = await setup();
	const path = blockJournalPathOf(join(h.dir, "journal.jsonl"));
	appendJournal<BlockJournalEntry>(path, {
		forgetId: "f-ghost",
		conversationId: "c1",
		messageIds: ["ghost-1"],
		itemIds: [],
		at: h.time.now,
	});
	// The forget journal is broken: memory goes unhealthy, but the block journal is readable.
	writeFileSync(join(h.dir, "journal.jsonl"), "{not json\n");
	expect(await h.memory.recover()).toMatchObject({ healthy: false });
	const hidden = h.store.read((db) =>
		h.memory.blockedMessageIdsInTransaction(db, ["ghost-1", "visible"]),
	);
	expect([...hidden]).toEqual(["ghost-1"]);
	expect([...h.memory.blockedMessageIds(["ghost-1", "visible"])]).toEqual([
		"ghost-1",
	]);
	expect(
		h.store.read((db) =>
			h.memory.blockedMessageIdsOfConversationInTransaction(db, "c1"),
		),
	).toContain("ghost-1");
});

test("one forget call takes at most five explicit items", async () => {
	const h = await setup();
	const unknown = (n: number) => `state:${String(n).padStart(64, "0")}`;
	const ids = [1, 2, 3, 4, 5, 6].map(unknown);
	await expect(h.forget(ids)).rejects.toThrow("forget_limit");
	// Five pass the limit (and are refused only because they do not exist).
	await expect(h.forget(ids.slice(0, 5))).rejects.toThrow(
		"invalid_memory_item",
	);
	expect(
		h.store.read(
			(db) =>
				(
					db.query("SELECT COUNT(*) AS n FROM memory_block_applied").get() as {
						n: number;
					}
				).n,
		),
	).toBe(0);
});

test("notes: several sources, a refused blocked or foreign source, sources added by an update, any source forgotten deletes the note", async () => {
	const h = await setup();
	const e1 = await exchange(h, "予算は3万円です", "了解");
	const e2 = await exchange(h, "納期は来月です", "了解");
	const e3 = await exchange(h, "場所は東京です", "了解");
	const foreign = await h.say("user", "別の話", "c2");
	const [empty] = await h.curate([
		{ op: "note_add", kind: "memo", text: "x", messageIds: [] },
	]);
	expect(empty).toMatchObject({ status: "rejected", reason: "invalid_source" });
	const [other] = await h.curate([
		{
			op: "note_add",
			kind: "memo",
			text: "x",
			messageIds: [e1.inputMessageId, foreign],
		},
	]);
	expect(other).toMatchObject({ status: "rejected", reason: "invalid_source" });
	const [added] = await h.curate([
		{
			op: "note_add",
			kind: "decision",
			text: "予算3万円、納期来月",
			messageIds: [e1.inputMessageId, e2.inputMessageId],
		},
	]);
	if (added?.status !== "applied") throw new Error("rejected");
	expect(h.continuity.list("c1")[0]?.sourceMessageIds).toEqual([
		e1.inputMessageId,
		e2.inputMessageId,
	]);
	// Block e3 (a scheduled prompt), then try to use it as a source.
	await h.store.write((db) =>
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "c1",
			messageIds: [e3.inputMessageId],
			reason: "scheduled_prompt",
		}),
	);
	const [blocked] = await h.curate([
		{
			op: "note_update",
			noteId: added.id as string,
			revision: added.revision as number,
			text: "場所も",
			messageIds: [e3.inputMessageId],
		},
	]);
	expect(blocked).toMatchObject({
		status: "rejected",
		reason: "blocked_source",
	});
	// The union: a source already present is kept once.
	const e4 = await exchange(h, "人数は5人です", "了解");
	const [updated] = await h.curate([
		{
			op: "note_update",
			noteId: added.id as string,
			revision: added.revision as number,
			text: "予算3万円、納期来月、5人",
			messageIds: [e2.inputMessageId, e4.inputMessageId],
		},
	]);
	expect(updated?.status).toBe("applied");
	expect(h.continuity.list("c1")[0]?.sourceMessageIds).toEqual([
		e1.inputMessageId,
		e2.inputMessageId,
		e4.inputMessageId,
	]);
	// Forgetting any one of the sources deletes the note.
	await h.forget([], [e4.inputMessageId]);
	expect(h.continuity.list("c1", true)).toEqual([]);
});
