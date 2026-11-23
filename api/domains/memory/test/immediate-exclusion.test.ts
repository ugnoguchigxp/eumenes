import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { listCandidates, listExclusions } from "eumenes-memory/sqlite";
import { configureLogging } from "../../../infrastructure/logger";
import { openStore } from "../../../infrastructure/sqlite";
import { createConversationService } from "../../conversation";
import { createContinuityFixture } from "../../../application/world/state-services.fixture";
import { createMemoryService } from "..";
import { PRINCIPAL, PROFILE_SCOPE } from "../contracts";
import { readJournal } from "../service/journal";
import {
	memoryTestMigrations,
	setupMemory,
	type MemoryHarness,
} from "./memory.fixture";
import { plantCandidate, plantTendency } from "./existing-data.fixture";
import { readEverything } from "./recall.fixture";

const open: MemoryHarness[] = [];
const extra: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const cleanup of extra.splice(0).reverse()) await cleanup();
	for (const h of open.splice(0)) await h.close();
});
const write = <T>(h: MemoryHarness, run: (db: Database) => T) =>
	h.store.write((db) => run(db));
const journalPath = (h: MemoryHarness) => join(h.dir, "journal.jsonl");

/** The address fact (two versions), the food fact and a candidate of each, with the shown window of c1. */
async function scenario() {
	const h = await setupMemory();
	open.push(h);
	const old = await h.say("user", "住所は大阪市です");
	const moved = await h.say("user", "住所は東京都千代田区に引っ越しました");
	const food = await h.say("user", "好きな食べ物はカレーです");
	const first = await h.remember({
		conversationId: "c1",
		messageId: old,
		quote: "住所は大阪市",
		kind: "personal_fact",
		semanticKey: "address",
		text: "住所は大阪市",
	});
	const second = await h.remember({
		conversationId: "c1",
		messageId: moved,
		quote: "東京都千代田区に引っ越しました",
		kind: "personal_fact",
		semanticKey: "address",
		text: "住所は東京都千代田区",
	});
	const curry = await h.remember({
		conversationId: "c1",
		messageId: food,
		quote: "カレー",
		kind: "preference",
		semanticKey: "food",
		text: "カレーが好き",
	});
	const candidate = await plantCandidate(h, {
		messageIds: [moved],
		kind: "personal_fact",
		semanticKey: "address",
		text: "東京に住んでいそう",
	});
	const unrelated = await plantCandidate(h, {
		messageIds: [food],
		kind: "habit",
		semanticKey: "habit.walk",
		text: "夜に散歩する",
	});
	const window = await h.window();
	return {
		h,
		old,
		moved,
		food,
		first,
		second,
		curry,
		candidate,
		unrelated,
		window,
	};
}

const candidatesOf = (
	h: MemoryHarness,
	status: "open" | "dismissed" | "promoted" = "open",
) =>
	h.store.read((db) => {
		const listed = listCandidates(db, {
			contractVersion: 1,
			access: {
				principal: PRINCIPAL,
				scopeKeys: [PROFILE_SCOPE],
				purpose: "memory.read",
				policyRevision: h.memory.policyRevisionInTransaction(db),
			},
			scopeKey: PROFILE_SCOPE,
			status,
		});
		if (listed.status !== "ok") throw new Error("blocked");
		return listed.candidates.map((candidate) => candidate.candidateId);
	});
const exclusionsOf = (h: MemoryHarness) =>
	h.store.read((db) => {
		const listed = listExclusions(db, {
			contractVersion: 2,
			access: {
				principal: PRINCIPAL,
				scopeKeys: [PROFILE_SCOPE],
				purpose: "memory.read",
				policyRevision: h.memory.policyRevisionInTransaction(db),
			},
			scopeKey: PROFILE_SCOPE,
		});
		if (listed.status !== "ok") throw new Error("blocked");
		return listed.targets;
	});

