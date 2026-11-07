import { afterEach, expect, test } from "bun:test";
import { setupMemory, type MemoryHarness } from "./memory.fixture";
const open: MemoryHarness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});

test("reference versions reject corrections, inactive items, wrong versions and forgotten messages", async () => {
	const h = await setupMemory();
	open.push(h);
	const said = await h.exchange("紅茶が好き", null);
	const item = await h.remember({
		conversationId: "c1",
		messageId: said.userId,
		kind: "preference",
		semanticKey: "drink",
		text: "紅茶が好き",
	});
	const input = h.store.read((db) =>
		h.memory.referenceInputs.captureInTransaction(db, {
			messageIds: [said.userId],
			itemIds: [item.id],
		}),
	);
	expect(input.complete).toBe(true);
	expect(
		h.store.read((db) =>
			h.memory.referenceInputs.isCurrentInTransaction(db, input),
		),
	).toBe(true);
	const wrong = h.store.read((db) =>
		h.memory.referenceInputs.captureInTransaction(db, {
			itemIds: [item.id],
			itemRevisions: { [item.id]: item.revision + 1 },
		}),
	);
	expect(wrong.complete).toBe(false);
	await h.memory.forget({
		conversationId: "c1",
		messageIds: [],
		itemIds: [item.id],
	});
	expect(
		h.store.read((db) =>
			h.memory.referenceInputs.isCurrentInTransaction(db, input),
		),
	).toBe(false);
	expect(
		h.store.read((db) =>
			h.memory.referenceInputs.isCurrentInTransaction(db, {
				sources: [],
				complete: false,
			}),
		),
	).toBe(false);
});

test("unrelated Record captures leave the State context window unchanged", async () => {
	const h = await setupMemory();
	open.push(h);
	const first = await h.store.write((db) =>
		h.memory.windowForRunInTransaction(db, "c1"),
	);
	await h.store.write((db) =>
		h.memory.referenceInputs.captureRecordInTransaction(db, {
			origin: { namespace: "host-test", kind: "observation", id: "1" },
			mediaType: "text/plain",
			content: "An independent host observation",
		}),
	);
	const next = await h.store.write((db) =>
		h.memory.windowForRunInTransaction(db, "c1"),
	);
	expect(next?.buildId).toBe(first?.buildId);
	expect(next?.version).toBe(first?.version);
});

test("runless host speech inherits its actual input manifest and legacy speech remains unknown", async () => {
	const h = await setupMemory();
	open.push(h);
	const said = await h.exchange("独立した入力", null);
	const answerId = await h.say("assistant", "旧い返答");
	const input = h.store.read((db) =>
		h.memory.referenceInputs.captureInTransaction(db, {
			messageIds: [said.userId],
		}),
	);
	expect(
		h.store.read((db) =>
			h.memory.referenceInputs.captureInTransaction(db, {
				messageIds: [answerId],
			}),
		).complete,
	).toBe(false);
	await h.store.write((db) =>
		h.memory.referenceInputs.recordMessageInTransaction(db, answerId, input),
	);
	const speech = h.store.read((db) =>
		h.memory.referenceInputs.captureInTransaction(db, {
			messageIds: [answerId],
		}),
	);
	expect(speech.complete).toBe(true);
	expect(speech.sources).toContain(said.userId);
	await h.memory.forget({
		conversationId: "c1",
		messageIds: [said.userId],
		itemIds: [],
	});
	expect(
		h.store.read((db) =>
			h.memory.referenceInputs.isCurrentInTransaction(db, speech),
		),
	).toBe(false);
});
