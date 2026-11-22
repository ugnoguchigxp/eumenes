import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { listCandidates } from "eumenes-memory/sqlite";
import { configureLogging } from "../../../infrastructure/logger";
import { PRINCIPAL, PROFILE_SCOPE } from "../contracts";
import type { RecordCandidateInput } from "../contracts/immediate";
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

// ---- short references ----

test("references are numbered in the order given, an item at a version keeps its reference, and a new window starts over", async () => {
	const h = await setup();
	const assign = (
		windowKey: string,
		items: Array<{ itemId: string; revision: number }>,
		conversationId = "c1",
	) =>
		write(h, (db) =>
			h.memory.shortRefs.assignInTransaction(db, {
				conversationId,
				windowKey,
				items,
			}),
		);
	const resolve = (ref: string, conversationId = "c1") =>
		write(h, (db) =>
			h.memory.shortRefs.resolveInTransaction(db, conversationId, ref),
		);
	expect(
		await assign("w1", [
			{ itemId: "a", revision: 1 },
			{ itemId: "b", revision: 1 },
		]),
	).toEqual([
		{ ref: "m1", itemId: "a", revision: 1 },
		{ ref: "m2", itemId: "b", revision: 1 },
	]);
	// A `read_memory` result beside the profile: the same window, so the numbering goes on and a shown item keeps its reference.
	expect(
		await assign("w1", [
			{ itemId: "b", revision: 1 },
			{ itemId: "c", revision: 3 },
			{ itemId: "a", revision: 2 },
		]),
	).toEqual([
		{ ref: "m2", itemId: "b", revision: 1 },
		{ ref: "m3", itemId: "c", revision: 3 },
		{ ref: "m4", itemId: "a", revision: 2 },
	]);
	expect(await resolve("m1")).toEqual({ itemId: "a", revision: 1 });
	expect(await resolve(" m4 ")).toEqual({ itemId: "a", revision: 2 });
	expect(await resolve("m5")).toBeNull();
	// Another conversation has windows of its own.
	expect(await resolve("m1", "c2")).toBeNull();
	expect(await assign("w1", [{ itemId: "z", revision: 1 }], "c2")).toEqual([
		{ ref: "m1", itemId: "z", revision: 1 },
	]);
	expect(await resolve("m1")).toEqual({ itemId: "a", revision: 1 });
	// The window changed: every earlier reference is gone, and the numbers go on (an old `m1` never names `c`).
	expect(await assign("w2", [{ itemId: "c", revision: 3 }])).toEqual([
		{ ref: "m5", itemId: "c", revision: 3 },
	]);
	expect(await resolve("m1")).toBeNull();
	expect(await resolve("m2")).toBeNull();
	expect(await resolve("m4")).toBeNull();
	expect(await resolve("m5")).toEqual({ itemId: "c", revision: 3 });
	// Back to an earlier key is a change too: nothing is carried over, the numbers still grow.
	expect(await assign("w1", [{ itemId: "a", revision: 1 }])).toEqual([
		{ ref: "m6", itemId: "a", revision: 1 },
	]);
	expect(await resolve("m5")).toBeNull();
	// Another conversation counts for itself.
	expect(await assign("w9", [{ itemId: "q", revision: 1 }], "c3")).toEqual([
		{ ref: "m1", itemId: "q", revision: 1 },
	]);
});

test("the profile's window key holds while the profile is the same and changes with it", async () => {
	const h = await setup();
	const { windowKeyOf } = h.memory.shortRefs;
	const a = [
		{ id: "x", revision: 1 },
		{ id: "y", revision: 2 },
	];
	expect(windowKeyOf(a)).toBe(windowKeyOf(a.map((item) => ({ ...item }))));
	expect(windowKeyOf(a)).not.toBe(windowKeyOf([...a].reverse()));
	expect(windowKeyOf(a)).not.toBe(
		windowKeyOf([
			{ id: "x", revision: 1 },
			{ id: "y", revision: 3 },
		]),
	);
});

