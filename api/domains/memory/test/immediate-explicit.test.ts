import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { configureLogging } from "../../../infrastructure/logger";
import type {
	CorrectExplicitInput,
	RememberExplicitInput,
} from "../contracts/immediate";
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
const write = <T>(h: MemoryHarness, run: (db: Database) => T) =>
	h.store.write((db) => run(db));

const rememberInput = (
	messageId: string,
	over: Partial<RememberExplicitInput> = {},
): RememberExplicitInput => ({
	conversationId: "c1",
	sourceRunId: "run-a",
	messageId,
	quote: "鍵は靴箱の上",
	kind: "personal_fact",
	semanticKey: "home.key.location",
	subject: "self",
	text: "鍵は靴箱の上に置いている",
	polarity: "affirmed",
	...over,
});
const correctInput = (
	messageId: string,
	over: Partial<CorrectExplicitInput> & Pick<CorrectExplicitInput, "target">,
): CorrectExplicitInput => ({
	conversationId: "c1",
	sourceRunId: "run-b",
	messageId,
	quote: "鍵は玄関の棚",
	text: "鍵は玄関の棚に置いている",
	polarity: "affirmed",
	...over,
});
const items = (h: MemoryHarness) => h.memory.list(true);
const byId = (h: MemoryHarness, id: string) => {
	const found = items(h).find((item) => item.id === id);
	if (!found) throw new Error("item_missing");
	return found;
};
const activeTexts = (h: MemoryHarness) =>
	items(h)
		.filter((item) => item.status === "active")
		.map((item) => item.text);

async function rememberKey(h: MemoryHarness, runId = "run-a") {
	const messageId = await h.say("user", "覚えといて、鍵は靴箱の上。");
	const outcome = await write(h, (db) =>
		h.memory.rememberExplicitInTransaction(
			db,
			rememberInput(messageId, { sourceRunId: runId }),
		),
	);
	if (outcome.status !== "applied") throw new Error(JSON.stringify(outcome));
	return { messageId, outcome };
}

test("an explicit remember saves a user-confirmed item standing on the quote", async () => {
	const h = await setup();
	const { messageId, outcome } = await rememberKey(h);
	expect(outcome.replacedItemId).toBeNull();
	expect(outcome.requestId).not.toBeNull();
	const [saved] = items(h);
	expect(saved).toMatchObject({
		id: outcome.itemId,
		origin: "user_confirmed",
		status: "active",
		text: "鍵は靴箱の上に置いている",
		capturedBy: "request",
		evidence: [{ messageId, quote: "鍵は靴箱の上" }],
	});
});

test("a remember that is not a request (the user said it of their own accord) is captured as the agent's", async () => {
	const h = await setup();
	const messageId = await h.say("user", "鍵は靴箱の上に置いてるんだ");
	const outcome = await write(h, (db) =>
		h.memory.rememberExplicitInTransaction(
			db,
			rememberInput(messageId, { requested: false }),
		),
	);
	expect(outcome.status).toBe("applied");
	expect(items(h)[0]).toMatchObject({
		origin: "user_confirmed",
		capturedBy: "agent",
	});
});

test("a quote that is not in the message is refused with nothing saved; spaces, punctuation and width forms are forgiven", async () => {
	const h = await setup();
	const messageId = await h.say("user", "覚えといて、鍵は靴箱の上。");
	for (const quote of ["鍵は玄関の棚", "", "   "]) {
		expect(
			await write(h, (db) =>
				h.memory.rememberExplicitInTransaction(
					db,
					rememberInput(messageId, { quote }),
				),
			),
		).toEqual({ status: "rejected", reason: "quote_mismatch" });
	}
	// One character cannot evidence anything.
	expect(
		await write(h, (db) =>
			h.memory.rememberExplicitInTransaction(
				db,
				rememberInput(messageId, { quote: "鍵" }),
			),
		),
	).toEqual({ status: "rejected", reason: "quote_mismatch" });
	expect(items(h)).toEqual([]);
	const loose = await write(h, (db) =>
		h.memory.rememberExplicitInTransaction(
			db,
			rememberInput(messageId, { quote: "鍵は 靴箱の上、" }),
		),
	);
	expect(loose.status).toBe("applied");
});