test("an exclusion hides every version of the fact and its candidates at once, and is a line of the forget journal", async () => {
	const s = await scenario();
	const { h } = s;
	expect(s.window.profile.items.map((item) => item.id).sort()).toEqual(
		[s.second.id, s.curry.id].sort(),
	);
	const seqBefore = await write(h, (db) => h.memory.forgetSeqInTransaction(db));
	const outcome = await write(h, (db) =>
		h.memory.excludeForForgetInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-x",
			targets: [{ itemId: s.second.id, revision: s.second.revision }],
		}),
	);
	if (outcome.status !== "applied") throw new Error(JSON.stringify(outcome));
	expect(new Set(outcome.itemIds)).toEqual(new Set([s.first.id, s.second.id]));
	expect(outcome.candidateIds).toEqual([s.candidate.candidateId]);
	expect(new Set(outcome.evidenceMessageIds)).toEqual(
		new Set([s.old, s.moved]),
	);
	expect(outcome.journaled).toBe(1);
	// Gone from every default reading; the other fact and the other candidate stay.
	expect(h.memory.list(true).map((item) => item.id)).toEqual([s.curry.id]);
	expect(candidatesOf(h)).toEqual([s.unrelated.candidateId]);
	expect(exclusionsOf(h).length).toBe(3);
	// The journal has one exclusion line (format 3), not a forget: nothing is deleted yet.
	const entries = readJournal(journalPath(h));
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({
		journalFormat: 3,
		exclusionOp: "exclude",
	});
	expect(entries[0]?.targets).toHaveLength(3);
	// The stored windows that held the text are gone, a run in flight is expired, the steward's fence moved.
	expect(
		h.store.read(
			(db) =>
				(
					db.query("SELECT COUNT(*) AS n FROM memory_context_window").get() as {
						n: number;
					}
				).n,
		),
	).toBe(0);
	await write(h, (db) => {
		expect(
			h.memory.windows.changedSinceInTransaction(
				db,
				s.window.inputs.immediateSeq,
				"run-other",
			),
		).toBe(true);
		expect(
			h.memory.windows.changedSinceInTransaction(
				db,
				s.window.inputs.immediateSeq,
				"run-x",
			),
		).toBe(false);
		expect(h.memory.forgetSeqInTransaction(db)).toBe(seqBefore + 1);
	});
	const next = await h.window();
	expect(next.profile.items.map((item) => item.id)).toEqual([s.curry.id]);
	// The same request again changes nothing and writes no line.
	const again = await write(h, (db) =>
		h.memory.excludeForForgetInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-x",
			targets: [{ itemId: s.first.id }],
		}),
	);
	expect(again).toMatchObject({ status: "applied", journaled: 0 });
	expect(readJournal(journalPath(h))).toHaveLength(1);
});

test("the closure delete after an exclusion removes the versions, the messages they stand on and the exclusion", async () => {
	const s = await scenario();
	const { h } = s;
	await write(h, (db) =>
		h.memory.excludeForForgetInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-x",
			targets: [{ itemId: s.second.id }],
		}),
	);
	const forgotten = await h.memory.forget({
		conversationId: "c1",
		itemIds: [s.second.id],
		messageIds: [],
	});
	expect(forgotten.completed).toBe(true);
	expect(new Set(forgotten.forgottenItemIds)).toEqual(
		new Set([s.first.id, s.second.id]),
	);
	expect(new Set(forgotten.blockedMessageIds)).toEqual(
		new Set([s.old, s.moved]),
	);
	expect(h.memory.list(true).map((item) => item.id)).toEqual([s.curry.id]);
	// The library drops the exclusion of what it tombstoned; the candidates went with their sources.
	expect(exclusionsOf(h)).toEqual([]);
	expect(candidatesOf(h)).toEqual([s.unrelated.candidateId]);
	// The journal: the exclusion line, then the forget line.
	expect(
		readJournal(journalPath(h)).map((entry) => entry.exclusionOp ?? "forget"),
	).toEqual(["exclude", "forget"]);
});

