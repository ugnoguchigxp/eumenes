import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { createConversationService, migrations } from "..";

/**
 * What the conversation's input is built from (the conversation input specification, sections 6.3, 6.1.1, 7.4 and
 * 11): the utterances, the cut and the state versions, and how a forget or a correction reaches them.
 */
const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-conversation-input-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), migrations);
	stores.push(store);
	const conversation = createConversationService(store, {
		clock: () => "2026-10-27T00:00:00.000Z",
	});
	return { store, conversation, input: conversation.input };
}

const say = (
	speaker: "user" | "agent",
	text: string,
	messageId: string | null,
) => ({
	conversationId: "c1",
	speaker,
	text,
	messageId,
	at: "2026-10-27T00:00:00.000Z",
});

test("utterances are numbered in order, a message's utterance is written once, and only standing ones are read", async () => {
	const { store, input } = setup();
	await store.write((db) => {
		expect(
			input.appendUtteranceInTransaction(db, say("user", "A", "m1"))?.seq,
		).toBe(1);
		expect(
			input.appendUtteranceInTransaction(db, say("agent", "a", "m2"))?.seq,
		).toBe(2);
		// A second delivery report of the same reply adds nothing.
		expect(
			input.appendUtteranceInTransaction(db, say("agent", "a", "m2")),
		).toBeNull();
		// An announcement has no message of its own.
		expect(
			input.appendUtteranceInTransaction(db, say("agent", "予告", null))?.seq,
		).toBe(3);
	});
	store.read((db) => {
		expect(
			input.utterancesAfterInTransaction(db, "c1", 1).map((u) => u.text),
		).toEqual(["a", "予告"]);
		expect(
			input.latestUtterancesInTransaction(db, "c1", 2).map((u) => u.seq),
		).toEqual([2, 3]);
	});
});

test("a forget keeps only that an utterance existed, cuts the next input when it was shown, and moves the revision", async () => {
	const { store, input } = setup();
	const cut = await store.write((db) => {
		input.appendUtteranceInTransaction(db, say("user", "住所は鎌倉", "m1"));
		input.appendUtteranceInTransaction(db, say("agent", "了解", "m2"));
		return input.writeCutInTransaction(db, "c1", {
			seq: 0,
			systemDigest: "s",
			memoryDigest: "m",
			at: "t",
		});
	});
	expect(cut).toMatchObject({ seq: 0, revision: 1, due: null });
	const changed = await store.write((db) =>
		input.retractUtterancesInTransaction(db, ["m1"], "later"),
	);
	expect(changed).toEqual(["c1"]);
	store.read((db) => {
		expect(
			input.utterancesAfterInTransaction(db, "c1", 0).map((u) => u.text),
		).toEqual(["了解"]);
		const row = db
			.query(
				"SELECT text, retracted_at FROM conversation_utterances WHERE message_id = 'm1'",
			)
			.get() as { text: string; retracted_at: string };
		expect(row).toEqual({ text: "", retracted_at: "later" });
		expect(input.cutInTransaction(db, "c1")).toMatchObject({
			revision: 2,
			due: "forget",
		});
	});
	// A new cut clears the due mark and keeps the revision (a generation drawn before it stands).
	await store.write((db) =>
		input.writeCutInTransaction(db, "c1", {
			seq: 1,
			systemDigest: "s",
			memoryDigest: "m",
			at: "t2",
		}),
	);
	expect(store.read((db) => input.cutInTransaction(db, "c1"))).toMatchObject({
		seq: 1,
		revision: 2,
		due: null,
	});
});

test("retracting a message reaches its utterance and drops the state made from the conversation", async () => {
	const { store, conversation, input } = setup();
	await store.write((db) => {
		conversation.appendInTransaction(db, {
			id: "m1",
			conversationId: "c1",
			role: "user",
			text: "秘密",
			createdAt: "2026-10-27T00:00:00.000Z",
			runId: null,
		});
		input.appendUtteranceInTransaction(db, say("user", "秘密", "m1"));
		input.appendStateInTransaction(db, "c1", {
			expectedVersion: 0,
			body: { topic: "秘密の話", decisions: [], open: [], records: [] },
			basedOnSeq: 1,
			at: "t",
		});
		conversation.retractInTransaction(db, { messageId: "m1" });
	});
	store.read((db) => {
		expect(input.utterancesAfterInTransaction(db, "c1", 0)).toEqual([]);
		expect(input.latestStateInTransaction(db, "c1")).toBeNull();
	});
});

