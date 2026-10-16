import { expect, test } from "bun:test";
import type { PreparedCuration } from "..";
import { SCOPE, addMessage, entityOp, worldEdges } from "./fixture";
import {
	assertionRows,
	claimOf,
	curate,
	mirrorRows,
	nothing,
	pending,
	TEXT,
	started,
	received,
	settled,
	withService,
} from "./curation-fixture";

// World curation: stale settles, bad answers and released prepares. See curation-fixture.ts for the shared rig.

test("a result is not adopted when the world moved since prepare, and its Memory dependents are given back", async () => {
	const { life, rig } = await started();
	try {
		await withService(life);
		await addMessage(life, "m1", TEXT);
		await received(life);
		const prepareNow = () =>
			life.store.write((db) =>
				rig.curation.prepareCurationInTransaction(db, {
					scope: SCOPE,
					eventIds: pending(rig).map((e) => e.eventId),
				}),
			);
		const settleWith = (
			prepared: PreparedCuration,
			output: unknown = { entities: [], claims: [claimOf()] },
		) =>
			life.store.write((db) =>
				rig.curation.settleCurationInTransaction(db, { prepared, output }),
			);

		// 1. the message was corrected
		let prepare = await prepareNow();
		if (prepare.status !== "ready") throw new Error(prepare.status);
		expect(worldEdges(life).length).toBeGreaterThan(0);
		await life.conversation.correct({
			messageId: "m1",
			text: "音声サービスは10月から。",
		});
		expect(await settleWith(prepare.prepared)).toEqual({
			status: "stale",
			reason: "input_version_changed",
		});
		expect(assertionRows(life)).toHaveLength(0);
		expect(worldEdges(life)).toHaveLength(0);
		expect(mirrorRows(life)[0]!.manifest_id).toBeNull();
		await received(life);

		// 2. a forget happened (the World forget epoch moved)
		prepare = await prepareNow();
		if (prepare.status !== "ready") throw new Error(prepare.status);
		await addMessage(life, "other", "関係のない発言です。");
		await life.store.write((db) =>
			rig.curation.acceptSourceForgetInTransaction(db, {
				scope: SCOPE,
				messageIds: ["other"],
				reasonCode: "SOURCE_BLOCKED",
				origin: "steward",
			}),
		);
		expect(await settleWith(prepare.prepared)).toEqual({
			status: "stale",
			reason: "forget_epoch_changed",
		});

		// 3. an entity it was shown changed (here: another registration does not matter, a forgotten one does)
		// 4. the message became blocked
		prepare = await prepareNow();
		if (prepare.status !== "ready") throw new Error(prepare.status);
		rig.ports.blocked.add("m1");
		expect(await settleWith(prepare.prepared)).toEqual({
			status: "stale",
			reason: "source_blocked",
		});
		expect(assertionRows(life)).toHaveLength(0);
		expect(mirrorRows(life).find((r) => r.state === "received")).toBeDefined();
	} finally {
		await life.cleanup();
	}
});

test("an answer without the expected shape writes nothing and leaves the events pending", async () => {
	const { life, rig } = await started();
	try {
		await addMessage(life, "m1", TEXT);
		await received(life);
		for (const output of ["garbage", null, { claims: "no" }, 42]) {
			const run = await curate(rig, () => output);
			expect(run.settle).toEqual({
				status: "invalid_output",
				reason: "OUTPUT_SHAPE",
			});
			expect(mirrorRows(life)[0]).toMatchObject({
				state: "received",
				manifest_id: null,
			});
			expect(worldEdges(life)).toHaveLength(0);
		}
		// Elements that are broken are dropped one by one, the rest goes through.
		await life.world.apply(entityOp());
		const run = await curate(rig, () => ({
			entities: [{ name: "" }, 5],
			claims: ["x", { op: "assert" }, claimOf({ evidence: "e9" }), claimOf()],
		}));
		expect(
			settled(run).elements.map((e) => [
				e.kind,
				e.index,
				e.status,
				e.reasonCodes,
			]),
		).toEqual([
			["entity", 0, "dropped", ["invalid_element"]],
			["entity", 1, "dropped", ["invalid_element"]],
			["claim", 0, "dropped", ["invalid_element"]],
			["claim", 1, "dropped", ["invalid_element"]],
			["claim", 2, "dropped", ["unknown_evidence"]],
			["claim", 3, "applied", []],
		]);
	} finally {
		await life.cleanup();
	}
});

test("a prepare that is never settled can be released; release is idempotent", async () => {
	const { life, rig } = await started();
	try {
		await addMessage(life, "m1", TEXT);
		await received(life);
		const prepare = await life.store.write((db) =>
			rig.curation.prepareCurationInTransaction(db, {
				scope: SCOPE,
				eventIds: pending(rig).map((e) => e.eventId),
			}),
		);
		if (prepare.status !== "ready") throw new Error(prepare.status);
		expect(worldEdges(life).length).toBeGreaterThan(0);
		for (let i = 0; i < 2; i++) {
			await life.store.write((db) =>
				rig.curation.releaseCurationInTransaction(
					db,
					SCOPE,
					prepare.prepared.eventIds,
				),
			);
			expect(worldEdges(life)).toHaveLength(0);
			expect(mirrorRows(life)[0]).toMatchObject({
				state: "received",
				manifest_id: null,
			});
		}
		// The same window can be prepared and settled afterwards.
		settled(await curate(rig, nothing));
	} finally {
		await life.cleanup();
	}
});
