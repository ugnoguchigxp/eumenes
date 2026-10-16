import { expect, test } from "bun:test";
import { SCOPE, addMessage, worldEdges } from "./fixture";
import {
	assertionRows,
	checkpointRows,
	claimOf,
	curate,
	inboxRows,
	mirrorRows,
	nothing,
	pending,
	TEXT,
	started,
	received,
	ready,
	settled,
	withService,
} from "./curation-fixture";

// World curation: window limits, held windows and routed-out events. See curation-fixture.ts for the shared rig.

test("a window is at most 12 utterances; the 9th claim of an output is overflow", async () => {
	const { life, rig } = await started();
	try {
		await withService(life);
		for (let i = 1; i <= 13; i++)
			await addMessage(life, `m${i}`, `音声サービスの${i}番目の話です。`);
		await received(life);
		const run = await curate(
			rig,
			() => ({
				entities: [],
				claims: Array.from({ length: 9 }, (_, i) =>
					claimOf({
						predicate: `p${i}`,
						value: { type: "number", value: i, unit: "件" },
					}),
				),
			}),
			pending(rig, 20).map((e) => e.eventId),
		);
		const prepared = ready(run);
		expect(prepared.eventIds).toHaveLength(12);
		expect(prepared.deferredEventIds).toHaveLength(1);
		const result = settled(run);
		expect(result.elements.filter((e) => e.status === "applied")).toHaveLength(
			8,
		);
		expect(result.elements[8]).toMatchObject({
			status: "dropped",
			reasonCodes: ["CANDIDATE_OVERFLOW"],
		});
		expect(mirrorRows(life).filter((r) => r.state === "received")).toHaveLength(
			1,
		);
	} finally {
		await life.cleanup();
	}
});

test("an utterance over 32 KiB is final for extraction and never reaches the model; exactly 32 KiB does", async () => {
	const { life, rig } = await started();
	try {
		await addMessage(life, "big", "あ".repeat(10_923)); // 32 769 bytes
		await addMessage(life, "fit", "a".repeat(32 * 1024));
		await received(life);
		const run = await curate(rig, nothing);
		if (run.prepare.status !== "ready") throw new Error(run.prepare.status);
		expect(run.prepare.finalized).toEqual([
			expect.objectContaining({
				messageId: "big",
				reason: "UTTERANCE_TOO_LARGE",
			}),
		]);
		expect(run.prepare.prepared.model.utterances).toHaveLength(1);
		expect(mirrorRows(life).map((r) => [r.state, r.reason])).toEqual([
			["rejected", "UTTERANCE_TOO_LARGE"],
			["applied", null],
		]);
	} finally {
		await life.cleanup();
	}
});

test("an unplaced subject holds the whole window until the entities change; giving up ends it for good", async () => {
	const { life, rig } = await started();
	try {
		await withService(life);
		await addMessage(life, "m1", "未登録の何かが9月から使える。");
		await addMessage(life, "m2", "音声サービスは便利だ。");
		await received(life);
		const answer = () => ({
			entities: [],
			claims: [
				claimOf({ subject: "未登録の何か" }),
				claimOf({ evidence: "e2" }),
			],
		});
		const run = await curate(rig, answer);
		expect(run.settle).toMatchObject({
			status: "held",
			reasonCodes: ["SUBJECT_UNRESOLVED"],
		});
		// Nothing was written: no claim, both events pending, no Memory dependents left.
		expect(assertionRows(life)).toHaveLength(0);
		expect(mirrorRows(life).map((r) => [r.state, r.manifest_id])).toEqual([
			["received", null],
			["received", null],
		]);
		expect(mirrorRows(life)[0]!.held_context_digest).not.toBeNull();
		expect(worldEdges(life)).toHaveLength(0);
		// Held: not offered again, and prepare refuses it, until an entity appears.
		expect(pending(rig)).toEqual([]);
		const again = await life.store.write((db) =>
			rig.curation.prepareCurationInTransaction(db, {
				scope: SCOPE,
				eventIds: mirrorRows(life).map((r) => r.event_id),
			}),
		);
		expect(again).toMatchObject({
			status: "not_ready",
			reason: "extraction_context_held",
		});
		await life.world.apply({
			...(await import("./fixture")).request("e-2", {
				kind: "entity.register",
				entity: {
					id: "other-1",
					displayName: "未登録の何か",
					aliases: [],
					externalRefs: [],
				},
			}),
		});
		expect(pending(rig)).toHaveLength(2);
		// The steward gives up on the head: it ends for good and the next event goes on.
		const ids = pending(rig).map((e) => e.eventId);
		const gone = await life.store.write((db) =>
			rig.curation.giveUpEventsInTransaction(db, SCOPE, [ids[0]!]),
		);
		expect(gone).toEqual([ids[0]!]);
		expect(mirrorRows(life).map((r) => [r.state, r.reason])).toEqual([
			["rejected", "STEWARD_GAVE_UP"],
			["received", "EXTRACTION_CONTEXT_HELD"],
		]);
		expect(inboxRows(life).map((r) => r.status)).toEqual([
			"rejected",
			"received",
		]);
		const rest = await curate(rig, () => ({
			entities: [],
			claims: [claimOf()],
		}));
		expect(settled(rest).elements[0]).toMatchObject({ status: "applied" });
		expect(mirrorRows(life).map((r) => r.state)).toEqual([
			"rejected",
			"applied",
		]);
		// Final: giving up again changes nothing.
		expect(
			await life.store.write((db) =>
				rig.curation.giveUpEventsInTransaction(db, SCOPE, ids),
			),
		).toEqual([]);
	} finally {
		await life.cleanup();
	}
});

test("a name that matches two entities is ambiguous: the window is held", async () => {
	const { life, rig } = await started();
	try {
		await withService(life);
		const { request } = await import("./fixture");
		await life.world.apply(
			request("e-2", {
				kind: "entity.register",
				entity: {
					id: "svc-2",
					displayName: "音声サービス",
					aliases: [],
					externalRefs: [],
				},
			}),
		);
		await addMessage(life, "m1", TEXT);
		await received(life);
		const run = await curate(rig, () => ({
			entities: [],
			claims: [claimOf({ subject: "音声サービス" })],
		}));
		expect(run.settle).toMatchObject({
			status: "held",
			reasonCodes: ["AMBIGUOUS_SUBJECT"],
		});
	} finally {
		await life.cleanup();
	}
});

test("events routed out are settled with no candidates and no model", async () => {
	const { life, rig } = await started();
	try {
		await addMessage(life, "m1", "こんにちは。");
		await addMessage(life, "m2", "今日は晴れですね。");
		await received(life);
		const ids = pending(rig).map((e) => e.eventId);
		const done = await life.store.write((db) =>
			rig.curation.settleEmptyInTransaction(db, SCOPE, ids),
		);
		expect(done).toEqual(ids);
		expect(mirrorRows(life).map((r) => [r.state, r.reason])).toEqual([
			["applied", "ROUTED_EMPTY"],
			["applied", "ROUTED_EMPTY"],
		]);
		expect(inboxRows(life).map((r) => r.status)).toEqual([
			"applied",
			"applied",
		]);
		expect(checkpointRows(life)[0]!.applied_cursor).toBe(
			mirrorRows(life)[1]!.received_cursor,
		);
		expect(rig.shown).toHaveLength(0);
		expect(pending(rig)).toEqual([]);
		expect(
			await life.store.write((db) =>
				rig.curation.settleEmptyInTransaction(db, SCOPE, ids),
			),
		).toEqual([]);
	} finally {
		await life.cleanup();
	}
});