test("the evidence must be a user message of the conversation that is not blocked", async () => {
	const h = await setup();
	const assistant = await h.say("assistant", "鍵は靴箱の上ですね");
	const elsewhere = await h.say("user", "鍵は靴箱の上", "c2");
	const own = await h.say("user", "鍵は靴箱の上");
	const refuse = (messageId: string) =>
		write(h, (db) =>
			h.memory.rememberExplicitInTransaction(db, rememberInput(messageId)),
		);
	expect(await refuse(assistant)).toEqual({
		status: "rejected",
		reason: "invalid_source",
	});
	expect(await refuse(elsewhere)).toEqual({
		status: "rejected",
		reason: "invalid_source",
	});
	expect(await refuse("no-such-message")).toEqual({
		status: "rejected",
		reason: "invalid_source",
	});
	await h.store.write((db) =>
		db
			.query(
				"INSERT INTO memory_message_block (message_id, conversation_id, reason, forget_id, created_at) VALUES (?, 'c1', 'scheduled_prompt', NULL, ?)",
			)
			.run(own, h.time.now),
	);
	expect(await refuse(own)).toEqual({
		status: "rejected",
		reason: "blocked_source",
	});
	expect(items(h)).toEqual([]);
});

test("bad fields are refused: key, kind, subject, text, validity", async () => {
	const h = await setup();
	const messageId = await h.say("user", "覚えといて、鍵は靴箱の上。");
	const reason = async (over: Partial<RememberExplicitInput>) => {
		const outcome = await write(h, (db) =>
			h.memory.rememberExplicitInTransaction(
				db,
				rememberInput(messageId, over),
			),
		);
		return outcome.status === "rejected" ? outcome.reason : outcome.status;
	};
	expect(await reason({ semanticKey: "Bad Key!" })).toBe("invalid_key");
	expect(await reason({ kind: "other_person_note" as never })).toBe(
		"invalid_input",
	);
	expect(await reason({ subject: "other:x" as never })).toBe("invalid_input");
	expect(await reason({ text: "  " })).toBe("invalid_input");
	expect(await reason({ validFrom: "next week" })).toBe("invalid_validity");
	expect(await reason({ sourceRunId: "" })).toBe("invalid_input");
	expect(items(h)).toEqual([]);
});

test("a different value of the same fact replaces the version; the same value changes nothing; an inference is confirmed in place", async () => {
	const h = await setup();
	const first = await rememberKey(h);
	const second = await h.say("user", "鍵は玄関の棚に変えた");
	const replaced = await write(h, (db) =>
		h.memory.rememberExplicitInTransaction(
			db,
			rememberInput(second, {
				quote: "鍵は玄関の棚",
				text: "鍵は玄関の棚に置いている",
			}),
		),
	);
	if (replaced.status !== "applied") throw new Error("not applied");
	expect(replaced.replacedItemId).toBe(first.outcome.itemId);
	expect(byId(h, first.outcome.itemId).status).toBe("superseded");
	expect(byId(h, replaced.itemId).status).toBe("active");
	// The same value again: nothing new.
	const again = await write(h, (db) =>
		h.memory.rememberExplicitInTransaction(
			db,
			rememberInput(second, {
				quote: "鍵は玄関の棚",
				text: "鍵は玄関の棚に置いている",
			}),
		),
	);
	expect(again).toMatchObject({ status: "unchanged", itemId: replaced.itemId });
	// An inference of the same value becomes the user's, in place: no version to withdraw.
	const inferred = await h.say("user", "毎朝コーヒーを飲む");
	const [saved] = await h.curate([
		{
			op: "remember",
			kind: "habit",
			key: "habit.coffee",
			text: "毎朝コーヒーを飲む",
			messageId: inferred,
			quote: "毎朝コーヒーを飲む",
			explicit: false,
		},
	]);
	if (saved?.status !== "applied") throw new Error("not applied");
	expect(items(h).find((item) => item.id === saved.id)?.origin).toBe(
		"agent_inferred",
	);
	const confirmed = await write(h, (db) =>
		h.memory.rememberExplicitInTransaction(
			db,
			rememberInput(inferred, {
				kind: "habit",
				semanticKey: "habit.coffee",
				text: "毎朝コーヒーを飲む",
				quote: "毎朝コーヒーを飲む",
			}),
		),
	);
	expect(confirmed).toMatchObject({
		status: "applied",
		requestId: null,
		itemId: saved.id,
	});
	expect(items(h).find((item) => item.id === saved.id)?.origin).toBe(
		"user_confirmed",
	);
});

