import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_VERSIONS } from "eumenes-memory";
import { planForget } from "eumenes-memory/sqlite";
import { configureLogging } from "../../../infrastructure/logger";
import { openStore } from "../../../infrastructure/sqlite";
import { createConversationService } from "../../conversation";
import { createContinuityService } from "../../continuity";
import { createMemoryService } from "..";
import type { ForgetPurge } from "../contracts";
import { PRINCIPAL, PROFILE_SCOPE } from "../contracts";
import { putTurnVector } from "../repository";
import {
	appendJournal,
	blockJournalPathOf,
	readJournal,
	type BlockJournalEntry,
} from "../service/journal";
import {
	memoryTestMigrations,
	setupMemory,
	type MemoryHarness,
} from "./memory.fixture";

const open: MemoryHarness[] = [];
const extra: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const cleanup of extra.splice(0).reverse()) await cleanup();
	for (const h of open.splice(0)) await h.close();
});

/** Three exchanges in c1; the address fact (two versions) and a note come from the first; the summary covers all three. */
async function scenario() {
	const h = await setupMemory();
	open.push(h);
	const purges: ForgetPurge[] = [];
	h.memory.registerForgetPurge((_db, purge) => {
		purges.push(purge);
	});
	let n = 0;
	const exchange = async (user: string, answer: string) => {
		const runId = `run-s${++n}`;
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
	const old = await exchange("住所は大阪市です", "了解しました（大阪）");
	const address = await exchange(
		"住所は東京都千代田区に引っ越しました",
		"了解しました（東京）",
	);
	const food = await exchange("好きな食べ物はカレーです", "カレーいいですね");
	const weather = await exchange("今日は天気がいいですね", "そうですね");
	const first = await h.remember({
		conversationId: "c1",
		messageId: old.inputMessageId,
		quote: "住所は大阪市",
		kind: "personal_fact",
		semanticKey: "address",
		text: "住所は大阪市",
	});
	const second = await h.remember({
		conversationId: "c1",
		messageId: address.inputMessageId,
		quote: "東京都千代田区に引っ越しました",
		kind: "personal_fact",
		semanticKey: "address",
		text: "住所は東京都千代田区",
	});
	const curry = await h.remember({
		conversationId: "c1",
		messageId: food.inputMessageId,
		quote: "カレー",
		kind: "preference",
		semanticKey: "food",
		text: "カレーが好き",
	});
	const [tendency] = await h.curate([
		{
			op: "tendency_add",
			text: "引っ越しとカレー",
			evidence: [
				{ namespace: "state", id: second.id },
				{ namespace: "state", id: curry.id },
			],
		},
	]);
	const [addressNote, weatherNote] = await h.curate([
		{
			op: "note_add",
			kind: "memo",
			text: "千代田区に住んでいる",
			messageIds: [address.inputMessageId],
		},
		{
			op: "note_add",
			kind: "memo",
			text: "天気の話",
			messageIds: [weather.inputMessageId],
		},
	]);
	await h.store.write((db) => {
		for (const [i, id] of [
			old.inputMessageId,
			old.answerMessageId,
			address.inputMessageId,
			address.answerMessageId,
			food.inputMessageId,
			weather.inputMessageId,
		].entries())
			putTurnVector(db, {
				messageId: id,
				conversationId: "c1",
				ordinal: i,
				space: "s",
				vector: new Uint8Array(4),
				digest: "d",
				createdAt: h.time.now,
			});
		h.memory.writeSummaryInTransaction(db, {
			conversationId: "c1",
			text: "引っ越しと食べ物の話をした",
			included: [
				old.inputMessageId,
				address.inputMessageId,
				food.inputMessageId,
			],
			expectedRevision: 0,
		});
	});
	await h.window();
	return {
		h,
		purges,
		old,
		address,
		food,
		weather,
		first,
		second,
		curry,
		tendency,
		addressNote,
		weatherNote,
	};
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

const blockRows = (h: MemoryHarness) =>
	h.store.read(
		(db) =>
			db
				.query(
					"SELECT message_id AS id, reason, forget_id AS forgetId, conversation_id AS conversationId FROM memory_message_block ORDER BY message_id",
				)
				.all() as Array<{
				id: string;
				reason: string;
				forgetId: string | null;
				conversationId: string;
			}>,
	);
const count = (h: MemoryHarness, sql: string) =>
	h.store.read((db) => (db.query(sql).get() as { n: number }).n);
const journalPath = (h: MemoryHarness) => join(h.dir, "journal.jsonl");
const blockPath = (h: MemoryHarness) => blockJournalPathOf(journalPath(h));

/** Everything section 6.2 says must be gone, and what must stay, after the forget of the address. */
function expectForgotten(s: Scenario) {
	const { h } = s;
	const blocked = new Set(blockRows(h).map((row) => row.id));
	expect(blocked).toEqual(
		new Set([
			s.old.inputMessageId,
			s.old.answerMessageId,
			s.address.inputMessageId,
			s.address.answerMessageId,
		]),
	);
	expect(
		blockRows(h).every((row) => row.reason === "forgotten" && row.forgetId),
	).toBe(true);
	// State of every version is gone.
	expect(h.memory.list(true).map((item) => item.id)).toEqual([s.curry.id]);
	// The original conversation stays whole.
	for (const id of blocked) {
		const found = h.store.read((db) =>
			h.conversation.messageInTransaction(db, id),
		);
		expect(found?.message.text.length).toBeGreaterThan(0);
	}
	// Notes from the blocked messages are deleted for good (no row, no text); the others stay.
	const notes = h.continuity.list("c1", true);
	expect(notes.map((note) => note.id)).toEqual([
		(s.weatherNote as { id: string }).id,
	]);
	expect(notes[0]?.status).toBe("active");
	const continuityDump = h.store.read((db) =>
		JSON.stringify([
			db.query("SELECT * FROM continuity_items").all(),
			db.query("SELECT * FROM continuity_revisions").all(),
		]),
	);
	expect(continuityDump).not.toContain("千代田区に住んでいる");
	expect(continuityDump).toContain("天気の話");
	// Tendencies built on the forgotten item go.
	expect(h.memory.tendencies()).toEqual([]);
	// Turn vectors of the blocked messages go; the others stay.
	const vectors = h.store
		.read(
			(db) =>
				db
					.query("SELECT message_id AS id FROM memory_turn_vector")
					.all() as Array<{ id: string }>,
		)
		.map((row) => row.id)
		.sort();
	expect(vectors).toEqual(
		[s.food.inputMessageId, s.weather.inputMessageId].sort(),
	);
	// The summary and its sources go; exchanges it stood on that remain are to be summarized again.
	expect(
		h.store.read((db) => h.memory.summaryInTransaction(db, "c1")),
	).toBeNull();
	expect(count(h, "SELECT COUNT(*) AS n FROM memory_summary_source")).toBe(0);
	const rows = h.memory.exchanges("c1");
	const byInput = new Map(rows.map((row) => [row.inputMessageId, row]));
	expect(byInput.get(s.old.inputMessageId)?.disposition).toBe("drop");
	expect(byInput.get(s.address.inputMessageId)?.disposition).toBe("drop");
	expect(byInput.get(s.food.inputMessageId)).toMatchObject({
		disposition: "summarize",
		summarized: null,
		state: "pending",
	});
	// No step offers a blocked exchange; the one to re-summarize is offered.
	expect(
		h.store
			.read((db) =>
				h.memory.pendingExchangesInTransaction(db, "c1", "curated", 10),
			)
			.map((r) => r.inputMessageId),
	).toEqual([s.food.inputMessageId, s.weather.inputMessageId]);
	expect(
		h.store
			.read((db) =>
				h.memory.pendingExchangesInTransaction(db, "c1", "summarized", 10),
			)
			.map((r) => r.inputMessageId),
	).toEqual([s.food.inputMessageId]);
	// The rendered windows that held the text are gone.
	expect(count(h, "SELECT COUNT(*) AS n FROM memory_context_window")).toBe(0);
	expect(
		count(
			h,
			"SELECT COUNT(*) AS n FROM memory_item_provenance WHERE item_id IN ('" +
				`${s.first.id}','${s.second.id}')`,
		),
	).toBe(0);
}

test("a forget blocks the evidence of every version, the steward's picks and the exchange partners, and removes what was derived", async () => {
	const s = await scenario();
	const { h } = s;
	const seqBefore = h.store.read((db) => h.memory.forgetSeqInTransaction(db));
	// The steward also found the food exchange; here it picks the weather exchange's user message instead.
	const outcome = await h.memory.forget({
		conversationId: "c1",
		itemIds: [s.second.id],
		messageIds: [],
	});
	expect(outcome.completed).toBe(true);
	expect(new Set(outcome.forgottenItemIds)).toEqual(
		new Set([s.first.id, s.second.id]),
	);
	expect(new Set(outcome.blockedMessageIds)).toEqual(
		new Set([
			s.old.inputMessageId,
			s.old.answerMessageId,
			s.address.inputMessageId,
			s.address.answerMessageId,
		]),
	);
	expectForgotten(s);
	expect(blockRows(h).every((row) => row.forgetId === outcome.forgetId)).toBe(
		true,
	);
	expect(h.store.read((db) => h.memory.forgetSeqInTransaction(db))).toBe(
		seqBefore + 1,
	);
	// The steward's hook ran in the same transaction with the item and message ids.
	expect(s.purges).toHaveLength(1);
	expect(new Set(s.purges[0]!.itemIds)).toEqual(
		new Set([s.first.id, s.second.id]),
	);
	expect(new Set(s.purges[0]!.messageIds)).toEqual(
		new Set(outcome.blockedMessageIds),
	);
	expect(s.purges[0]!.conversationId).toBe("c1");
	// The intent is in the block journal.
	const lines = readJournal<BlockJournalEntry>(blockPath(h));
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatchObject({
		forgetId: outcome.forgetId,
		conversationId: "c1",
	});
	expect(new Set(lines[0]!.itemIds)).toEqual(
		new Set([s.first.id, s.second.id]),
	);
	expect(new Set(lines[0]!.messageIds)).toEqual(
		new Set(outcome.blockedMessageIds),
	);
});

test("messages the steward found (alsoIn) are blocked with their partner, also when no item is forgotten", async () => {
	const s = await scenario();
	const { h } = s;
	const outcome = await h.memory.forget({
		conversationId: "c1",
		itemIds: [s.curry.id],
		messageIds: [s.weather.answerMessageId!, "no-such-message"],
	});
	expect(new Set(outcome.blockedMessageIds)).toEqual(
		new Set([
			s.food.inputMessageId,
			s.food.answerMessageId,
			s.weather.inputMessageId,
			s.weather.answerMessageId,
		]),
	);
	expect(blockRows(h).map((row) => row.id)).not.toContain("no-such-message");
	await expect(
		h.memory.forget({ conversationId: "c1", itemIds: [], messageIds: [] }),
	).rejects.toThrow("invalid_forget");
	await expect(
		h.memory.forget({
			conversationId: "c1",
			itemIds: ["junk"],
			messageIds: [],
		}),
	).rejects.toThrow("invalid_memory_item");
});

test("blocked messages stay blocked with memory switched off, and a block of a scheduled prompt is not upgraded away", async () => {
	const s = await scenario();
	const { h } = s;
	await h.store.write((db) =>
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "c1",
			messageIds: [s.old.inputMessageId],
			reason: "scheduled_prompt",
		}),
	);
	await h.memory.setEnabled(false);
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [s.second.id],
		messageIds: [],
	});
	const row = blockRows(h).find((r) => r.id === s.old.inputMessageId);
	expect(row?.reason).toBe("forgotten");
	expect(
		h.memory.blockedMessageIds([
			s.address.inputMessageId,
			s.weather.inputMessageId,
		]),
	).toEqual(new Set([s.address.inputMessageId]));
});

