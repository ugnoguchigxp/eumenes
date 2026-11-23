import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import { plantCandidate, plantTendency } from "./existing-data.fixture";
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
const runRows = (h: MemoryHarness) =>
	h.store.read(
		(db) =>
			(
				db.query("SELECT COUNT(*) AS n FROM memory_tendency_run").get() as {
					n: number;
				}
			).n,
	);

test("forgetting a message a tendency stands on deletes the tendency and its run", async () => {
	const h = await setup();
	const a = await h.say("user", "最近は夜に散歩することが多い", "c1");
	const b = await h.say("user", "昨日も夜に散歩に出た", "c2");
	await plantTendency(h, { text: "夜に散歩する傾向", messageIds: [a, b] });
	expect(h.memory.tendencies()).toHaveLength(1);
	await h.memory.forget({ conversationId: "c2", itemIds: [], messageIds: [b] });
	expect(h.memory.tendencies()).toEqual([]);
	expect(runRows(h)).toBe(0);
});

test("forgetting the candidate a tendency came from deletes the tendency, though its messages stay", async () => {
	const h = await setup();
	const a = await h.say("user", "最近は夜に散歩することが多い", "c1");
	const b = await h.say("user", "昨日も夜に散歩に出た", "c2");
	const candidate = await plantCandidate(h, {
		messageIds: [a],
		kind: "habit",
		semanticKey: "habit.walk",
		text: "夜に散歩する",
	});
	// A State item of the same fact: forgetting it takes the fact's candidates along.
	const own = await h.say("user", "夜に散歩するのが日課です", "c1");
	const item = await h.remember({
		conversationId: "c1",
		messageId: own,
		quote: "夜に散歩する",
		kind: "habit",
		semanticKey: "habit.walk",
		text: "夜に散歩する",
	});
	await plantTendency(h, {
		text: "夜に散歩する傾向",
		messageIds: [a, b],
		candidateId: candidate.candidateId,
	});
	await plantTendency(h, { text: "別の傾向", messageIds: [a, b] });
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [item.id],
		messageIds: [],
	});
	// Only the tendency of the forgotten candidate went; the messages were not blocked.
	expect(h.memory.tendencies().map((entry) => entry.text)).toEqual([
		"別の傾向",
	]);
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
	const a = await h.say("user", "最近は夜に散歩することが多い", "c1");
	const b = await h.say("user", "昨日も夜に散歩に出た", "c2");
	const id = await plantTendency(h, {
		text: "夜に散歩する傾向",
		messageIds: [a, b],
	});
	const paused = await h.memory.maintenance.apply({
		conversationId: "c1",
		active: false,
		refs: [{ kind: "tendency" as const, id, revision: 1 }],
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