test("an older database restored over an exclusion gets the exclusion back from the journal", async () => {
	const s = await scenario();
	const { h } = s;
	await h.store.write((db) => db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
	const backup = join(h.dir, "backup.sqlite3");
	copyFileSync(join(h.dir, "db.sqlite3"), backup);
	await write(h, (db) =>
		h.memory.excludeForForgetInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-x",
			targets: [{ itemId: s.second.id }],
		}),
	);
	expect(h.memory.list(true).map((item) => item.id)).toEqual([s.curry.id]);
	await h.store.close();
	copyFileSync(backup, join(h.dir, "db.sqlite3"));
	const store = openStore(join(h.dir, "db.sqlite3"), memoryTestMigrations);
	extra.push(() => store.close());
	const conversation = createConversationService(store);
	const memory = createMemoryService(
		store,
		conversation,
		createContinuityFixture(store, () => h.time.now),
		{ journalPath: journalPath(h), clock: () => h.time.now },
	);
	expect(await memory.recover()).toMatchObject({ healthy: true, reapplied: 1 });
	// Replayed: nothing forgotten, only hidden again.
	expect(memory.list(true).map((item) => item.id)).toEqual([s.curry.id]);
	// A second start has nothing to replay.
	expect(
		await createMemoryService(
			store,
			conversation,
			createContinuityFixture(store, () => h.time.now),
			{ journalPath: journalPath(h), clock: () => h.time.now },
		).recover(),
	).toMatchObject({ healthy: true, reapplied: 0 });
});

test("a request that cannot be applied is refused whole, with nothing excluded or journaled", async () => {
	const s = await scenario();
	const { h } = s;
	const [shown] = await write(h, (db) =>
		h.memory.shortRefs.assignInTransaction(db, {
			conversationId: "c1",
			windowKey: "w1",
			items: [{ itemId: s.curry.id, revision: s.curry.revision }],
		}),
	);
	const run = (
		targets: Parameters<
			typeof h.memory.excludeForForgetInTransaction
		>[1]["targets"],
	) =>
		write(h, (db) =>
			h.memory.excludeForForgetInTransaction(db, {
				conversationId: "c1",
				sourceRunId: "run-x",
				targets,
			}),
		);
	expect(await run([{ ref: "m9" }])).toEqual({
		status: "rejected",
		reason: "unknown_ref",
	});
	expect(
		await run([{ itemId: s.curry.id, revision: s.curry.revision + 1 }]),
	).toEqual({ status: "rejected", reason: "target_changed" });
	expect(await run([{ itemId: "state:" + "0".repeat(64) }])).toEqual({
		status: "rejected",
		reason: "target_missing",
	});
	expect(await run([{ candidateId: "no-such-candidate" }])).toEqual({
		status: "rejected",
		reason: "target_missing",
	});
	expect(await run([])).toEqual({
		status: "rejected",
		reason: "invalid_input",
	});
	expect(
		await run(Array.from({ length: 6 }, () => ({ itemId: s.curry.id }))),
	).toEqual({ status: "rejected", reason: "limit_reached" });
	// A good target beside a bad one: neither is excluded.
	expect(await run([{ ref: shown?.ref as string }, { ref: "m9" }])).toEqual({
		status: "rejected",
		reason: "unknown_ref",
	});
	expect(h.memory.list(true)).toHaveLength(3);
	expect(readJournal(journalPath(h))).toEqual([]);
	// The short reference of the window names the item at its version.
	const ok = await run([{ ref: shown?.ref as string }]);
	expect(ok).toMatchObject({ status: "applied", itemIds: [s.curry.id] });
});

test("a candidate can be excluded by itself", async () => {
	const s = await scenario();
	const { h } = s;
	const outcome = await write(h, (db) =>
		h.memory.excludeForForgetInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-x",
			targets: [{ candidateId: s.unrelated.candidateId }],
		}),
	);
	expect(outcome).toMatchObject({
		status: "applied",
		itemIds: [],
		candidateIds: [s.unrelated.candidateId],
	});
	expect(candidatesOf(h)).toEqual([s.candidate.candidateId]);
	expect(h.memory.list(true)).toHaveLength(3);
});

