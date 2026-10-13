import { afterEach, expect, test } from "bun:test";
import {
	deleteTendenciesByStateEvidence,
	insertTendency,
	tendencyRevision,
} from "../repository";
import { setupMemory, type MemoryHarness } from "./memory.fixture";

const open: MemoryHarness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});
async function setup() {
	const h = await setupMemory();
	open.push(h);
	return h;
}
const tendency = (
	id: string,
	evidence: Array<{ namespace: "state" | "continuity"; id: string }>,
	status: "active" | "retired" = "active",
) => ({
	id,
	text: "朝型の傾向",
	evidence,
	status,
	revision: 1,
	createdAt: "2026-10-13T12:00:00.000Z",
	updatedAt: "2026-10-13T12:00:00.000Z",
});
const tendencyIds = (h: MemoryHarness) =>
	h.store
		.read(
			(db) =>
				db.query("SELECT id FROM memory_tendency ORDER BY id").all() as Array<{
					id: string;
				}>,
		)
		.map((row) => row.id);

test("forgetting a State item deletes the tendencies that name it, and only those", async () => {
	const h = await setup();
	const a = await h.seed("コーヒーが好き", "drink.coffee");
	const b = await h.seed("紅茶が好き", "drink.tea");
	const c = await h.seed("毎朝走っている", "run", "毎朝走って", "habit");
	await h.store.write((db) => {
		insertTendency(
			db,
			tendency("t-a", [
				{ namespace: "state", id: a.id },
				{ namespace: "state", id: b.id },
			]),
		);
		insertTendency(
			db,
			tendency(
				"t-a-retired",
				[
					{ namespace: "state", id: c.id },
					{ namespace: "state", id: a.id },
				],
				"retired",
			),
		);
		insertTendency(
			db,
			tendency("t-bc", [
				{ namespace: "state", id: b.id },
				{ namespace: "state", id: c.id },
			]),
		);
		// A note with the same id text is another namespace and is not matched.
		insertTendency(
			db,
			tendency("t-note", [
				{ namespace: "continuity", id: a.id },
				{ namespace: "state", id: c.id },
			]),
		);
	});
	const revision = h.store.read((db) => tendencyRevision(db));
	await h.memory.forget(a.id);
	expect(tendencyIds(h)).toEqual(["t-bc", "t-note"]);
	expect(h.store.read((db) => tendencyRevision(db))).toBe(revision + 1);
});

test("forgetting one version of a fact deletes tendencies that name any version of it", async () => {
	const h = await setup();
	const first = await h.seed("コーヒーが好き", "drink.coffee");
	const second = await h.seed("毎朝走っている", "run", "毎朝走って", "habit");
	const messageId = await h.say(
		"user",
		"やっぱりコーヒーはブラックが好き",
		"c1",
	);
	const replaced = await h.memory.remember({
		conversationId: "c1",
		messageId,
		quote: "コーヒーはブラックが好き",
		kind: "preference",
		semanticKey: "drink.coffee",
		text: "コーヒーはブラックが好き",
		polarity: "affirmed",
	});
	await h.store.write((db) => {
		insertTendency(
			db,
			tendency("t-old", [
				{ namespace: "state", id: first.id },
				{ namespace: "state", id: second.id },
			]),
		);
		insertTendency(
			db,
			tendency("t-keep", [{ namespace: "state", id: second.id }]),
		);
	});
	await h.memory.forget(replaced.id);
	expect(tendencyIds(h)).toEqual(["t-keep"]);
});

test("a forget that fails leaves the tendencies alone", async () => {
	const h = await setup();
	const a = await h.seed("コーヒーが好き", "drink.coffee");
	await h.store.write((db) =>
		insertTendency(db, tendency("t-a", [{ namespace: "state", id: a.id }])),
	);
	await expect(h.memory.forget(`state:${"a".repeat(64)}`)).rejects.toThrow(
		"invalid_memory_item",
	);
	expect(tendencyIds(h)).toEqual(["t-a"]);
});

test("recovery removes tendencies derived from journaled forgets, also when the database still held them", async () => {
	const h = await setup();
	const a = await h.seed("コーヒーが好き", "drink.coffee");
	const b = await h.seed("紅茶が好き", "drink.tea");
	await h.memory.forget(a.id);
	// A restored older database: the forgotten item's tendency is back.
	await h.store.write((db) => {
		insertTendency(
			db,
			tendency("t-restored", [
				{ namespace: "state", id: a.id },
				{ namespace: "state", id: b.id },
			]),
		);
		insertTendency(db, tendency("t-ok", [{ namespace: "state", id: b.id }]));
	});
	const revision = h.store.read((db) => tendencyRevision(db));
	expect((await h.memory.recover()).healthy).toBe(true);
	expect(tendencyIds(h)).toEqual(["t-ok"]);
	expect(h.store.read((db) => tendencyRevision(db))).toBe(revision + 1);
	// The stored windows were purged with it: the next prepare rebuilds.
	expect(
		h.store.read(
			(db) =>
				db.query("SELECT COUNT(*) AS n FROM memory_context_window").get() as {
					n: number;
				},
		).n,
	).toBe(0);
});

test("more than five hundred item ids are deleted in chunks, with duplicates ignored", async () => {
	const h = await setup();
	const ids = Array.from({ length: 1200 }, (_, i) => `state:${i}`);
	await h.store.write((db) => {
		insertTendency(
			db,
			tendency("t-first", [{ namespace: "state", id: ids[0]! }]),
		);
		insertTendency(
			db,
			tendency("t-middle", [{ namespace: "state", id: ids[700]! }]),
		);
		insertTendency(
			db,
			tendency("t-last", [{ namespace: "state", id: ids[1199]! }]),
		);
		insertTendency(
			db,
			tendency("t-other", [{ namespace: "state", id: "state:other" }]),
		);
	});
	const revision = h.store.read((db) => tendencyRevision(db));
	const deleted = await h.store.write((db) =>
		deleteTendenciesByStateEvidence(db, [...ids, ...ids]),
	);
	expect(deleted).toBe(3);
	expect(tendencyIds(h)).toEqual(["t-other"]);
	expect(h.store.read((db) => tendencyRevision(db))).toBe(revision + 1);
	// Nothing to delete: no revision change.
	expect(
		await h.store.write((db) => deleteTendenciesByStateEvidence(db, ids)),
	).toBe(0);
	expect(h.store.read((db) => tendencyRevision(db))).toBe(revision + 1);
});