test("a correction replaces the version the short reference names; a version that changed since is refused", async () => {
	const h = await setup();
	const first = await rememberKey(h);
	const [shown] = await write(h, (db) =>
		h.memory.shortRefs.assignInTransaction(db, {
			conversationId: "c1",
			windowKey: "w1",
			items: [
				{ itemId: first.outcome.itemId, revision: first.outcome.revision },
			],
		}),
	);
	expect(shown?.ref).toBe("m1");
	const messageId = await h.say("user", "ごめん、鍵は玄関の棚だった");
	// An unknown reference is refused, and so is a reference of another conversation.
	expect(
		await write(h, (db) =>
			h.memory.correctExplicitInTransaction(
				db,
				correctInput(messageId, { target: { ref: "m9" } }),
			),
		),
	).toEqual({ status: "rejected", reason: "unknown_ref" });
	const corrected = await write(h, (db) =>
		h.memory.correctExplicitInTransaction(
			db,
			correctInput(messageId, { target: { ref: "m1" } }),
		),
	);
	if (corrected.status !== "applied") throw new Error("not applied");
	expect(corrected.replacedItemId).toBe(first.outcome.itemId);
	expect(byId(h, first.outcome.itemId)).toMatchObject({
		status: "superseded",
		text: "鍵は靴箱の上に置いている",
	});
	expect(byId(h, corrected.itemId)).toMatchObject({
		status: "active",
		text: "鍵は玄関の棚に置いている",
	});
	// The same reference now names a replaced version.
	const third = await h.say("user", "やっぱり鍵は机の引き出し");
	expect(
		await write(h, (db) =>
			h.memory.correctExplicitInTransaction(
				db,
				correctInput(third, {
					target: { ref: "m1" },
					quote: "鍵は机の引き出し",
					text: "鍵は机の引き出し",
				}),
			),
		),
	).toEqual({ status: "rejected", reason: "target_changed" });
	// By id and revision: a stale revision is refused, the current one passes.
	expect(
		await write(h, (db) =>
			h.memory.correctExplicitInTransaction(
				db,
				correctInput(third, {
					target: {
						itemId: corrected.itemId,
						revision: corrected.revision + 1,
					},
					quote: "鍵は机の引き出し",
					text: "鍵は机の引き出し",
				}),
			),
		),
	).toEqual({ status: "rejected", reason: "target_changed" });
	expect(
		await write(h, (db) =>
			h.memory.correctExplicitInTransaction(
				db,
				correctInput(third, {
					target: { itemId: "state:" + "0".repeat(64) },
					quote: "鍵は机の引き出し",
					text: "鍵は机の引き出し",
				}),
			),
		),
	).toEqual({ status: "rejected", reason: "target_missing" });
	const ok = await write(h, (db) =>
		h.memory.correctExplicitInTransaction(
			db,
			correctInput(third, {
				target: { itemId: corrected.itemId, revision: corrected.revision },
				quote: "鍵は机の引き出し",
				text: "鍵は机の引き出し",
			}),
		),
	);
	expect(ok.status).toBe("applied");
	expect(activeTexts(h)).toEqual(["鍵は机の引き出し"]);
});

test("a correction to the same words changes nothing, and its quote is checked like a remember's", async () => {
	const h = await setup();
	const first = await rememberKey(h);
	const messageId = await h.say("user", "鍵は靴箱の上で合ってる");
	expect(
		await write(h, (db) =>
			h.memory.correctExplicitInTransaction(
				db,
				correctInput(messageId, {
					target: { itemId: first.outcome.itemId },
					quote: "鍵は靴箱の上",
					text: "鍵は靴箱の上に置いている",
				}),
			),
		),
	).toMatchObject({ status: "unchanged", itemId: first.outcome.itemId });
	expect(
		await write(h, (db) =>
			h.memory.correctExplicitInTransaction(
				db,
				correctInput(messageId, {
					target: { itemId: first.outcome.itemId },
					quote: "鍵は玄関の棚",
				}),
			),
		),
	).toEqual({ status: "rejected", reason: "quote_mismatch" });
	expect(activeTexts(h)).toEqual(["鍵は靴箱の上に置いている"]);
});

test("a correction expires other runs' generations but not its own", async () => {
	const h = await setup();
	const first = await rememberKey(h);
	const prepared = await h.window();
	await write(h, (db) => {
		// A window as a generation fixed it.
		expect(h.memory.windowForRunInTransaction(db, "c1")).not.toBeNull();
	});
	const seq = prepared.inputs.immediateSeq;
	const messageId = await h.say("user", "鍵は玄関の棚だった");
	const corrected = await write(h, (db) =>
		h.memory.correctExplicitInTransaction(
			db,
			correctInput(messageId, {
				target: { itemId: first.outcome.itemId },
				sourceRunId: "run-self",
			}),
		),
	);
	expect(corrected.status).toBe("applied");
	await write(h, (db) => {
		expect(
			h.memory.windows.changedSinceInTransaction(db, seq, "run-self"),
		).toBe(false);
		expect(
			h.memory.windows.changedSinceInTransaction(db, seq, "run-other"),
		).toBe(true);
	});
});

