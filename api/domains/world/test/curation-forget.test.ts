import { expect, test } from "bun:test";
import { SCOPE, addMessage } from "./fixture";
import {
	claimOf,
	curate,
	TEXT,
	started,
	received,
	heads,
	settled,
	withService,
	type Rig,
} from "./curation-fixture";

// World curation: forget operations. See curation-fixture.ts for the shared rig.

async function forgetRig() {
	const { life, rig, ports } = await started();
	await withService(life);
	await addMessage(life, "m1", TEXT);
	await received(life);
	const first = settled(
		await curate(rig, () => ({
			entities: [],
			claims: [claimOf({ predicate: "available" })],
		})),
	);
	await addMessage(life, "m2", "音声サービスは東京で動いている。");
	await received(life);
	const second = settled(
		await curate(rig, () => ({
			entities: [],
			claims: [
				claimOf({
					predicate: "region",
					value: { type: "string", value: "東京" },
				}),
			],
		})),
	);
	return {
		life,
		rig,
		ports,
		available: first.touched.claimIds[0]!,
		region: second.touched.claimIds[0]!,
	};
}

test("evidenceMessagesOf names the messages standing behind claims and entities, every revision, before the forget", async () => {
	const { life, rig, available, region } = await forgetRig();
	try {
		const evidence = (claimIds: string[], entityIds: string[]) =>
			life.store.readSnapshot((db) =>
				rig.curation.evidenceMessagesOf(db, {
					scope: SCOPE,
					claimIds,
					entityIds,
				}),
			);
		expect(await evidence([available], [])).toEqual({
			status: "ok",
			messageIds: ["m1"],
			complete: true,
		});
		const both = await evidence([], ["svc-1"]);
		expect(both).toMatchObject({
			status: "ok",
			messageIds: ["m1", "m2"],
			complete: true,
		});
		// A corrected claim: the evidence of the older revision counts too.
		await addMessage(life, "m3", "いや、音声サービスの地域は大阪だ。");
		await received(life);
		settled(
			await curate(rig, (model) => ({
				entities: [],
				claims: [
					claimOf({
						op: "correct",
						ref: model.claims.find((c) => c.predicate === "region")!.ref,
						predicate: "region",
						value: { type: "string", value: "大阪" },
					}),
				],
			})),
		);
		const regionOnly = await life.store.readSnapshot((db) =>
			rig.curation.evidenceMessagesOf(db, {
				scope: SCOPE,
				claimIds: [region],
				entityIds: [],
			}),
		);
		expect(regionOnly).toMatchObject({ status: "ok" });
		const ids = (regionOnly as { messageIds: string[] }).messageIds;
		expect(ids).toEqual(expect.arrayContaining(["m2", "m3"]));
		expect(ids).not.toContain("m1");
	} finally {
		await life.cleanup();
	}
});

test("forgetting claims and entities is a durable intake the caller resumes; the epoch moves", async () => {
	const { life, rig, available: first } = await forgetRig();
	try {
		const epoch = life.store.read((db) =>
			rig.curation.forgetEpochInTransaction(db, SCOPE),
		);
		const accepted = await life.store.write((db) =>
			rig.curation.forgetClaimsInTransaction(db, {
				scope: SCOPE,
				claimIds: [first, "ghost"],
			}),
		);
		if (accepted.status !== "accepted") throw new Error(accepted.status);
		expect(accepted).toMatchObject({ claimIds: [first], missing: ["ghost"] });
		expect(
			life.store.read((db) => rig.curation.forgetEpochInTransaction(db, SCOPE)),
		).not.toBe(epoch);
		// Only the intake so far: nothing is gone before the caller resumes.
		expect(
			life.store.read((db) =>
				db
					.query(
						"SELECT origin, reason_code, state FROM world_host_forget_intake",
					)
					.all(),
			),
		).toEqual([
			{ origin: "steward", reason_code: "FORGET_REQUESTED", state: "pending" },
		]);
		expect((await heads(life)).has(first)).toBe(true);
		const report = await life.lifecycle.resumeForget(accepted.forgetId);
		expect(report.complete).toBe(true);
		expect((await heads(life)).has(first)).toBe(false);
		expect((await heads(life)).size).toBe(1);
		// The same request again is the same forget.
		const again = await life.store.write((db) =>
			rig.curation.forgetClaimsInTransaction(db, {
				scope: SCOPE,
				claimIds: [first],
			}),
		);
		expect(again).toEqual({ status: "nothing" });

		const entities = await life.store.write((db) =>
			rig.curation.forgetEntitiesInTransaction(db, {
				scope: SCOPE,
				entityIds: ["svc-1", "nobody"],
			}),
		);
		if (entities.status !== "accepted") throw new Error(entities.status);
		expect(entities).toMatchObject({
			entityIds: ["svc-1"],
			missing: ["nobody"],
		});
		expect(
			(await life.lifecycle.resumeForget(entities.forgetId)).complete,
		).toBe(true);
		expect((await heads(life)).size).toBe(0);
		expect(
			await life.store.write((db) =>
				rig.curation.forgetEntitiesInTransaction(db, {
					scope: SCOPE,
					entityIds: [],
				}),
			),
		).toEqual({ status: "nothing" });
	} finally {
		await life.cleanup();
	}
});

test("a blocked message leaves World as a forgotten source: its claims go, other messages' claims stay", async () => {
	const { life, rig, region } = await forgetRig();
	try {
		const accepted = await life.store.write((db) =>
			rig.curation.acceptSourceForgetInTransaction(db, {
				scope: SCOPE,
				messageIds: ["m1", "m1"],
				reasonCode: "SOURCE_BLOCKED",
				origin: "steward",
			}),
		);
		if (accepted.status !== "accepted") throw new Error(accepted.status);
		expect(
			life.store.read((db) =>
				db
					.query("SELECT origin, reason_code FROM world_host_forget_intake")
					.all(),
			),
		).toEqual([{ origin: "steward", reason_code: "SOURCE_FORGOTTEN" }]);
		expect(
			(await life.lifecycle.resumeForget(accepted.forgetId)).complete,
		).toBe(true);
		const left = await heads(life);
		expect([...left.keys()]).toEqual([region]);
		// The same blocked set is the same forget.
		const again = await life.store.write((db) =>
			rig.curation.acceptSourceForgetInTransaction(db, {
				scope: SCOPE,
				messageIds: ["m1"],
				reasonCode: "SOURCE_BLOCKED",
				origin: "steward",
			}),
		);
		expect(again).toEqual({ status: "accepted", forgetId: accepted.forgetId });
		expect(
			await life.store.write((db) =>
				rig.curation.acceptSourceForgetInTransaction(db, {
					scope: SCOPE,
					messageIds: [],
					reasonCode: "SOURCE_BLOCKED",
					origin: "steward",
				}),
			),
		).toEqual({ status: "nothing" });
	} finally {
		await life.cleanup();
	}
});

// Referenced so the types of the rig stay exercised by the compiler.
export type { Rig };