test("a correction rewrites the user's utterance in place, never the announcement sharing its message, and moves the revision", async () => {
	const { store, input } = setup();
	await store.write((db) => {
		input.appendUtteranceInTransaction(db, say("user", "鎌倉", "m1"));
		input.appendUtteranceInTransaction(db, say("agent", "調べますね。", "m1"));
		input.writeCutInTransaction(db, "c1", {
			seq: 0,
			systemDigest: "s",
			memoryDigest: "m",
			at: "t",
		});
		expect(input.correctUtterancesInTransaction(db, "m1", "七里ヶ浜")).toEqual([
			"c1",
		]);
	});
	store.read((db) => {
		expect(
			input.utterancesAfterInTransaction(db, "c1", 0).map((u) => u.text),
		).toEqual(["七里ヶ浜", "調べますね。"]);
		expect(input.cutInTransaction(db, "c1")!.revision).toBe(2);
	});
});

test("an agent's utterance keeps its turn's tool calls, written once, and a forget takes them out with its text", async () => {
	const { store, input } = setup();
	const find = { name: "find_toolchain", arguments: "{}", result: "{}" };
	const handed = { name: "delegate", arguments: "{}", result: '{"todo":"t1"}' };
	await store.write((db) => {
		input.appendUtteranceInTransaction(db, {
			...say("user", "猫の絵を描いて", "m1"),
			toolCalls: [find],
		});
		// The announcement reaches the user before its work is handed over: its calls join it when the turn ends.
		input.appendUtteranceInTransaction(db, say("agent", "描きますね。", "m1"));
		expect(
			input.attachToolCallsInTransaction(db, {
				conversationId: "c1",
				messageId: "m1",
				toolCalls: [find, handed],
			}),
		).toBe(true);
		expect(
			input.attachToolCallsInTransaction(db, {
				conversationId: "c1",
				messageId: "m1",
				toolCalls: [handed],
			}),
		).toBe(false);
		input.appendUtteranceInTransaction(db, {
			...say("agent", "どうぞ。", "m2"),
			toolCalls: [find],
		});
	});
	store.read((db) => {
		expect(
			input.utterancesAfterInTransaction(db, "c1", 0).map((u) => u.toolCalls),
		).toEqual([[], [find, handed], [find]]);
	});
	await store.write((db) =>
		input.retractUtterancesInTransaction(db, ["m1"], "later"),
	);
	store.read((db) => {
		expect(
			db
				.query(
					"SELECT tool_exchange_json FROM conversation_utterances WHERE message_id = 'm1'",
				)
				.all(),
		).toEqual([{ tool_exchange_json: null }, { tool_exchange_json: null }]);
	});
});

test("a state version is appended only on the version it was made from", async () => {
	const { store, input } = setup();
	const body = {
		topic: "曲",
		decisions: [{ text: "速い曲" }],
		open: [],
		records: [],
	};
	await store.write((db) => {
		expect(
			input.appendStateInTransaction(db, "c1", {
				expectedVersion: 0,
				body,
				basedOnSeq: 3,
				at: "t",
			}),
		).toMatchObject({ version: 1, basedOnSeq: 3, body });
		// Another writer came first: the stale one is refused.
		expect(
			input.appendStateInTransaction(db, "c1", {
				expectedVersion: 0,
				body,
				basedOnSeq: 4,
				at: "t",
			}),
		).toBeNull();
		expect(
			input.appendStateInTransaction(db, "c1", {
				expectedVersion: 1,
				body,
				basedOnSeq: 5,
				at: "t",
			})?.version,
		).toBe(2);
	});
	expect(
		store.read((db) => input.latestStateInTransaction(db, "c1"))?.basedOnSeq,
	).toBe(5);
});
