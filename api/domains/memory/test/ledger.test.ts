import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
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
const uncurated = (h: MemoryHarness, conversationId = "c1") =>
	h.store.read((db) =>
		h.continuity.events
			.uncuratedInTransaction(db, conversationId)
			.map((event) => event.seq),
	);
const block = (
	h: MemoryHarness,
	messageIds: string[],
	reason: "scheduled_prompt" | "specialist_dialogue",
) =>
	h.store.write((db) =>
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "c1",
			messageIds,
			reason,
		}),
	);

test("memory keeps no exchange or summary ledger: the conversation's flow is the continuity events", async () => {
	const h = await setup();
	await h.exchange("こんにちは", "どうも");
	const tables = h.store.read((db) =>
		(
			db
				.query(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_%' ORDER BY name",
				)
				.all() as Array<{ name: string }>
		).map((row) => row.name),
	);
	expect(tables).not.toContain("memory_exchange");
	expect(tables).not.toContain("memory_conversation_summary");
	expect(tables).not.toContain("memory_summary_source");
	expect(tables).toContain("memory_message_block");
	expect(
		h.store.read((db) => h.continuity.events.logInTransaction(db, "c1")),
	).toHaveLength(2);
});

test("a blocked message is reported blocked, with the block journal's ids, per conversation and for the application", async () => {
	const h = await setup();
	const prompt = await h.say("user", "定期の問い合わせ", "c1", "run-sched");
	const answer = await h.say("assistant", "定期の回答", "c1", "run-sched");
	await block(h, [prompt], "scheduled_prompt");
	expect(h.memory.blockedMessageIds([prompt, answer])).toEqual(
		new Set([prompt]),
	);
	expect(
		h.store.read((db) => h.memory.isBlockedInTransaction(db, prompt)),
	).toBe(true);
	expect(
		h.store.read((db) => h.memory.isBlockedInTransaction(db, answer)),
	).toBe(false);
	expect(
		h.store.read((db) =>
			h.memory.blockedMessageIdsOfConversationInTransaction(db, "c1"),
		),
	).toEqual([prompt]);
	expect(
		h.store.read((db) =>
			h.memory.blockedMessageIdsOfConversationInTransaction(db, "c2"),
		),
	).toEqual([]);
});

test("blocking a specialist session's messages is not a forget: the events keep their text", async () => {
	const h = await setup();
	const said = await h.exchange("専門担当への発言", "専門担当の返事");
	const before = h.store.read((db) =>
		h.continuity.events.logInTransaction(db, "c1"),
	);
	await block(h, [said.userId, said.answerId!], "specialist_dialogue");
	const after = h.store.read((db) =>
		h.continuity.events.logInTransaction(db, "c1"),
	);
	expect(after.map((e) => [e.text, e.forgotten])).toEqual(
		before.map((e) => [e.text, false]),
	);
});

test("what is said while memory is off is skipped when memory is switched on; what is said after is offered", async () => {
	const h = await setup();
	const before = await h.exchange("オフにする前", "回答");
	await h.memory.setEnabled(false);
	const during = await h.exchange("オフの間", "回答");
	expect(uncurated(h)).toEqual([...before.seqs, ...during.seqs]);
	await h.memory.setEnabled(true);
	expect(uncurated(h)).toEqual([]);
	const after = await h.exchange("オンの後", "回答");
	expect(uncurated(h)).toEqual(after.seqs);
	// Switching to the same value changes nothing.
	await h.memory.setEnabled(true);
	expect(uncurated(h)).toEqual(after.seqs);
});

test("the forget fence moves with a forget and with a reconciliation that applied something, never otherwise", async () => {
	const h = await setup();
	const seq = () => h.store.read((db) => h.memory.forgetSeqInTransaction(db));
	// A start-up with nothing to apply leaves it alone.
	const start = seq();
	expect(start).toBe(0);
	const item = await h.seed("コーヒーが好き", "drink.coffee");
	await h.exchange("質問", "回答");
	expect(seq()).toBe(start);
	await h.forget([item.id]);
	expect(seq()).toBe(start + 1);
	// The forget's purge is recorded: a plain restart re-applies nothing and moves nothing.
	await h.memory.recover();
	expect(seq()).toBe(start + 1);
	// A database that lost the record (an older copy restored) has the line applied again, and the fence moves.
	await h.store.write((db) =>
		db.query("DELETE FROM memory_block_applied").run(),
	);
	await h.memory.recover();
	expect(seq()).toBe(start + 2);
	await h.memory.recover();
	expect(seq()).toBe(start + 2);
});