test("withdrawing a remember retracts the saved version; the latest request is the default; nothing is withdrawn twice", async () => {
	const h = await setup();
	const { outcome } = await rememberKey(h);
	const withdrawn = await write(h, (db) =>
		h.memory.withdrawExplicitInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-w",
		}),
	);
	expect(withdrawn).toEqual({
		status: "applied",
		requestId: outcome.requestId as string,
		retractedItemId: outcome.itemId,
		restoredItemId: null,
	});
	expect(items(h).map((item) => item.status)).toEqual(["retracted"]);
	expect(activeTexts(h)).toEqual([]);
	expect(
		await write(h, (db) =>
			h.memory.withdrawExplicitInTransaction(db, {
				conversationId: "c1",
				sourceRunId: "run-w",
			}),
		),
	).toEqual({ status: "rejected", reason: "nothing_to_withdraw" });
});

test("withdrawing a correction brings the earlier version back as a new version", async () => {
	const h = await setup();
	const first = await rememberKey(h);
	const messageId = await h.say("user", "鍵は玄関の棚だった");
	const corrected = await write(h, (db) =>
		h.memory.correctExplicitInTransaction(
			db,
			correctInput(messageId, { target: { itemId: first.outcome.itemId } }),
		),
	);
	if (corrected.status !== "applied") throw new Error("not applied");
	const withdrawn = await write(h, (db) =>
		h.memory.withdrawExplicitInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-w",
			target: { requestId: corrected.requestId },
		}),
	);
	if (withdrawn.status !== "applied") throw new Error("not applied");
	expect(withdrawn.retractedItemId).toBe(corrected.itemId);
	expect(withdrawn.restoredItemId).not.toBeNull();
	expect(activeTexts(h)).toEqual(["鍵は靴箱の上に置いている"]);
	const restored = items(h).find(
		(item) => item.id === withdrawn.restoredItemId,
	);
	expect(restored).toMatchObject({
		origin: "user_confirmed",
		evidence: [{ messageId: first.messageId, quote: "鍵は靴箱の上" }],
	});
	// The first remember is still a request that can be taken back (its version is not the current one any more).
	expect(
		await write(h, (db) =>
			h.memory.withdrawExplicitInTransaction(db, {
				conversationId: "c1",
				sourceRunId: "run-w2",
				target: { requestId: first.outcome.requestId as string },
			}),
		),
	).toEqual({ status: "rejected", reason: "target_changed" });
});

test("a withdrawal is refused for another conversation, a version that changed, and a forget", async () => {
	const h = await setup();
	const first = await rememberKey(h);
	expect(
		await write(h, (db) =>
			h.memory.withdrawExplicitInTransaction(db, {
				conversationId: "c2",
				sourceRunId: "run-w",
				target: { requestId: first.outcome.requestId as string },
			}),
		),
	).toEqual({ status: "rejected", reason: "nothing_to_withdraw" });
	// The caller found the request to be a forget.
	expect(
		await write(h, (db) =>
			h.memory.withdrawExplicitInTransaction(db, {
				conversationId: "c1",
				sourceRunId: "run-w",
				ofForget: true,
			}),
		),
	).toEqual({ status: "rejected", reason: "forget_not_withdrawable" });
	// Corrected since: the request no longer stands.
	const messageId = await h.say("user", "鍵は玄関の棚だった");
	await write(h, (db) =>
		h.memory.correctExplicitInTransaction(
			db,
			correctInput(messageId, { target: { itemId: first.outcome.itemId } }),
		),
	);
	expect(
		await write(h, (db) =>
			h.memory.withdrawExplicitInTransaction(db, {
				conversationId: "c1",
				sourceRunId: "run-w",
				target: { requestId: first.outcome.requestId as string },
			}),
		),
	).toEqual({ status: "rejected", reason: "target_changed" });
});

test("a correction whose earlier evidence is gone cannot be withdrawn, and nothing is half done", async () => {
	const h = await setup();
	const first = await rememberKey(h);
	const messageId = await h.say("user", "鍵は玄関の棚だった");
	const corrected = await write(h, (db) =>
		h.memory.correctExplicitInTransaction(
			db,
			correctInput(messageId, { target: { itemId: first.outcome.itemId } }),
		),
	);
	if (corrected.status !== "applied") throw new Error("not applied");
	await h.store.write((db) =>
		db
			.query(
				"INSERT INTO memory_message_block (message_id, conversation_id, reason, forget_id, created_at) VALUES (?, 'c1', 'scheduled_prompt', NULL, ?)",
			)
			.run(first.messageId, h.time.now),
	);
	expect(
		await write(h, (db) =>
			h.memory.withdrawExplicitInTransaction(db, {
				conversationId: "c1",
				sourceRunId: "run-w",
			}),
		),
	).toEqual({ status: "rejected", reason: "cannot_restore" });
	expect(activeTexts(h)).toEqual(["鍵は玄関の棚に置いている"]);
});

