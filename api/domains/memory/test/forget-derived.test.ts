import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { configureLogging } from "../../../infrastructure/logger";
import { openStore } from "../../../infrastructure/sqlite";
import { createContinuityService } from "../../continuity";
import { createConversationService } from "../../conversation";
import { createMemoryService } from "..";
import type { ForgetPurge } from "../contracts";
import {
	appendJournal,
	blockJournalPathOf,
	intentsOf,
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
async function setup() {
	const h = await setupMemory();
	open.push(h);
	const purges: ForgetPurge[] = [];
	h.memory.registerForgetPurge((_db, purge) => {
		purges.push(purge);
	});
	return { h, purges };
}
const exchange = async (h: MemoryHarness, user: string, answer: string) => {
	const said = await h.exchange(user, answer);
	return { inputMessageId: said.userId, answerMessageId: said.answerId! };
};
const journalPath = (h: MemoryHarness) => join(h.dir, "journal.jsonl");
const blockPath = (h: MemoryHarness) => blockJournalPathOf(journalPath(h));
const derived = { goalIds: ["goal-1", "goal-2"], other: ["x"] };

test("derived is written to the forget journal entry's intent and handed to the purge hook; a forget without it hands {}", async () => {
	const { h, purges } = await setup();
	const e1 = await exchange(h, "引っ越しを目指す", "応援します");
	const e2 = await exchange(h, "天気の話", "そうですね");
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [],
		messageIds: [e1.inputMessageId],
		derived,
	});
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [],
		messageIds: [e2.inputMessageId],
	});
	expect(purges.map((p) => p.derived)).toEqual([derived, {}]);
	const intents = intentsOf(readJournal(journalPath(h)));
	expect(intents).toHaveLength(2);
	expect(intents[0]?.intent.derived).toEqual(derived);
	expect(intents[1]?.intent).not.toHaveProperty("derived");
	// No block journal any more: the intent is in the forget journal's hash chain.
	expect(existsSync(blockPath(h))).toBe(false);
});

test("a forget with only derived ids (no item, no message) is accepted; an empty one or a malformed one is refused before anything is journaled", async () => {
	const { h, purges } = await setup();
	await expect(
		h.memory.forget({
			conversationId: "c1",
			itemIds: [],
			messageIds: [],
			derived: { goalIds: [] },
		}),
	).rejects.toThrow("invalid_forget");
	for (const bad of [
		{ goalIds: "goal-1" },
		{ goalIds: [1] },
		{ goalIds: [""] },
		{ "": ["a"] },
		["goal-1"],
	])
		await expect(
			h.memory.forget({
				conversationId: "c1",
				itemIds: [],
				messageIds: [],
				derived: bad as never,
			}),
		).rejects.toThrow("invalid_forget");
	expect(existsSync(journalPath(h))).toBe(false);
	expect(purges).toEqual([]);
	const outcome = await h.memory.forget({
		conversationId: "c1",
		itemIds: [],
		messageIds: [],
		derived: { goalIds: ["goal-1"] },
	});
	expect(outcome.blockedMessageIds).toEqual([]);
	expect(purges.map((p) => p.derived)).toEqual([{ goalIds: ["goal-1"] }]);
});

test("the forget inside the caller's transaction hands derived too, and a rollback leaves the journal line to replay it", async () => {
	const { h, purges } = await setup();
	const e1 = await exchange(h, "目標の話", "了解");
	await expect(
		h.store.write((db) => {
			h.memory.forgetInTransaction(db, {
				conversationId: "c1",
				itemIds: [],
				messageIds: [e1.inputMessageId],
				derived,
			});
			throw new Error("crash");
		}),
	).rejects.toThrow("crash");
	expect(intentsOf(readJournal(journalPath(h)))[0]?.intent.derived).toEqual(
		derived,
	);
	// The transaction rolled back; the reconciliation it queued re-applies the line and the hook sees derived again.
	await h.memory.recover();
	expect(purges.length).toBeGreaterThanOrEqual(2);
	expect(
		purges.every(
			(p) =>
				p.derived === derived ||
				JSON.stringify(p.derived) === JSON.stringify(derived),
		),
	).toBe(true);
	expect(
		h.store.read((db) =>
			h.memory.blockedMessageIdsInTransaction(db, [e1.inputMessageId]),
		).size,
	).toBe(1);
});