test("what is being forgotten cannot be corrected, marked, saved again or withdrawn", async () => {
	const s = await scenario();
	const { h } = s;
	const [shown] = await write(h, (db) =>
		h.memory.shortRefs.assignInTransaction(db, {
			conversationId: "c1",
			windowKey: "w1",
			items: [{ itemId: s.second.id, revision: s.second.revision }],
		}),
	);
	// A request the user made earlier, so a withdrawal has something to look for.
	const request = await write(h, (db) =>
		h.memory.rememberExplicitInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-r",
			messageId: s.food,
			quote: "カレー",
			kind: "preference",
			semanticKey: "food",
			subject: "self",
			text: "カレーが好き",
			polarity: "affirmed",
		}),
	);
	expect(request.status).toBe("unchanged");
	await write(h, (db) =>
		h.memory.excludeForForgetInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-x",
			targets: [{ ref: shown?.ref as string }],
		}),
	);
	const again = await h.say("user", "住所は京都市に変わりました");
	expect(
		await write(h, (db) =>
			h.memory.correctExplicitInTransaction(db, {
				conversationId: "c1",
				sourceRunId: "run-y",
				messageId: again,
				quote: "京都市に変わりました",
				text: "住所は京都市",
				polarity: "affirmed",
				target: { ref: shown?.ref as string },
			}),
		),
	).toEqual({ status: "rejected", reason: "target_excluded" });
	expect(
		await write(h, (db) =>
			h.memory.suppressInTransaction(db, {
				conversationId: "c1",
				sourceRunId: "run-y",
				target: { ref: shown?.ref as string },
			}),
		),
	).toEqual({ status: "rejected", reason: "target_excluded" });
	// Saying it again while the forget is on its way is not stored beside the versions it removes.
	expect(
		await write(h, (db) =>
			h.memory.rememberExplicitInTransaction(db, {
				conversationId: "c1",
				sourceRunId: "run-y",
				messageId: again,
				quote: "京都市に変わりました",
				kind: "personal_fact",
				semanticKey: "address",
				subject: "self",
				text: "住所は京都市",
				polarity: "affirmed",
			}),
		),
	).toEqual({ status: "rejected", reason: "forget_pending" });
	// A forget is never withdrawn, by the caller's word or by what the target turns out to be.
	expect(
		await write(h, (db) =>
			h.memory.withdrawExplicitInTransaction(db, {
				conversationId: "c1",
				sourceRunId: "run-y",
				target: { ref: shown?.ref as string },
			}),
		),
	).toEqual({ status: "rejected", reason: "forget_not_withdrawable" });
	expect(
		await write(h, (db) =>
			h.memory.withdrawExplicitInTransaction(db, {
				conversationId: "c1",
				sourceRunId: "run-y",
				ofForget: true,
			}),
		),
	).toEqual({ status: "rejected", reason: "forget_not_withdrawable" });
	expect(h.memory.list(true).map((item) => item.id)).toEqual([s.curry.id]);
});

test("a forget removes the requests and short references that name its items", async () => {
	const h = await setupMemory();
	open.push(h);
	const messageId = await h.say("user", "覚えといて、鍵は靴箱の上。");
	const remembered = await write(h, (db) =>
		h.memory.rememberExplicitInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-a",
			messageId,
			quote: "鍵は靴箱の上",
			kind: "personal_fact",
			semanticKey: "home.key.location",
			subject: "self",
			text: "鍵は靴箱の上に置いている",
			polarity: "affirmed",
		}),
	);
	if (remembered.status !== "applied") throw new Error("not applied");
	await write(h, (db) =>
		h.memory.shortRefs.assignInTransaction(db, {
			conversationId: "c1",
			windowKey: "w1",
			items: [{ itemId: remembered.itemId, revision: remembered.revision }],
		}),
	);
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [remembered.itemId],
		messageIds: [],
	});
	const count = (table: string) =>
		h.store.read(
			(db) =>
				(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
					.n,
		);
	expect(count("memory_explicit_request")).toBe(0);
	expect(count("memory_short_ref")).toBe(0);
	expect(
		await write(h, (db) =>
			h.memory.withdrawExplicitInTransaction(db, {
				conversationId: "c1",
				sourceRunId: "run-w",
			}),
		),
	).toEqual({ status: "rejected", reason: "nothing_to_withdraw" });
});

