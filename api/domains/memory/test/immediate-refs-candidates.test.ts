import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { listCandidates } from "eumenes-memory/sqlite";
import { configureLogging } from "../../../infrastructure/logger";
import { PRINCIPAL, PROFILE_SCOPE } from "../contracts";
import { plantCandidate } from "./existing-data.fixture";
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

// ---- candidates (of the removed sleeping layer: an existing database still holds them) ----

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
	await plantCandidate(h, {
		messageIds: [said],
		kind: "habit",
		semanticKey: "habit.walk",
		text: "夜に散歩する",
	});
	const elsewhere = await h.say("user", "カレーをよく食べます");
	const other = await plantCandidate(h, {
		messageIds: [elsewhere],
		kind: "preference",
		semanticKey: "food",
		text: "カレーが好きそう",
	});
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

test("a forget also takes the candidates of other facts that stand on a forgotten message, whole (one piece of evidence cannot be cut out)", async () => {
	const h = await setup();
	const gone = await h.say("user", "元カノと夜に散歩していた");
	const kept = await h.say("user", "毎朝コーヒーを飲んでいる");
	const other = await h.say("user", "昨日も夜に散歩に出た", "c2");
	const record = (
		messageIds: string[],
		over: { semanticKey: string; text: string },
	) => plantCandidate(h, { messageIds, kind: "habit", ...over });
	await record([gone], {
		semanticKey: "habit.ex",
		text: "元カノと散歩する",
	});
	// Two pieces of evidence, one of them on the forgotten message: the candidate goes whole.
	await record([gone, kept], {
		semanticKey: "habit.walk",
		text: "夜に散歩する",
	});
	const other2 = await record([other], {
		semanticKey: "habit.walk",
		text: "夜に散歩している",
	});
	const unrelated = await record([kept], {
		semanticKey: "habit.coffee",
		text: "毎朝コーヒーを飲む",
	});
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
	expect(ids()).toEqual([other2.candidateId, unrelated.candidateId].sort());
});