// ---- 忘却の完遂: where the process may stop ----

const beforeRecovery = (s: Scenario) => {
	const memory2 = createMemoryService(
		s.h.store,
		s.h.conversation,
		createContinuityService(s.h.store, () => s.h.time.now),
		{ journalPath: journalPath(s.h), clock: () => s.h.time.now },
	);
	return memory2;
};
const intentOf = (s: Scenario): BlockJournalEntry => ({
	forgetId: "forget-crash",
	conversationId: "c1",
	messageIds: [
		s.address.answerMessageId!,
		s.address.inputMessageId,
		s.old.inputMessageId,
		s.old.answerMessageId!,
	],
	itemIds: [s.first.id, s.second.id],
	at: s.h.time.now,
});

test("stop position 1: only the block journal was written. Start-up completes the State forget and the derived deletions; until then memory is not used", async () => {
	const s = await scenario();
	const { h } = s;
	appendJournal(blockPath(h), intentOf(s));
	expect(existsSync(journalPath(h))).toBe(false);
	const memory2 = beforeRecovery(s);
	memory2.registerForgetPurge((_db, purge) => {
		s.purges.push(purge);
	});
	// Not reconciled yet: neither State nor a window is used.
	expect(memory2.list(true)).toEqual([]);
	expect(
		await h.store.write((db) => memory2.windowForRunInTransaction(db, "c1")),
	).toBeNull();
	expect(memory2.status().healthy).toBe(false);
	const recovered = await memory2.recover();
	expect(recovered.healthy).toBe(true);
	expectForgotten(s);
	// Both versions are in the forget journal now.
	const entries = readJournal(journalPath(h));
	expect(entries).toHaveLength(2);
	expect(s.purges.at(-1)?.messageIds.length).toBe(4);
	// Idempotent: a second start changes nothing and journals nothing more.
	const again = beforeRecovery(s);
	expect((await again.recover()).healthy).toBe(true);
	expectForgotten(s);
	expect(readJournal(journalPath(h))).toHaveLength(2);
	expect(readJournal(blockPath(h))).toHaveLength(1);
});

