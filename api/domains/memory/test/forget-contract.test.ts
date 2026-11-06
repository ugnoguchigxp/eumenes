import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_VERSIONS } from "eumenes-memory";
import { planForget } from "eumenes-memory/sqlite";
import { configureLogging } from "../../../infrastructure/logger";
import { openStore } from "../../../infrastructure/sqlite";
import { createConversationService } from "../../conversation";
import { createContinuityFixture } from "../../../application/world/state-services.fixture";
import { createContinuityService } from "../../continuity";
import { createMemoryService } from "..";
import type { ForgetPurge } from "../contracts";
import { PRINCIPAL, PROFILE_SCOPE } from "../contracts";
import { putTurnVector } from "../repository";
import {
	appendJournal,
	blockJournalPathOf,
	hostIntentOf,
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

/** Four exchanges in c1 (each is two events); the address fact (two versions) and a note come from the first two; the episode summary covers three of them. */
async function scenario() {
	const h = await setupMemory();
	open.push(h);
	const purges: ForgetPurge[] = [];
	h.memory.registerForgetPurge((_db, purge) => {
		purges.push(purge);
	});
	const exchange = async (user: string, answer: string) => {
		const said = await h.exchange(user, answer);
		return {
			inputMessageId: said.userId,
			answerMessageId: said.answerId!,
			seqs: said.seqs,
		};
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
	// The active short-term memory: the events that showed a blocked message keep only that they existed, the
	// others are untouched, and the episode summary that stood on a blocked message is an unsummarized range.
	const events = h.store.read((db) => [
		...h.continuity.events.logInTransaction(db, "c1"),
	]);
	const gone = new Set([
		s.old.inputMessageId,
		s.old.answerMessageId,
		s.address.inputMessageId,
		s.address.answerMessageId,
	]);
	for (const event of events) {
		const forgotten = event.messageIds.some((id) => gone.has(id));
		expect(event.forgotten).toBe(forgotten);
		if (forgotten) expect(event.text).toContain('"forgotten":true');
		else expect(event.text).toContain('"text":');
	}
	expect(JSON.stringify(events)).not.toContain(
		"住所は東京都千代田区に引っ越しました",
	);
	expect(JSON.stringify(events)).not.toContain("了解しました（大阪）");
	// The steward is not offered the forgotten events as new work (they are marked forgotten, not removed).
	expect(
		h.store
			.read((db) => h.continuity.events.uncuratedInTransaction(db, "c1"))
			.filter((event) => !event.forgotten)
			.map((event) => event.seq),
	).toEqual([...s.food.seqs, ...s.weather.seqs]);
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
	// One forget is one forget journal line: both versions as targets, memory's intent in its hostIntent.
	const entries = readJournal(journalPath(h));
	expect(entries).toHaveLength(1);
	expect(new Set(entries[0]!.targets.map((target) => target.id))).toEqual(
		new Set([s.first.id, s.second.id]),
	);
	const intents = intentsOf(entries);
	expect(intents).toHaveLength(1);
	expect(intents[0]).toMatchObject({
		forgetId: outcome.forgetId,
		intent: { conversationId: "c1" },
	});
	expect(new Set(intents[0]!.intent.itemIds)).toEqual(
		new Set([s.first.id, s.second.id]),
	);
	expect(new Set(intents[0]!.intent.messageIds)).toEqual(
		new Set(outcome.blockedMessageIds),
	);
	expect(existsSync(blockPath(h))).toBe(false);
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
		createContinuityService(() => s.h.time.now),
		{ journalPath: journalPath(s.h), clock: () => s.h.time.now },
	);
	return memory2;
};

/** The forget journal entry a forget of the address writes (both versions, memory's intent), planned on `h`'s database. */
const plannedEntry = (
	s: Scenario,
	versions: readonly string[],
	intent: boolean,
) => {
	const { h } = s;
	const planned = h.store.read((db) =>
		planForget(db, {
			contractVersion: CONTRACT_VERSIONS.lifecycle,
			access: {
				principal: PRINCIPAL,
				scopeKeys: [PROFILE_SCOPE],
				purpose: "memory.forget",
				policyRevision: h.memory.policyRevisionInTransaction(db),
			},
			targets: versions.map((itemId) => ({
				type: "state_item" as const,
				itemId,
				scopeKey: PROFILE_SCOPE,
			})),
			...(intent ? { hostIntent: hostIntentOf(intentOfAddress(s)) } : {}),
			clock: { atMs: Date.parse(h.time.now) },
		}),
	);
	if (planned.status !== "planned") throw new Error("not planned");
	return planned.plan.entry;
};
const intentOfAddress = (s: Scenario) => ({
	conversationId: "c1",
	messageIds: [
		s.address.answerMessageId!,
		s.address.inputMessageId,
		s.old.inputMessageId,
		s.old.answerMessageId!,
	],
	itemIds: [s.first.id, s.second.id],
});

test("stop position 1: the forget journal line (both versions and the intent) was written, the database was not changed. Start-up completes the State forget and the derived deletions; until then memory is not used", async () => {
	const s = await scenario();
	const { h } = s;
	appendJournal(
		journalPath(h),
		plannedEntry(s, [s.first.id, s.second.id], true),
	);
	// The database still has everything.
	expect(h.memory.list(true)).toHaveLength(3);
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
	expect(recovered).toMatchObject({ healthy: true, reapplied: 1 });
	expectForgotten(s);
	expect(s.purges.at(-1)?.messageIds.length).toBe(4);
	// Idempotent: a second start changes nothing and journals nothing more.
	const again = beforeRecovery(s);
	expect((await again.recover()).healthy).toBe(true);
	expectForgotten(s);
	expect(readJournal(journalPath(h))).toHaveLength(1);
	expect(existsSync(blockPath(h))).toBe(false);
});

test("stop position 2: the transaction rolled back after the journal line was written. Recovery reaches the same state", async () => {
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
	// The journal holds the intent while the database has rolled back.
	expect(readJournal(journalPath(h))).toHaveLength(1);
	expect(intentsOf(readJournal(journalPath(h)))).toHaveLength(1);
	const memory2 = beforeRecovery(s);
	expect((await memory2.recover()).healthy).toBe(true);
	// The first service reconciles itself too (it was queued behind the rolled-back transaction).
	await h.memory.recover();
	expectForgotten(s);
	expect(readJournal(journalPath(h))).toHaveLength(1);
});

// ---- the block journal of earlier versions: imported once at start-up ----

const legacyIntent = (s: Scenario): BlockJournalEntry => ({
	forgetId: "forget-crash",
	...intentOfAddress(s),
	at: s.h.time.now,
});

test("earlier versions, stop position 1: only the block journal was written. Start-up imports it, completes the State forget and the derived deletions, and sets the file aside", async () => {
	const s = await scenario();
	const { h } = s;
	appendJournal(blockPath(h), legacyIntent(s));
	expect(existsSync(journalPath(h))).toBe(false);
	const memory2 = beforeRecovery(s);
	memory2.registerForgetPurge((_db, purge) => {
		s.purges.push(purge);
	});
	expect(memory2.list(true)).toEqual([]);
	expect(memory2.status().healthy).toBe(false);
	const recovered = await memory2.recover();
	expect(recovered.healthy).toBe(true);
	expectForgotten(s);
	// One forget journal entry carries both versions and the imported intent.
	const entries = readJournal(journalPath(h));
	expect(entries).toHaveLength(1);
	expect(intentsOf(entries)[0]?.intent.legacyBlockForgetId).toBe(
		"forget-crash",
	);
	expect(s.purges.at(-1)?.messageIds.length).toBe(4);
	expect(existsSync(blockPath(h))).toBe(false);
	expect(readJournal(`${blockPath(h)}.imported`)).toHaveLength(1);
	// Idempotent: a second start changes nothing and journals nothing more.
	const again = beforeRecovery(s);
	expect((await again.recover()).healthy).toBe(true);
	expectForgotten(s);
	expect(readJournal(journalPath(h))).toHaveLength(1);
});

test("earlier versions, stop position 2: the forget journal was written too (for one version), the database was not changed. The reconciliation, the import and the derived deletions reach the same state", async () => {
	const s = await scenario();
	const { h } = s;
	appendJournal(blockPath(h), legacyIntent(s));
	// Only the first of the two versions reached the forget journal (format 1, as earlier versions wrote it).
	const planned = h.store.read((db) =>
		planForget(db, {
			contractVersion: 1,
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
	expect(planned.plan.entry.journalFormat).toBe(1);
	appendJournal(journalPath(h), planned.plan.entry);
	expect(h.memory.list(true)).toHaveLength(3);
	const memory2 = beforeRecovery(s);
	expect(memory2.list(true)).toEqual([]);
	const recovered = await memory2.recover();
	expect(recovered).toMatchObject({ healthy: true, reapplied: 1 });
	// The old entry, then the imported intent with the version it never got to forget.
	const entries = readJournal(journalPath(h));
	expect(entries).toHaveLength(2);
	expect(entries[1]!.targets.map((target) => target.id)).toEqual([s.second.id]);
	expectForgotten(s);
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
	const continuity = createContinuityFixture(store, () => h.time.now);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: journalPath(h),
		clock: () => h.time.now,
	});
	const purges: ForgetPurge[] = [];
	memory.registerForgetPurge((_db, purge) => {
		purges.push(purge);
	});
	expect(await memory.recover()).toMatchObject({ healthy: true, reapplied: 1 });
	expect(purges).toHaveLength(1);
	// The same checks, on the restored database.
	const restored = {
		...s,
		h: { ...h, store, memory, continuity, conversation },
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
