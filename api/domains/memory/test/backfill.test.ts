import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogging } from "../../../infrastructure/logger";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { createConversationService } from "../../conversation";
import { createContinuityService } from "../../continuity";
import { createMemoryService, retireExchangeLedgerMigration } from "..";
import { memoryTestMigrations } from "./memory.fixture";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Exchange = {
	user: string;
	answer: string | null;
	disposition: "keep" | "summarize" | "drop" | null;
	state: "pending" | "done";
};

/** A database as the earlier design left it: messages, exchanges with their dispositions and a summary. */
async function legacy(
	exchanges: Exchange[],
	summary?: { text: string; sources: number[] },
) {
	configureLogging({ level: "silent" });
	const dir = mkdtempSync(join(tmpdir(), "eumenes-backfill-"));
	const path = join(dir, "db.sqlite3");
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const before = memoryTestMigrations.filter(
		(m) => m !== retireExchangeLedgerMigration,
	);
	const old = openStore(path, before);
	const conversation = createConversationService(old);
	const ids: Array<{ input: string; answer: string | null }> = [];
	for (const [i, e] of exchanges.entries()) {
		const at = `2026-10-01T10:${String(i).padStart(2, "0")}:00.000Z`;
		const input = `u${i}`;
		await conversation.append({
			id: input,
			conversationId: "c1",
			role: "user",
			text: e.user,
			createdAt: at,
			runId: `run-${i}`,
		});
		let answer: string | null = null;
		if (e.answer !== null) {
			answer = `a${i}`;
			await conversation.append({
				id: answer,
				conversationId: "c1",
				role: "assistant",
				text: e.answer,
				createdAt: at,
				runId: `run-${i}`,
			});
		}
		ids.push({ input, answer });
	}
	await old.write((db) => {
		for (const [i, e] of exchanges.entries())
			db.query(
				`INSERT INTO memory_exchange (input_message_id, conversation_id, run_id, answer_message_id, outcome, input_ordinal,
				 answer_ordinal, state, disposition, failures, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			).run(
				ids[i]!.input,
				"c1",
				`run-${i}`,
				ids[i]!.answer,
				ids[i]!.answer === null ? "failed" : "answered",
				i + 1,
				ids[i]!.answer === null ? null : i + 2,
				e.state,
				e.disposition,
				"{}",
				"t",
				"t",
			);
		if (summary) {
			db.query(
				"INSERT INTO memory_conversation_summary (conversation_id, text, revision, updated_at) VALUES ('c1', ?, 2, '2026-10-01T09:00:00.000Z')",
			).run(summary.text);
			for (const source of summary.sources)
				db.query(
					"INSERT INTO memory_summary_source (conversation_id, revision, input_message_id) VALUES ('c1', 2, ?)",
				).run(ids[source]!.input);
		}
	});
	await old.close();
	return { path, ids };
}

async function upgrade(path: string) {
	const store: SqliteStore = openStore(path, memoryTestMigrations);
	cleanups.push(() => store.close().catch(() => {}));
	const conversation = createConversationService(store);
	const continuity = createContinuityService(
		store,
		() => "2026-10-24T00:00:00.000Z",
	);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: join(path, "..", "journal.jsonl"),
	});
	return { store, continuity, memory };
}
const tables = (store: SqliteStore) =>
	store
		.read(
			(db) =>
				db
					.query(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_%'",
					)
					.all() as Array<{ name: string }>,
		)
		.map((row) => row.name);

test("the recent exchanges become handled said events, oldest first, and the summary one episode part; the retired tables are dropped", async () => {
	const { path, ids } = await legacy(
		[
			{
				user: "古い話1",
				answer: "古い回答1",
				disposition: "summarize",
				state: "done",
			},
			{
				user: "古い話2",
				answer: "古い回答2",
				disposition: "summarize",
				state: "done",
			},
			{ user: "捨てた話", answer: "挨拶", disposition: "drop", state: "done" },
			{
				user: "残した話",
				answer: "残した回答",
				disposition: "keep",
				state: "done",
			},
			{ user: "途中の話", answer: null, disposition: null, state: "pending" },
			{
				user: "最新の前",
				answer: "回答A",
				disposition: "summarize",
				state: "done",
			},
			{
				user: "最新",
				answer: "回答B",
				disposition: "summarize",
				state: "done",
			},
		],
		{ text: "古い話をした", sources: [0, 1] },
	);
	const { store, continuity, memory } = await upgrade(path);
	// The migration only renames: the data waits for the backfill.
	expect(tables(store)).toContain("memory_retired_exchange");
	expect((await memory.recover()).healthy).toBe(true);
	const log = store.read((db) => continuity.events.logInTransaction(db, "c1"));
	expect(
		log.map((e) => [
			e.type,
			e.by,
			JSON.parse(e.text!).text,
			e.messageIds,
			e.curated,
		]),
	).toEqual([
		["said", "user", "残した話", [ids[3]!.input], true],
		["said", "agent", "残した回答", [ids[3]!.answer], true],
		["said", "user", "途中の話", [ids[4]!.input], false],
		["said", "user", "最新の前", [ids[5]!.input], true],
		["said", "agent", "回答A", [ids[5]!.answer], true],
		["said", "user", "最新", [ids[6]!.input], true],
		["said", "agent", "回答B", [ids[6]!.answer], true],
	]);
	expect(JSON.parse(log[1]!.text!).origin).toBe("reply");
	expect(log.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
	expect(log[0]!.at).toBe("2026-10-01T19:03:00+09:00");
	const episode = store.read((db) =>
		continuity.events.episodeInTransaction(db, "c1"),
	);
	expect(episode).toEqual([
		{
			kind: "summary",
			fromSeq: 0,
			toSeq: 0,
			fromAt: "2026-10-01T19:00:00+09:00",
			toAt: "2026-10-01T19:01:00+09:00",
			count: 4,
			text: "古い話をした",
			messageIds: [
				ids[0]!.input,
				ids[0]!.answer!,
				ids[1]!.input,
				ids[1]!.answer!,
			],
		},
	]);
	// Only the unfinished exchange is left for the new steward.
	expect(
		store
			.read((db) => continuity.events.uncuratedInTransaction(db, "c1"))
			.map((e) => e.messageIds),
	).toEqual([[ids[4]!.input]]);
	for (const retired of [
		"memory_retired_exchange",
		"memory_retired_summary",
		"memory_retired_summary_source",
	])
		expect(tables(store)).not.toContain(retired);
	// A second start finds nothing to do and changes nothing.
	expect((await memory.recover()).healthy).toBe(true);
	expect(
		store.read((db) => continuity.events.logInTransaction(db, "c1")),
	).toHaveLength(7);
});

test("a conversation that already has events is left alone, and blocked messages stay out", async () => {
	const { path, ids } = await legacy([
		{ user: "忘れた話", answer: "回答", disposition: "keep", state: "pending" },
		{
			user: "普通の話",
			answer: "普通の回答",
			disposition: "keep",
			state: "done",
		},
	]);
	const first = await upgrade(path);
	await first.store.write((db) => {
		db.query(
			"INSERT INTO memory_message_block (message_id, conversation_id, reason, forget_id, created_at) VALUES (?, 'c1', 'forgotten', 'f', 't')",
		).run(ids[0]!.input);
	});
	await first.memory.recover();
	const log = first.store.read((db) =>
		first.continuity.events.logInTransaction(db, "c1"),
	);
	expect(log.map((e) => JSON.parse(e.text!).text)).toEqual([
		"普通の話",
		"普通の回答",
	]);

	const existing = await legacy([
		{ user: "古い発言", answer: null, disposition: "keep", state: "done" },
	]);
	const second = await upgrade(existing.path);
	await second.store.write((db) =>
		second.continuity.events.appendInTransaction(db, {
			conversationId: "c1",
			at: "2026-10-02T00:00:00.000Z",
			type: "said",
			by: "user",
			fields: { text: "新しい発言" },
		}),
	);
	await second.memory.recover();
	expect(
		second.store
			.read((db) => second.continuity.events.logInTransaction(db, "c1"))
			.map((e) => JSON.parse(e.text!).text),
	).toEqual(["新しい発言"]);
	// The conversation that already had events keeps its retired rows: the tables stay.
	expect(tables(second.store)).toContain("memory_retired_exchange");
	await second.memory.recover();
	expect(
		second.store.read((db) =>
			second.continuity.events.logInTransaction(db, "c1"),
		),
	).toHaveLength(1);
});

test("a summary that stands on a blocked message is not written", async () => {
	const { path, ids } = await legacy(
		[
			{
				user: "古い話1",
				answer: "回答1",
				disposition: "summarize",
				state: "done",
			},
			{
				user: "古い話2",
				answer: "回答2",
				disposition: "summarize",
				state: "done",
			},
			{
				user: "残した話",
				answer: "残した回答",
				disposition: "keep",
				state: "done",
			},
			{
				user: "最新の前",
				answer: "回答A",
				disposition: "summarize",
				state: "done",
			},
			{
				user: "最新",
				answer: "回答B",
				disposition: "summarize",
				state: "done",
			},
		],
		{ text: "古い話をした", sources: [0, 1] },
	);
	const { store, continuity, memory } = await upgrade(path);
	await store.write((db) => {
		db.query(
			"INSERT INTO memory_message_block (message_id, conversation_id, reason, forget_id, created_at) VALUES (?, 'c1', 'forgotten', 'f', 't')",
		).run(ids[1]!.input);
	});
	await memory.recover();
	expect(
		store.read((db) => continuity.events.episodeInTransaction(db, "c1")),
	).toEqual([]);
});

test("a long utterance keeps its head and a reference to the message", async () => {
	const { path, ids } = await legacy([
		{
			user: "あ".repeat(20_000),
			answer: "了解",
			disposition: "keep",
			state: "done",
		},
	]);
	const { store, continuity, memory } = await upgrade(path);
	await memory.recover();
	const [user] = store.read((db) =>
		continuity.events.logInTransaction(db, "c1"),
	);
	const fields = JSON.parse(user!.text!);
	expect(fields.textCut).toBe(true);
	expect(fields.ref).toBe(ids[0]!.input);
	expect(fields.text.length).toBeGreaterThan(100);
	expect(fields.text.length).toBeLessThan(20_000);
	expect(user!.tokens).toBeLessThan(memory.windowPlan().log.cap * 0.2);
});