test("references of the published profile resolve to the version it showed", async () => {
	const h = await setup();
	const id = await h.say("user", "毎朝走っています");
	const item = await h.remember({
		conversationId: "c1",
		messageId: id,
		quote: "毎朝走って",
		kind: "habit",
		semanticKey: "habit.run",
		text: "毎朝走っている",
	});
	const window = await h.window();
	const refs = await write(h, (db) =>
		h.memory.shortRefs.assignInTransaction(db, {
			conversationId: "c1",
			windowKey: h.memory.shortRefs.windowKeyOf(window.profile.items),
			items: window.profile.items.map((shown) => ({
				itemId: shown.id,
				revision: shown.revision,
			})),
		}),
	);
	expect(refs).toEqual([
		{ ref: "m1", itemId: item.id, revision: item.revision },
	]);
	// The profile is republished with another item: the key moves, `m1` is no longer a promise.
	const other = await h.say("user", "毎晩本を読んでいます");
	await h.remember({
		conversationId: "c1",
		messageId: other,
		quote: "毎晩本を読んで",
		kind: "habit",
		semanticKey: "habit.read",
		text: "毎晩本を読んでいる",
	});
	const next = await write(h, (db) =>
		h.memory.republishWindowInTransaction(db, "c1"),
	);
	const key = h.memory.shortRefs.windowKeyOf(next?.profile.items ?? []);
	expect(key).not.toBe(h.memory.shortRefs.windowKeyOf(window.profile.items));
	const again = await write(h, (db) =>
		h.memory.shortRefs.assignInTransaction(db, {
			conversationId: "c1",
			windowKey: key,
			items: (next?.profile.items ?? []).map((shown) => ({
				itemId: shown.id,
				revision: shown.revision,
			})),
		}),
	);
	// The profile changed: the numbers go on from the first window's `m1`.
	expect(again.map((entry) => entry.ref)).toEqual(["m2", "m3"]);
});

// ---- candidates ----

const candidateInput = (
	over: Partial<RecordCandidateInput> & Pick<RecordCandidateInput, "evidence">,
): RecordCandidateInput => ({
	conversationId: "c1",
	sourceRunId: "run-c",
	kind: "habit",
	semanticKey: "habit.walk",
	subject: "self",
	text: "夜に散歩する",
	polarity: "affirmed",
	...over,
});
const openCandidates = (h: MemoryHarness) =>
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
		});
		if (listed.status !== "ok") throw new Error("blocked");
		return listed.candidates;
	});

test("a candidate is recorded with grounds, counted once per place it was observed, and never shown to the conversation", async () => {
	const h = await setup();
	const first = await h.say("user", "最近は夜に散歩することが多い");
	const record = (over: Parameters<typeof candidateInput>[0]) =>
		write(h, (db) =>
			h.memory.recordCandidateInTransaction(db, candidateInput(over)),
		);
	const one = await record({
		evidence: [{ messageId: first, quote: "夜に散歩することが多い" }],
	});
	expect(one).toMatchObject({
		status: "recorded",
		created: true,
		newObservations: 1,
		observationCount: 1,
		conversationIds: ["c1"],
		external: false,
	});
	// A resend counts nothing; a second place counts.
	expect(
		await record({
			evidence: [{ messageId: first, quote: "夜に散歩することが多い" }],
		}),
	).toMatchObject({ created: false, newObservations: 0, observationCount: 1 });
	const second = await h.say("user", "昨日も夜に散歩に出た", "c2");
	expect(
		await write(h, (db) =>
			h.memory.recordCandidateInTransaction(
				db,
				candidateInput({
					conversationId: "c2",
					evidence: [{ messageId: second }],
				}),
			),
		),
	).toMatchObject({
		created: false,
		newObservations: 1,
		observationCount: 2,
		conversationIds: ["c1", "c2"],
	});
	expect(openCandidates(h)).toHaveLength(1);
	// Not a State item: the conversation's reading never sees it.
	expect(h.memory.list(true)).toEqual([]);
	expect((await h.window()).profile.items).toEqual([]);
});