test("a refused operation leaves the caller's transaction as it was", async () => {
	const h = await setup();
	const messageId = await h.say("user", "覚えといて、鍵は靴箱の上。");
	await write(h, (db) => {
		const refused = h.memory.rememberExplicitInTransaction(
			db,
			rememberInput(messageId, { quote: "鍵は玄関の棚" }),
		);
		expect(refused.status).toBe("rejected");
		// The transaction goes on: the next operation works.
		expect(
			h.memory.rememberExplicitInTransaction(db, rememberInput(messageId))
				.status,
		).toBe("applied");
	});
	expect(activeTexts(h)).toEqual(["鍵は靴箱の上に置いている"]);
});

test("what the user stated unasked never replaces a record that stands; with none it is saved, but no withdrawal without a target takes it back", async () => {
	const h = await setup();
	const first = await rememberKey(h);
	const said = await h.say("user", "鍵は玄関の棚に置いてる");
	const unasked = (over: Partial<RememberExplicitInput> = {}) =>
		write(h, (db) =>
			h.memory.rememberExplicitInTransaction(
				db,
				rememberInput(said, {
					requested: false,
					quote: "鍵は玄関の棚",
					text: "鍵は玄関の棚に置いている",
					...over,
				}),
			),
		);
	// A different value: refused, the record stands, and the response names it.
	expect(await unasked()).toEqual({
		status: "rejected",
		reason: "conflict",
		existingId: first.outcome.itemId,
	});
	expect(activeTexts(h)).toEqual(["鍵は靴箱の上に置いている"]);
	expect(byId(h, first.outcome.itemId).status).toBe("active");
	// The same value is not a conflict.
	expect(
		await unasked({ quote: "鍵は玄関", text: "鍵は靴箱の上に置いている" }),
	).toMatchObject({ status: "unchanged", itemId: first.outcome.itemId });
	// With no record of the fact, a statement is saved ...
	const other = await h.say("user", "毎朝走っています");
	const run = await write(h, (db) =>
		h.memory.rememberExplicitInTransaction(
			db,
			rememberInput(other, {
				requested: false,
				kind: "habit",
				semanticKey: "habit.run",
				quote: "毎朝走って",
				text: "毎朝走っている",
			}),
		),
	);
	if (run.status !== "applied") throw new Error("not applied");
	// ... and "withdraw that" with no target undoes the user's request, not the noted statement.
	const withdrawn = await write(h, (db) =>
		h.memory.withdrawExplicitInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-w",
		}),
	);
	expect(withdrawn).toMatchObject({
		status: "applied",
		requestId: first.outcome.requestId as string,
	});
	expect(byId(h, run.itemId).status).toBe("active");
	// With no request left, there is nothing to withdraw by default; the statement can be named.
	expect(
		await write(h, (db) =>
			h.memory.withdrawExplicitInTransaction(db, {
				conversationId: "c1",
				sourceRunId: "run-w",
			}),
		),
	).toEqual({ status: "rejected", reason: "nothing_to_withdraw" });
	expect(
		await write(h, (db) =>
			h.memory.withdrawExplicitInTransaction(db, {
				conversationId: "c1",
				sourceRunId: "run-w",
				target: { itemId: run.itemId },
			}),
		),
	).toMatchObject({ status: "applied", retractedItemId: run.itemId });
});

test("there is no count limit: the agent's own saving and the user's request are both kept past a hundred records", async () => {
	const h = await setup();
	const messageId = await h.say("user", "覚えといて、鍵は靴箱の上。");
	for (let i = 0; i < 101; i++) {
		const outcome = await write(h, (db) =>
			h.memory.rememberExplicitInTransaction(
				db,
				rememberInput(messageId, {
					semanticKey: `filler.${i}`,
					text: `鍵は靴箱の上に置いている（${"あいうえおかきくけこ".charAt(i % 10)}${i}番）`,
					requested: i % 2 === 0,
				}),
			),
		);
		expect(outcome.status).toBe("applied");
	}
	expect(items(h).filter((item) => item.status === "active")).toHaveLength(101);
});
