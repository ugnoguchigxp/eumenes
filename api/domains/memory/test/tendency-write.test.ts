import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { SourceRef } from "eumenes-memory";
import { listCandidates } from "eumenes-memory/sqlite";
import { configureLogging } from "../../../infrastructure/logger";
import { PRINCIPAL, PROFILE_SCOPE } from "../contracts";
import type { WriteTendencyInput } from "../contracts/immediate";
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

/** A candidate observed in two conversations; returns it with the evidence the library holds (what the sleeping layer reads). */
async function observedTwice(h: MemoryHarness, semanticKey = "habit.walk") {
	const a = await h.say("user", "最近は夜に散歩することが多い", "c1");
	const b = await h.say("user", "昨日も夜に散歩に出た", "c2");
	for (const [conversationId, messageId] of [
		["c1", a],
		["c2", b],
	] as const) {
		const outcome = await write(h, (db) =>
			h.memory.recordCandidateInTransaction(db, {
				conversationId,
				sourceRunId: "run-c",
				kind: "habit",
				semanticKey,
				subject: "self",
				text: "夜に散歩する",
				polarity: "affirmed",
				evidence: [{ messageId }],
			}),
		);
		if (outcome.status !== "recorded") throw new Error("not recorded");
	}
	const candidate = h.store.read((db) => {
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
		return listed.candidates.find((entry) => entry.semanticKey === semanticKey);
	});
	if (!candidate) throw new Error("no candidate");
	return { a, b, candidate };
}
const input = (
	evidence: readonly SourceRef[],
	over: Partial<WriteTendencyInput> = {},
): WriteTendencyInput => ({
	sourceRunId: "run-deep",
	text: "夜に散歩する傾向",
	evidence,
	...over,
});
const runRows = (h: MemoryHarness) =>
	h.store.read(
		(db) =>
			(
				db.query("SELECT COUNT(*) AS n FROM memory_tendency_run").get() as {
					n: number;
				}
			).n,
	);

test("a tendency grounded in messages of two conversations is written with its run, and shows among the tendencies", async () => {
	const h = await setup();
	const { a, b, candidate } = await observedTwice(h);
	const outcome = await write(h, (db) =>
		h.memory.writeTendencyInTransaction(
			db,
			input(candidate.evidence, { candidateId: candidate.candidateId }),
		),
	);
	if (outcome.status !== "written") throw new Error(JSON.stringify(outcome));
	expect(new Set(outcome.conversationIds)).toEqual(new Set(["c1", "c2"]));
	expect(h.memory.tendencies()).toEqual([
		expect.objectContaining({
			id: outcome.tendencyId,
			text: "夜に散歩する傾向",
		}),
	]);
	const row = h.store.read(
		(db) =>
			db
				.query("SELECT evidence FROM memory_tendency WHERE id = ?")
				.get(outcome.tendencyId) as { evidence: string },
	);
	expect(JSON.parse(row.evidence)).toEqual([
		{ namespace: "message", id: a },
		{ namespace: "message", id: b },
		{ namespace: "candidate", id: candidate.candidateId },
	]);
	expect(runRows(h)).toBe(1);
	// The same words again change nothing.
	expect(
		await write(h, (db) =>
			h.memory.writeTendencyInTransaction(db, input(candidate.evidence)),
		),
	).toEqual({ status: "unchanged", tendencyId: outcome.tendencyId });
	// The window learns of the new tendency (its revision moved).
	const window = await h.window();
	expect(
		[...window.profile.items, ...window.newMemories].map((item) => item.text),
	).toContain("夜に散歩する傾向");
});