test("a candidate refuses what has no grounds: a quote that is not there, a message that is not the user's, bad fields", async () => {
	const h = await setup();
	const user = await h.say("user", "最近は夜に散歩することが多い");
	const assistant = await h.say("assistant", "夜の散歩はいいですね");
	const reason = async (over: Parameters<typeof candidateInput>[0]) => {
		const outcome = await write(h, (db) =>
			h.memory.recordCandidateInTransaction(db, candidateInput(over)),
		);
		return outcome.status === "rejected" ? outcome.reason : outcome.status;
	};
	expect(
		await reason({ evidence: [{ messageId: user, quote: "朝に走る" }] }),
	).toBe("quote_mismatch");
	expect(await reason({ evidence: [{ messageId: assistant }] })).toBe(
		"invalid_source",
	);
	expect(await reason({ evidence: [{ messageId: "nope" }] })).toBe(
		"invalid_source",
	);
	expect(await reason({ evidence: [] })).toBe("invalid_input");
	expect(
		await reason({ evidence: [{ messageId: user }], kind: "x" as never }),
	).toBe("invalid_input");
	expect(
		await reason({ evidence: [{ messageId: user }], semanticKey: "Bad Key" }),
	).toBe("invalid_key");
	expect(await reason({ evidence: [{ messageId: user }], text: "" })).toBe(
		"invalid_input",
	);
	expect(openCandidates(h)).toEqual([]);
});

test("an outside note can ground a candidate, which is then marked external", async () => {
	const h = await setup();
	const outcome = await write(h, (db) =>
		h.memory.recordCandidateInTransaction(
			db,
			candidateInput({
				evidence: [
					{
						note: {
							id: "note-1",
							text: "調べた結果: 利用者は夜型の生活をしている",
						},
						quote: "夜型の生活",
					},
				],
			}),
		),
	);
	expect(outcome).toMatchObject({
		status: "recorded",
		external: true,
		conversationIds: ["c1"],
	});
	expect(
		openCandidates(h)[0]?.evidence.map((ref) => [ref.namespace, ref.kind]),
	).toEqual([["note", "memo"]]);
	// The quote must be in the note.
	expect(
		await write(h, (db) =>
			h.memory.recordCandidateInTransaction(
				db,
				candidateInput({
					evidence: [
						{ note: { id: "note-1", text: "夜型の生活" }, quote: "朝型" },
					],
				}),
			),
		),
	).toEqual({ status: "rejected", reason: "quote_mismatch" });
});

test("a forget takes the candidates of the fact with it, also without an exclusion before", async () => {
	const h = await setup();
	const said = await h.say("user", "夜に散歩に出るのが好きです");
	const item = await h.remember({
		conversationId: "c1",
		messageId: said,
		quote: "夜に散歩に出る",
		kind: "habit",
		semanticKey: "habit.walk",
		text: "夜に散歩に出る",
	});
	const recorded = await write(h, (db) =>
		h.memory.recordCandidateInTransaction(
			db,
			candidateInput({ evidence: [{ messageId: said }] }),
		),
	);
	if (recorded.status !== "recorded") throw new Error("not recorded");
	const elsewhere = await h.say("user", "カレーをよく食べます");
	const other = await write(h, (db) =>
		h.memory.recordCandidateInTransaction(
			db,
			candidateInput({
				kind: "preference",
				semanticKey: "food",
				text: "カレーが好きそう",
				evidence: [{ messageId: elsewhere }],
			}),
		),
	);
	if (other.status !== "recorded") throw new Error("not recorded");
	expect(openCandidates(h)).toHaveLength(2);
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [item.id],
		messageIds: [],
	});
	expect(openCandidates(h).map((candidate) => candidate.candidateId)).toEqual([
		other.candidateId,
	]);
});

