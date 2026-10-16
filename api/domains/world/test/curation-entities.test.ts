import { expect, test } from "bun:test";
import type { PreparedCuration } from "..";
import { addMessage, request } from "./fixture";
import {
	assertionRows,
	claimOf,
	curate,
	nothing,
	testPorts,
	TEXT,
	started,
	received,
	heads,
	ready,
	settled,
	withService,
} from "./curation-fixture";
import { type Life } from "./lifecycle-fixture";

// World curation: entities, relations and claim hygiene. See curation-fixture.ts for the shared rig.

test("an output may register new entities and claim about them; a plain name is resolved among the shown entities", async () => {
	const { life, rig } = await started();
	try {
		await withService(life);
		await addMessage(life, "m1", "LARMの接続先は音声サービスに依存している。");
		await received(life);
		const run = await curate(rig, (model) => {
			expect(model.entities.map((e) => e.name)).toEqual(["音声サービス"]);
			return {
				entities: [{ name: "LARM", aliases: ["ラーム"] }],
				claims: [
					claimOf({
						subject: "new:0",
						predicate: "depends",
						value: null,
						relation: { kind: "depends_on", object: "音声サービス" },
					}),
					claimOf({ subject: "new:3", predicate: "ghost" }),
				],
			};
		});
		const result = settled(run);
		expect(
			result.elements.map((e) => [e.kind, e.index, e.status, e.reasonCodes]),
		).toEqual([
			["entity", 0, "applied", []],
			["claim", 0, "applied", []],
			["claim", 1, "dropped", ["unknown_ref"]],
		]);
		const entityId = result.touched.entityIds[0]!;
		expect(entityId).toMatch(/^we-/);
		const head = (await heads(life)).get(result.touched.claimIds[0]!)!;
		expect(head.a.subjectId).toBe(entityId);
		expect(head.a.payload).toMatchObject({
			kind: "relation",
			relation: "depends_on",
			objectId: "svc-1",
		});
		// The next window shows the new entity and the claim about it.
		await addMessage(life, "m2", "LARMはどこで動いている？");
		await received(life);
		const next = ready(await curate(rig, nothing));
		expect(next.model.entities.map((e) => e.name)).toEqual(
			expect.arrayContaining(["LARM", "音声サービス"]),
		);
		expect(next.model.claims).toHaveLength(1);
		expect(next.model.claims[0]).toMatchObject({
			predicate: "depends",
			relation: { kind: "depends_on" },
			status: "adopted",
			origin: "user_report",
		});
	} finally {
		await life.cleanup();
	}
});

const registerEntity = async (life: Life, id: string, displayName: string) =>
	expect(
		(
			await life.world.apply(
				request(`e-${id}`, {
					kind: "entity.register",
					entity: { id, displayName, aliases: [], externalRefs: [] },
				}),
			)
		).status,
	).toBe("applied");

test("a claim about entities its utterance does not name is dropped: shown candidates are not evidence (live 2026-10-15)", async () => {
	const { life, rig } = await started();
	try {
		await registerEntity(life, "ent-eumenes", "Eumenes");
		await registerEntity(life, "ent-steward", "steward");
		await addMessage(life, "m1", "Eumenes steward の件です。");
		await addMessage(
			life,
			"m2",
			"LARM の接続先は音声サービスに依存しています。",
		);
		await received(life);
		const run = await curate(rig, (model) => {
			const ref = (name: string) =>
				model.entities.find((e) => e.name === name)!.ref;
			return {
				entities: [],
				claims: [
					claimOf({
						subject: ref("Eumenes"),
						predicate: "depends_on",
						value: null,
						relation: { kind: "depends_on", object: ref("steward") },
						evidence: "e2",
					}),
				],
			};
		});
		const result = settled(run);
		expect(result.elements.map((e) => [e.status, e.reasonCodes])).toEqual([
			["dropped", ["not_in_evidence"]],
		]);
		expect(result.touched.claimIds).toEqual([]);
		expect(result.changed).toBe(false);
	} finally {
		await life.cleanup();
	}
});

test("a question does not report what only the answer said, and a name nobody said, or no written claim uses, is not registered (live 2026-10-15)", async () => {
	const ports = testPorts();
	const { life, rig } = await started(ports);
	try {
		await addMessage(life, "m1", "LARM の接続先を変えると、何に影響しそう？");
		await addMessage(
			life,
			"a1",
			"LARM の接続先は音声サービスに依存しています。",
			"assistant",
		);
		ports.adopted.add("a1");
		await received(life);
		const run = await curate(rig, () => ({
			entities: [
				{ name: "LARM", aliases: [] },
				{ name: "音声サービス", aliases: [] },
				{ name: "推論サーバー", aliases: [] },
			],
			claims: [
				claimOf({
					subject: "new:0",
					predicate: "depends_on",
					value: null,
					relation: { kind: "depends_on", object: "new:1" },
					evidence: "e1",
				}),
			],
		}));
		const result = settled(run);
		expect(
			result.elements.map((e) => [e.kind, e.index, e.status, e.reasonCodes]),
		).toEqual([
			["entity", 0, "dropped", ["unused_entity"]],
			["entity", 1, "dropped", ["unused_entity"]],
			["entity", 2, "dropped", ["not_in_evidence"]],
			["claim", 0, "dropped", ["not_in_evidence"]],
		]);
		expect(result.touched.claimIds).toEqual([]);
	} finally {
		await life.cleanup();
	}
});