test("recovery replays derived only for the entries the reconciliation re-applied, not for the recorded ones", async () => {
	const { h, purges } = await setup();
	const e1 = await exchange(h, "一つ目", "了解");
	const e2 = await exchange(h, "二つ目", "了解");
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [],
		messageIds: [e1.inputMessageId],
		derived: { goalIds: ["g1"] },
	});
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [],
		messageIds: [e2.inputMessageId],
	});
	expect(purges).toHaveLength(2);
	await h.memory.recover();
	expect(purges).toHaveLength(2);
	// A third forget whose transaction rolls back after its line was written: the database has not recorded it.
	const e3 = await exchange(h, "三つ目", "了解");
	await expect(
		h.store.write((db) => {
			h.memory.forgetInTransaction(db, {
				conversationId: "c1",
				itemIds: [],
				messageIds: [e3.inputMessageId],
				derived: { goalIds: ["g3"] },
			});
			throw new Error("crash");
		}),
	).rejects.toThrow("crash");
	await h.memory.recover();
	const after = purges.length;
	// The rolled-back call and the re-application: only the third forget's derived, never g1 or {} again.
	expect(after).toBeGreaterThanOrEqual(4);
	expect(purges.slice(2).map((p) => p.derived)).toEqual(
		Array.from({ length: after - 2 }, () => ({ goalIds: ["g3"] })),
	);
	await h.memory.recover();
	expect(purges).toHaveLength(after);
});

test("a block journal line of an earlier version is imported once, with its derived ids replayed", async () => {
	const { h, purges } = await setup();
	appendJournal<BlockJournalEntry>(blockPath(h), {
		forgetId: "f-intent",
		conversationId: "c1",
		messageIds: [],
		itemIds: [],
		derived,
		at: h.time.now,
	});
	expect(await h.memory.recover()).toMatchObject({ healthy: true });
	expect(purges.map((p) => p.derived)).toEqual([derived]);
	// The line now lives in the forget journal and the old file is set aside.
	const intents = intentsOf(readJournal(journalPath(h)));
	expect(intents).toHaveLength(1);
	expect(intents[0]?.intent).toMatchObject({
		derived,
		legacyBlockForgetId: "f-intent",
	});
	expect(existsSync(blockPath(h))).toBe(false);
	expect(existsSync(`${blockPath(h)}.imported`)).toBe(true);
	// A second start imports nothing and replays nothing (the purge is recorded).
	expect(await h.memory.recover()).toMatchObject({ healthy: true });
	expect(purges).toHaveLength(1);
	expect(readJournal(journalPath(h))).toHaveLength(1);
});

test("a purge that fails while a block journal line is imported rolls the recovery back; the next start completes it once", async () => {
	const h = await setupMemory();
	open.push(h);
	let failing = true;
	const purges: ForgetPurge[] = [];
	h.memory.registerForgetPurge((_db, purge) => {
		if (failing) throw new Error("hook down");
		purges.push(purge);
	});
	appendJournal<BlockJournalEntry>(blockPath(h), {
		forgetId: "f-legacy",
		conversationId: "c1",
		messageIds: [],
		itemIds: [],
		derived,
		at: h.time.now,
	});
	expect(await h.memory.recover()).toMatchObject({
		healthy: false,
		reason: "block_recovery_failed",
	});
	// Nothing half-way is committed: the purge is not recorded, the old file is not set aside.
	expect(
		h.store.read((db) =>
			db
				.query(
					"SELECT 1 FROM memory_block_applied WHERE forget_id = 'f-legacy'",
				)
				.get(),
		),
	).toBeNull();
	expect(existsSync(blockPath(h))).toBe(true);
	failing = false;
	expect(await h.memory.recover()).toMatchObject({ healthy: true });
	expect(purges.map((p) => p.derived)).toEqual([derived]);
	expect(existsSync(blockPath(h))).toBe(false);
	// The imported line is in the forget journal once, and a further start replays nothing.
	expect(
		intentsOf(readJournal(journalPath(h))).filter(
			({ intent }) => intent.legacyBlockForgetId === "f-legacy",
		),
	).toHaveLength(1);
	expect(await h.memory.recover()).toMatchObject({ healthy: true });
	expect(purges).toHaveLength(1);
});

test("an older database restored over the forget gets derived replayed before memory is used again", async () => {
	const { h } = await setup();
	const e1 = await exchange(h, "引っ越しを目指す", "応援します");
	await h.store.write((db) => db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
	const backup = join(h.dir, "backup.sqlite3");
	copyFileSync(join(h.dir, "db.sqlite3"), backup);
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [],
		messageIds: [e1.inputMessageId],
		derived,
	});
	await h.store.close();
	copyFileSync(backup, join(h.dir, "db.sqlite3"));
	const store = openStore(join(h.dir, "db.sqlite3"), memoryTestMigrations);
	extra.push(() => store.close());
	const conversation = createConversationService(store);
	const continuity = createContinuityService(() => h.time.now);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: journalPath(h),
		clock: () => h.time.now,
	});
	const purges: ForgetPurge[] = [];
	memory.registerForgetPurge((_db, purge) => {
		purges.push(purge);
	});
	// Until recovery finishes the hooks, memory is not ready.
	expect(memory.status().healthy).toBe(false);
	expect(await memory.recover()).toMatchObject({ healthy: true });
	expect(purges).toHaveLength(1);
	expect(purges[0]).toMatchObject({
		derived,
		messageIds: expect.arrayContaining([e1.inputMessageId]),
	});
	// The message is blocked again in the restored database.
	expect(
		store.read((db) =>
			memory.blockedMessageIdsInTransaction(db, [e1.inputMessageId]),
		).size,
	).toBe(1);
});