test("a suppression keeps the record and leaves it out of the next `## Memory`; releasing it adds it back beside the profile", async () => {
	const s = await scenario();
	const { h } = s;
	const [shown] = await write(h, (db) =>
		h.memory.shortRefs.assignInTransaction(db, {
			conversationId: "c1",
			windowKey: "w1",
			items: [{ itemId: s.curry.id, revision: s.curry.revision }],
		}),
	);
	const marked = await write(h, (db) =>
		h.memory.suppressInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-s",
			target: { ref: shown?.ref as string },
		}),
	);
	expect(marked).toEqual({
		status: "applied",
		scope: "fact",
		itemId: s.curry.id,
		term: null,
	});
	expect(h.memory.list(true).map((item) => item.id)).toContain(s.curry.id);
	expect(
		await write(h, (db) => h.memory.suppressionsInTransaction(db)),
	).toEqual({
		terms: [],
		facts: [{ subject: "self", kind: "preference", semanticKey: "food" }],
	});
	// It shows in the window the run held, so an immediate change makes the next read re-publish without it.
	await write(h, (db) => {
		expect(
			h.memory.windows.changedSinceInTransaction(
				db,
				s.window.inputs.immediateSeq,
				"run-other",
			),
		).toBe(true);
	});
	const republished = await h.window();
	expect(republished.profile.items.map((item) => item.id)).toEqual([
		s.second.id,
	]);
	expect(
		await write(h, (db) =>
			h.memory.suppressInTransaction(db, {
				conversationId: "c1",
				sourceRunId: "run-s",
				target: { itemId: s.curry.id },
			}),
		),
	).toMatchObject({ status: "unchanged" });
	const released = await write(h, (db) =>
		h.memory.releaseSuppressionInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-s",
			target: { itemId: s.curry.id },
		}),
	);
	expect(released).toMatchObject({ status: "applied", itemId: s.curry.id });
	// An addition: it waits beside the published profile.
	const after = await h.window();
	expect(after.profile.items.map((item) => item.id)).toEqual([s.second.id]);
	expect(after.newMemories.map((item) => item.id)).toEqual([s.curry.id]);
	await write(h, (db) => {
		expect(h.memory.suppressionsInTransaction(db).facts).toEqual([]);
	});
});

test("suppressing an item the windows do not show expires nobody", async () => {
	const s = await scenario();
	const { h } = s;
	// The superseded old version is in no window.
	const before = s.window.inputs.immediateSeq;
	await write(h, (db) =>
		h.memory.suppressInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-s",
			target: { itemId: s.first.id },
		}),
	);
	// A suppression of a fact marks every version: the shown one is the current version of the same fact.
	await write(h, (db) => {
		expect(
			h.memory.windows.changedSinceInTransaction(db, before, "run-other"),
		).toBe(true);
	});
	const reset = await setupMemory();
	open.push(reset);
	const id = await reset.say("user", "毎朝走っています");
	const item = await reset.remember({
		conversationId: "c1",
		messageId: id,
		quote: "毎朝走って",
		kind: "habit",
		semanticKey: "habit.run",
		text: "毎朝走っている",
	});
	// No window exists yet: nothing shows the item.
	await write(reset, (db) =>
		reset.memory.suppressInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-s",
			target: { itemId: item.id },
		}),
	);
	const window = await reset.window();
	expect(window.profile.items).toEqual([]);
	await write(reset, (db) => {
		expect(
			reset.memory.windows.changedSinceInTransaction(db, 0, "run-other"),
		).toBe(false);
	});
});