test("stop position 2: the forget journal was written too (for one version), the database was not changed. The reconciliation and the derived deletions reach the same state", async () => {
	const s = await scenario();
	const { h } = s;
	appendJournal(blockPath(h), intentOf(s));
	// Only the first of the two versions reached the forget journal before the stop.
	const planned = h.store.read((db) =>
		planForget(db, {
			contractVersion: CONTRACT_VERSIONS.lifecycle,
			access: {
				principal: PRINCIPAL,
				scopeKeys: [PROFILE_SCOPE],
				purpose: "memory.forget",
				policyRevision: h.memory.policyRevisionInTransaction(db),
			},
			target: {
				type: "state_item",
				itemId: s.first.id,
				scopeKey: PROFILE_SCOPE,
			},
			clock: { atMs: Date.parse(h.time.now) },
		}),
	);
	if (planned.status !== "planned") throw new Error("not planned");
	appendJournal(journalPath(h), planned.plan.entry);
	// The database still has everything.
	expect(h.memory.list(true)).toHaveLength(3);
	const memory2 = beforeRecovery(s);
	expect(memory2.list(true)).toEqual([]);
	const recovered = await memory2.recover();
	expect(recovered).toMatchObject({ healthy: true, reapplied: 1 });
	expect(readJournal(journalPath(h))).toHaveLength(2);
	expectForgotten(s);
});