// ---- the adoption check ----

test("a generation's own changes do not count against it; anyone else's do, and the baseline moves on", async () => {
	const h = await setup();
	const said = await h.say("user", "覚えといて、鍵は靴箱の上。");
	const baseline = await write(h, (db) =>
		h.memory.latestChangeSeqInTransaction(db),
	);
	await write(h, (db) =>
		h.memory.rememberExplicitInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-self",
			messageId: said,
			quote: "鍵は靴箱の上",
			kind: "personal_fact",
			semanticKey: "home.key.location",
			subject: "self",
			text: "鍵は靴箱の上に置いている",
			polarity: "affirmed",
		}),
	);
	const check = (runId: string, afterSeq: number) =>
		write(h, (db) =>
			h.memory.changedExcludingRunInTransaction(db, {
				sourceRunId: runId,
				afterSeq,
			}),
		);
	const own = await check("run-self", baseline);
	expect(own).toMatchObject({ changed: false, firstSeq: null });
	expect(own.latestSeq).toBeGreaterThan(baseline);
	// Another run's write, and a write that names no run, are both someone else's.
	const another = await h.say("user", "毎朝走っています");
	await write(h, (db) =>
		h.memory.rememberExplicitInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-other",
			messageId: another,
			quote: "毎朝走って",
			kind: "habit",
			semanticKey: "habit.run",
			subject: "self",
			text: "毎朝走っている",
			polarity: "affirmed",
		}),
	);
	expect(await check("run-self", own.latestSeq)).toMatchObject({
		changed: true,
	});
	const afterOther = await check("run-other", own.latestSeq);
	expect(afterOther.changed).toBe(false);
	await h.curate([
		{
			op: "remember",
			kind: "habit",
			key: "habit.read",
			text: "毎晩本を読む",
			messageId: await h.say("user", "毎晩本を読んでいます"),
			quote: "毎晩本を読んで",
		},
	]);
	expect(await check("run-other", afterOther.latestSeq)).toMatchObject({
		changed: true,
	});
});

test("a forget also takes the candidates of other facts that stand on a forgotten message, whole (one piece of evidence cannot be cut out)", async () => {
	const h = await setup();
	const gone = await h.say("user", "元カノと夜に散歩していた");
	const kept = await h.say("user", "毎朝コーヒーを飲んでいる");
	const other = await h.say("user", "昨日も夜に散歩に出た", "c2");
	const record = (messageIds: string[], over: Partial<RecordCandidateInput>) =>
		write(h, (db) =>
			h.memory.recordCandidateInTransaction(
				db,
				candidateInput({
					evidence: messageIds.map((messageId) => ({ messageId })),
					...over,
				}),
			),
		);
	const alone = await record([gone], {
		semanticKey: "habit.ex",
		text: "元カノと散歩する",
	});
	// Two pieces of evidence, one of them on the forgotten message: the candidate goes whole.
	const mixed = await record([gone, kept], {
		semanticKey: "habit.walk",
		text: "夜に散歩する",
	});
	const other2 = await record([other], {
		semanticKey: "habit.walk",
		text: "夜に散歩している",
		conversationId: "c2",
	});
	const unrelated = await record([kept], {
		semanticKey: "habit.coffee",
		text: "毎朝コーヒーを飲む",
	});
	for (const outcome of [alone, mixed, other2, unrelated])
		if (outcome.status !== "recorded") throw new Error("not recorded");
	const ids = () =>
		openCandidates(h)
			.map((candidate) => candidate.candidateId)
			.sort();
	expect(ids()).toHaveLength(4);
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [],
		messageIds: [gone],
	});
	expect(ids()).toEqual(
		[
			(other2 as { candidateId: string }).candidateId,
			(unrelated as { candidateId: string }).candidateId,
		].sort(),
	);
});