test("a topic word is suppressed in a small table of its own, normalized, and lifted by the same word", async () => {
	const h = await setupMemory();
	open.push(h);
	const call = (
		op: "suppressInTransaction" | "releaseSuppressionInTransaction",
		term: string,
	) =>
		write(h, (db) =>
			h.memory[op](db, {
				conversationId: "c1",
				sourceRunId: "run-s",
				target: { term },
			}),
		);
	expect(await call("suppressInTransaction", "  元カノ  ")).toEqual({
		status: "applied",
		scope: "term",
		itemId: null,
		term: "元カノ",
	});
	expect(await call("suppressInTransaction", "元カノ")).toMatchObject({
		status: "unchanged",
	});
	expect(await call("suppressInTransaction", "   ")).toEqual({
		status: "rejected",
		reason: "invalid_input",
	});
	expect(await call("suppressInTransaction", "あ".repeat(101))).toEqual({
		status: "rejected",
		reason: "invalid_input",
	});
	expect(
		await write(h, (db) => h.memory.suppressionsInTransaction(db)),
	).toEqual({ terms: ["元カノ"], facts: [] });
	expect(await call("releaseSuppressionInTransaction", "元カノ")).toMatchObject(
		{
			status: "applied",
			scope: "term",
		},
	);
	expect(await call("releaseSuppressionInTransaction", "元カノ")).toMatchObject(
		{
			status: "unchanged",
		},
	);
	expect(
		await write(h, (db) => h.memory.suppressionsInTransaction(db)),
	).toEqual({ terms: [], facts: [] });
});

test("while a forget is only excluded, the plans and ledger entries resting on its items, their messages or a blocked message are out of every read; the closure delete removes them", async () => {
	const s = await scenario();
	const { h } = s;
	const fresh = await h.say("user", "来週の水曜は歯医者です");
	const scheduled = await h.say("user", "定期の問い合わせ");
	const onMessage = await h.plan("c1", {
		kind: "plan",
		text: "引っ越しの手続き",
		messageIds: [s.moved],
	});
	const onItem = await h.plan("c1", {
		kind: "intent",
		text: "住所変更を出す",
		messageIds: [fresh],
	});
	await h.store.write((db) =>
		h.continuity.plans.updateInTransaction(db, onItem.id, {
			text: "住所変更を出す",
			evidence: { messages: [], memoryItemIds: [s.second.id] },
		}),
	);
	const unrelated = await h.plan("c1", {
		kind: "plan",
		text: "水曜に歯医者",
		dueAt: "2026-11-25",
		messageIds: [fresh],
	});
	const blocked = await h.plan("c1", {
		kind: "plan",
		text: "定期の用事",
		messageIds: [scheduled],
	});
	const ledger = await h.store.write((db) =>
		h.continuity.questions.recordInTransaction(db, {
			conversationId: "c1",
			attribute: "以前の住所",
			state: "answered",
			evidence: { messages: [{ messageId: s.old }] },
		}),
	);
	const visible = () =>
		h.store.read((db) => ({
			plans: h.continuity.plans
				.listInTransaction(db, { conversationId: "c1" })
				.map((plan) => plan.id)
				.sort(),
			found: h.continuity.plans
				.searchInTransaction(db, "住所変更")
				.map((plan) => plan.id),
			got: h.continuity.plans.getInTransaction(db, onItem.id)?.id ?? null,
			questions: h.continuity.questions
				.listInTransaction(db, { states: ["answered"] })
				.map((entry) => entry.id),
		}));
	expect(visible()).toEqual({
		plans: [onMessage.id, onItem.id, unrelated.id, blocked.id].sort(),
		found: [onItem.id],
		got: onItem.id,
		questions: [ledger.id],
	});
	// A blocked message hides what rests on it at once.
	await write(h, (db) =>
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "c1",
			messageIds: [scheduled],
			reason: "scheduled_prompt",
		}),
	);
	expect(visible().plans).not.toContain(blocked.id);
	await write(h, (db) =>
		h.memory.excludeForForgetInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-x",
			targets: [{ itemId: s.second.id }],
		}),
	);
	// The versions are excluded, not deleted: the entries are hidden, the rest reads on.
	expect(visible()).toEqual({
		plans: [unrelated.id],
		found: [],
		got: null,
		questions: [],
	});
	const rows = (table: string) =>
		h.store.read(
			(db) =>
				(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
					.n,
		);
	expect(rows("continuity_plans")).toBe(4);
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [s.second.id],
		messageIds: [],
	});
	expect(visible().plans).toEqual([unrelated.id]);
	expect(rows("continuity_plans")).toBe(2);
	expect(rows("continuity_questions")).toBe(0);
});