test("stop position 3: the transaction rolled back after both journals were written. Recovery reaches the same state", async () => {
	const s = await scenario();
	const { h } = s;
	await expect(
		h.store.write((db) => {
			h.memory.forgetInTransaction(db, {
				conversationId: "c1",
				itemIds: [s.second.id],
				messageIds: [],
			});
			throw new Error("crash");
		}),
	).rejects.toThrow("crash");
	// Both journals hold the intent while the database has rolled back.
	expect(readJournal<BlockJournalEntry>(blockPath(h))).toHaveLength(1);
	expect(readJournal(journalPath(h))).toHaveLength(2);
	const memory2 = beforeRecovery(s);
	expect((await memory2.recover()).healthy).toBe(true);
	// The first service reconciles itself too (it was queued behind the rolled-back transaction).
	await h.memory.recover();
	expectForgotten(s);
	expect(readJournal<BlockJournalEntry>(blockPath(h))).toHaveLength(1);
});

test("an older database restored over the forget is brought to the same state by the journals", async () => {
	const s = await scenario();
	const { h } = s;
	await h.store.write((db) => db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
	const backup = join(h.dir, "backup.sqlite3");
	copyFileSync(join(h.dir, "db.sqlite3"), backup);
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [s.second.id],
		messageIds: [],
	});
	expectForgotten(s);
	await h.store.close();
	copyFileSync(backup, join(h.dir, "db.sqlite3"));
	const store = openStore(join(h.dir, "db.sqlite3"), memoryTestMigrations);
	extra.push(() => store.close());
	// The restored database knows nothing of the forget.
	expect(
		store.read(
			(db) =>
				(
					db.query("SELECT COUNT(*) AS n FROM memory_message_block").get() as {
						n: number;
					}
				).n,
		),
	).toBe(0);
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store, () => h.time.now);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: journalPath(h),
		clock: () => h.time.now,
	});
	const purges: ForgetPurge[] = [];
	memory.registerForgetPurge((_db, purge) => {
		purges.push(purge);
	});
	expect(await memory.recover()).toMatchObject({ healthy: true, reapplied: 2 });
	expect(purges).toHaveLength(1);
	// The same checks, on the restored database.
	const restored = {
		...s,
		h: { ...h, store, memory, continuity, conversation } as MemoryHarness,
	};
	expectForgotten(restored);
});

test("a corrupt block journal makes memory unusable instead of being skipped", async () => {
	const s = await scenario();
	const { h } = s;
	writeFileSync(blockPath(h), "{not json\n");
	const result = await h.memory.recover();
	expect(result).toMatchObject({
		healthy: false,
		reason: "block_journal_unreadable",
	});
	expect(h.memory.list(true)).toEqual([]);
	expect(readFileSync(blockPath(h), "utf8")).toBe("{not json\n");
});