test("a tendency needs grounds from two conversations, the run, and the user's own usable messages", async () => {
	const h = await setup();
	const { a, b, candidate } = await observedTwice(h);
	const [first, second] = candidate.evidence;
	const reason = async (
		over: Partial<WriteTendencyInput>,
		evidence = candidate.evidence,
	) => {
		const outcome = await write(h, (db) =>
			h.memory.writeTendencyInTransaction(db, input(evidence, over)),
		);
		return outcome.status === "rejected" ? outcome.reason : outcome.status;
	};
	// One conversation only.
	expect(await reason({}, [first as SourceRef])).toBe(
		"not_enough_conversations",
	);
	expect(await reason({ sourceRunId: "" })).toBe("invalid_input");
	expect(await reason({ text: "  " })).toBe("invalid_input");
	expect(await reason({ text: "あ".repeat(121) })).toBe("invalid_input");
	expect(await reason({}, [])).toBe("invalid_input");
	// An outside note, an assistant message, an unknown message, a changed message.
	expect(
		await reason({}, [
			first as SourceRef,
			{ ...(second as SourceRef), namespace: "note", kind: "memo" },
		]),
	).toBe("invalid_source");
	const assistant = await h.say("assistant", "夜の散歩はいいですね", "c2");
	expect(
		await reason({}, [
			first as SourceRef,
			{ ...(second as SourceRef), id: assistant },
		]),
	).toBe("invalid_source");
	expect(
		await reason({}, [
			first as SourceRef,
			{ ...(second as SourceRef), id: "no-such-message" },
		]),
	).toBe("invalid_source");
	expect(
		await reason({}, [
			first as SourceRef,
			{ ...(second as SourceRef), digest: "0".repeat(64) },
		]),
	).toBe("invalid_source");
	await h.store.write((db) =>
		db
			.query(
				"INSERT INTO memory_message_block (message_id, conversation_id, reason, forget_id, created_at) VALUES (?, 'c2', 'scheduled_prompt', NULL, ?)",
			)
			.run(b, h.time.now),
	);
	expect(await reason({})).toBe("blocked_source");
	expect(h.memory.tendencies()).toEqual([]);
	expect(runRows(h)).toBe(0);
	expect(a).not.toBe(b);
});

test("at most twenty active tendencies", async () => {
	const h = await setup();
	const { candidate } = await observedTwice(h);
	for (let i = 0; i < 20; i++) {
		const outcome = await write(h, (db) =>
			h.memory.writeTendencyInTransaction(
				db,
				input(candidate.evidence, { text: `傾向${i}` }),
			),
		);
		expect(outcome.status).toBe("written");
	}
	expect(
		await write(h, (db) =>
			h.memory.writeTendencyInTransaction(
				db,
				input(candidate.evidence, { text: "二十一番目" }),
			),
		),
	).toEqual({ status: "rejected", reason: "limit_reached" });
});

test("forgetting a message it stands on deletes the tendency and its run", async () => {
	const h = await setup();
	const { b, candidate } = await observedTwice(h);
	await write(h, (db) =>
		h.memory.writeTendencyInTransaction(db, input(candidate.evidence)),
	);
	expect(h.memory.tendencies()).toHaveLength(1);
	await h.memory.forget({ conversationId: "c2", itemIds: [], messageIds: [b] });
	expect(h.memory.tendencies()).toEqual([]);
	expect(runRows(h)).toBe(0);
});

test("forgetting the candidate it came from deletes the tendency, though its messages stay", async () => {
	const h = await setup();
	const { a, b, candidate } = await observedTwice(h);
	// A State item of the same fact, from another message: forgetting it takes the fact's candidates along.
	const own = await h.say("user", "夜に散歩するのが日課です", "c1");
	const item = await h.remember({
		conversationId: "c1",
		messageId: own,
		quote: "夜に散歩する",
		kind: "habit",
		semanticKey: "habit.walk",
		text: "夜に散歩する",
	});
	await write(h, (db) =>
		h.memory.writeTendencyInTransaction(
			db,
			input(candidate.evidence, { candidateId: candidate.candidateId }),
		),
	);
	const unrelated = await write(h, (db) =>
		h.memory.writeTendencyInTransaction(
			db,
			input(candidate.evidence, { text: "別の傾向" }),
		),
	);
	if (unrelated.status !== "written") throw new Error("not written");
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [item.id],
		messageIds: [],
	});
	// Only the tendency of the forgotten candidate went; the messages were not blocked.
	expect(h.memory.tendencies().map((entry) => entry.text)).toEqual([
		"別の傾向",
	]);
	expect(h.memory.tendencies()).toHaveLength(1);
	expect(
		h.store.read((db) => h.conversation.messageInTransaction(db, a)),
	).not.toBeNull();
	expect(
		h.store.read((db) => h.conversation.messageInTransaction(db, b)),
	).not.toBeNull();
	expect(runRows(h)).toBe(1);
});

test("the owner can stop and restore a tendency that stands on messages", async () => {
	const h = await setup();
	const { candidate } = await observedTwice(h);
	const written = await write(h, (db) =>
		h.memory.writeTendencyInTransaction(db, input(candidate.evidence)),
	);
	if (written.status !== "written") throw new Error("not written");
	const refs = [
		{ kind: "tendency" as const, id: written.tendencyId, revision: 1 },
	];
	const paused = await h.memory.maintenance.apply({
		conversationId: "c1",
		active: false,
		refs,
	});
	expect(h.memory.tendencies()).toEqual([]);
	await h.memory.maintenance.apply({
		conversationId: "c1",
		active: true,
		refs: paused.items.map(({ kind, id, revision }) => ({
			kind,
			id,
			revision,
		})),
	});
	expect(h.memory.tendencies()).toHaveLength(1);
});