/** A fact with `versions` versions (each one replaces the one before). */
async function versions(
	h: MemoryHarness,
	semanticKey: string,
	texts: readonly string[],
) {
	const made: Array<{ id: string; revision: number; messageId: string }> = [];
	for (const text of texts) {
		const messageId = await h.say("user", `${text}です`);
		const item = await h.remember({
			conversationId: "c1",
			messageId,
			quote: text,
			kind: "personal_fact",
			semanticKey,
			text,
		});
		made.push({ id: item.id, revision: item.revision, messageId });
	}
	return made;
}

test("the closure delete after an exclusion has no limit on the count: a fact of six versions, and three facts of two", async () => {
	const h = await setupMemory();
	open.push(h);
	const six = await versions(h, "address", [
		"住所は大阪市",
		"住所は京都市",
		"住所は神戸市",
		"住所は奈良市",
		"住所は福岡市",
		"住所は東京都",
	]);
	const a = await versions(h, "job", ["仕事は教師", "仕事は医者"]);
	const b = await versions(h, "pet", ["ペットは猫", "ペットは犬"]);
	const c = await versions(h, "car", ["車はトヨタ", "車はホンダ"]);
	const closure = (input: {
		itemIds: readonly string[];
		messageIds?: readonly string[];
	}) =>
		write(h, (db) =>
			h.memory.closeExclusionInTransaction(db, {
				conversationId: "c1",
				messageIds: [],
				...input,
			}),
		);
	// The user's request is one fact, named by its newest version; what the exclusion found is six items.
	const first = await write(h, (db) =>
		h.memory.excludeForForgetInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-x",
			targets: [{ itemId: six.at(-1)!.id }],
		}),
	);
	if (first.status !== "applied") throw new Error(JSON.stringify(first));
	expect(first.itemIds).toHaveLength(6);
	// The ordinary forget keeps its limit for a request ...
	await expect(
		h.memory.forget({
			conversationId: "c1",
			itemIds: first.itemIds,
			messageIds: [],
		}),
	).rejects.toThrow("forget_limit");
	// ... the closure of an exclusion has none.
	const closed = await closure({ itemIds: first.itemIds });
	expect(closed.completed).toBe(true);
	expect(new Set(closed.forgottenItemIds)).toEqual(new Set(first.itemIds));
	expect(new Set(closed.blockedMessageIds)).toEqual(
		new Set(six.map((entry) => entry.messageId)),
	);
	expect(
		h.memory
			.list(true)
			.map((item) => item.id)
			.sort(),
	).toEqual([...a, ...b, ...c].map((entry) => entry.id).sort());
	expect(exclusionsOf(h)).toEqual([]);
	// Three facts of two versions each: three targets, six items.
	const second = await write(h, (db) =>
		h.memory.excludeForForgetInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-y",
			targets: [a, b, c].map((fact) => ({ itemId: fact.at(-1)!.id })),
		}),
	);
	if (second.status !== "applied") throw new Error(JSON.stringify(second));
	expect(second.itemIds).toHaveLength(6);
	expect((await closure({ itemIds: second.itemIds })).completed).toBe(true);
	expect(h.memory.list(true)).toEqual([]);
	expect(exclusionsOf(h)).toEqual([]);
});