test("the person correcting a relation retracts the old one and states the new in the same settle; an answer cannot (live 2026-10-15)", async () => {
	const ports = testPorts();
	const { life, rig } = await started(ports);
	try {
		await withService(life);
		await addMessage(life, "m1", "LARMの接続先は音声サービスに依存している。");
		await received(life);
		const first = settled(
			await curate(rig, () => ({
				entities: [{ name: "LARM", aliases: [] }],
				claims: [
					claimOf({
						subject: "new:0",
						predicate: null,
						value: null,
						relation: { kind: "depends_on", object: "音声サービス" },
					}),
				],
			})),
		);
		const oldId = first.touched.claimIds[0]!;
		const correction = (model: PreparedCuration["model"]) => ({
			entities: [{ name: "推論サーバー", aliases: [] }],
			claims: [
				claimOf({
					op: "correct",
					ref: model.claims.find((c) => c.relation !== null)!.ref,
					subject: model.entities.find((e) => e.name === "LARM")!.ref,
					predicate: null,
					value: null,
					relation: { kind: "depends_on", object: "new:0" },
				}),
			],
		});
		await addMessage(
			life,
			"m2",
			"いや、LARM の接続先は音声サービスではなく推論サーバーに依存しているんだった。",
		);
		await received(life);
		const second = settled(await curate(rig, correction));
		expect(
			second.elements.map((e) => [e.kind, e.index, e.status, e.outcome]),
		).toEqual([
			["entity", 0, "applied", "registered"],
			["claim", 0, "applied", "retracted"],
			["claim", 0, "applied", "adopted"],
		]);
		const state = await heads(life);
		expect(state.has(oldId)).toBe(false);
		const fresh = second.elements.find((e) => e.outcome === "adopted")!;
		expect(state.get(fresh.claimId!)).toMatchObject({
			lifecycle: "active",
			origin: "user_report",
		});
		expect(state.get(fresh.claimId!)!.a).toMatchObject({
			predicate: "depends_on",
			payload: {
				kind: "relation",
				relation: "depends_on",
				objectId: second.touched.entityIds[0],
			},
		});
		expect(
			assertionRows(life)
				.filter((r) => r.id === oldId)
				.at(-1),
		).toMatchObject({ lifecycle: "retracted" });
		// An answer may not do it: nothing is retracted or stated.
		await addMessage(
			life,
			"a1",
			"LARM の接続先は推論サーバーに依存していると思います。",
			"assistant",
		);
		ports.adopted.add("a1");
		await received(life);
		const answered = settled(
			await curate(rig, (model) => {
				const out = correction(model) as { claims: Record<string, unknown>[] };
				return {
					entities: [],
					claims: [
						{
							...out.claims[0]!,
							ref: model.claims.find((c) => c.relation !== null)!.ref,
							relation: { kind: "depends_on", object: "音声サービス" },
							origin: "model_hypothesis",
						},
					],
				};
			}),
		);
		expect(answered.elements.map((e) => [e.status, e.reasonCodes])).toEqual([
			["dropped", ["correct_requires_user_report"]],
		]);
	} finally {
		await life.cleanup();
	}
});

test("a relation claim without a predicate takes the relation kind as its predicate", async () => {
	const { life, rig } = await started();
	try {
		await withService(life);
		await addMessage(life, "m1", "LARMの接続先は音声サービスに依存している。");
		await received(life);
		// The live model wrote `predicate: null` for a relation (2026-10-15).
		const run = await curate(rig, () => ({
			entities: [{ name: "LARM", aliases: [] }],
			claims: [
				claimOf({
					subject: "new:0",
					predicate: null,
					value: null,
					relation: { kind: "depends_on", object: "音声サービス" },
				}),
			],
		}));
		const result = settled(run);
		expect(result.elements.map((e) => [e.kind, e.status])).toEqual([
			["entity", "applied"],
			["claim", "applied"],
		]);
		const head = (await heads(life)).get(result.touched.claimIds[0]!)!;
		expect(head.a.payload).toMatchObject({
			kind: "relation",
			relation: "depends_on",
		});
	} finally {
		await life.cleanup();
	}
});

test("a duplicate claim is dropped and an unusable valid time drops only its element", async () => {
	const { life, rig } = await started();
	try {
		await withService(life);
		await addMessage(life, "m1", TEXT);
		await received(life);
		await curate(rig, () => ({ entities: [], claims: [claimOf()] }));
		await addMessage(life, "m2", "音声サービスは利用できる。");
		await received(life);
		const run = await curate(rig, () => ({
			entities: [],
			claims: [
				claimOf(),
				claimOf({ predicate: "other", validFrom: "2026-02-31" }),
				claimOf({
					predicate: "plain",
					validFrom: "2026-09",
					validUntil: "2026-12-31",
				}),
			],
		}));
		const result = settled(run);
		expect(result.elements.map((e) => [e.status, e.reasonCodes])).toEqual([
			["dropped", ["duplicate_claim"]],
			["dropped", ["invalid_valid_time"]],
			["applied", []],
		]);
		const head = (await heads(life)).get(result.touched.claimIds[0]!)!;
		expect(head.a.validTime).toMatchObject({
			kind: "period",
			precision: "month",
			start: { earliest: Date.UTC(2026, 8, 1), latest: Date.UTC(2026, 9, 1) },
			end: {
				earliest: Date.UTC(2026, 11, 31),
				latest: Date.UTC(2027, 0, 1),
			},
		});
	} finally {
		await life.cleanup();
	}
});