test("while a forget is only excluded, the tendencies standing on what is excluded leave `read_memory`, and one answer says which messages are withheld", async () => {
	const s = await scenario();
	const { h } = s;
	const p1 = await h.say("user", "最近は朝に走ることが多い", "c1");
	const p2 = await h.say("user", "昨日も朝に走った", "c2");
	const scheduled = await h.say("user", "定期の問い合わせ");
	const tendency = (text: string, messageIds: string[], candidateId?: string) =>
		plantTendency(h, {
			text,
			messageIds,
			...(candidateId ? { candidateId } : {}),
		});
	// One on two State items (the steward's way), one on messages of an item that will be excluded, one on a
	// candidate that will be excluded, one that stands on nothing excluded.
	const [onItems] = await h.curate([
		{
			op: "tendency_add",
			text: "住所と食べ物の話をする",
			evidence: [
				{ namespace: "state", id: s.second.id },
				{ namespace: "state", id: s.curry.id },
			],
		},
	]);
	if (onItems?.status !== "applied") throw new Error("not applied");
	await tendency("引っ越しの話をする", [s.moved, p2]);
	await tendency("散歩の話をする", [p1, p2], s.unrelated.candidateId);
	await tendency("朝に走る", [p1, p2]);
	const tendencyTexts = () =>
		(readEverything(h.memory)?.items ?? [])
			.flatMap((item) => (item.kind === "tendency" ? [item.text] : []))
			.sort();
	expect(tendencyTexts()).toEqual(
		[
			"住所と食べ物の話をする",
			"引っ越しの話をする",
			"散歩の話をする",
			"朝に走る",
		].sort(),
	);
	await write(h, (db) =>
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "c1",
			messageIds: [scheduled],
			reason: "scheduled_prompt",
		}),
	);
	const withheld = (ids: string[]) =>
		write(h, (db) => h.memory.withheldMessagesInTransaction(db, ids));
	const all = [s.old, s.moved, s.food, p1, p2, scheduled];
	// A blocked message is withheld before anything is excluded; nothing else is.
	expect(await withheld(all)).toEqual(new Set([scheduled]));
	await write(h, (db) =>
		h.memory.excludeForForgetInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-x",
			targets: [
				{ itemId: s.second.id },
				{ candidateId: s.unrelated.candidateId },
			],
		}),
	);
	// The messages the excluded versions stand on are withheld with the blocked one; the rest are not.
	expect(await withheld(all)).toEqual(new Set([s.old, s.moved, scheduled]));
	expect(await withheld([])).toEqual(new Set());
	// Only the tendency that stands on nothing excluded is read.
	expect(tendencyTexts()).toEqual(["朝に走る"]);
	// The owner's list is not `read_memory`: the tendencies are still there until the closure delete.
	expect(h.memory.tendencies()).toHaveLength(4);
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [s.second.id],
		messageIds: [],
	});
	expect(tendencyTexts()).toEqual(["朝に走る"]);
	expect(h.memory.tendencies().map((entry) => entry.text)).toEqual([
		"朝に走る",
	]);
	// After the closure delete the forgotten messages are blocked: still withheld.
	expect(await withheld(all)).toEqual(new Set([s.old, s.moved, scheduled]));
});

test("the purge of a closure delete is told which run excluded the items, so it can leave that run's calls standing", async () => {
	const h = await setupMemory();
	open.push(h);
	const [made] = await versions(h, "pet", ["ペットは猫"]);
	const purges: Array<readonly string[] | undefined> = [];
	h.memory.registerForgetPurge((_db, purge) => {
		purges.push(purge.exceptSubjects);
	});
	const excluded = await write(h, (db) =>
		h.memory.excludeForForgetInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-x",
			targets: [{ itemId: made!.id }],
		}),
	);
	if (excluded.status !== "applied") throw new Error(JSON.stringify(excluded));
	await write(h, (db) =>
		h.memory.closeExclusionInTransaction(db, {
			conversationId: "c1",
			itemIds: excluded.itemIds,
			messageIds: excluded.evidenceMessageIds,
		}),
	);
	expect(purges).toEqual([["run-x"]]);
	// A forget nobody excluded first names no run.
	const [other] = await versions(h, "car", ["車はトヨタ"]);
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [other!.id],
		messageIds: [],
	});
	expect(purges.at(-1)).toBeUndefined();
});
