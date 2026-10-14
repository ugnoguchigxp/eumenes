import { expect, test } from "bun:test";
import type { CurationOutput, PreparedCuration } from "..";
import {
	ACCESS,
	NOW,
	SCOPE,
	addMessage,
	entityOp,
	request,
	worldEdges,
} from "./fixture";
import {
	assertionRows,
	checkpointRows,
	claimOf,
	curate,
	curationFor,
	drain,
	inboxRows,
	mirrorRows,
	nothing,
	pending,
	testPorts,
	type Rig,
} from "./curation-fixture";
import { openLife, type Life } from "./lifecycle-fixture";

// The World half of the steward's curate-world step: prepare, settle, held windows,
// routed-out events, the pending list and the forget operations. Real store, real World
// package, real conversation adapter; the "model" is a function of what it is shown.

const TEXT = "音声サービスは9月から利用できる。";

async function started(ports = testPorts()) {
	const life = await openLife({ intake: ports.intake });
	expect((await life.lifecycle.recoverWorld()).status).toBe("open");
	const rig = curationFor(life, ports);
	return { life, rig, ports };
}

async function received(life: Life) {
	return life.lifecycle.consumeSourceChanges(SCOPE);
}

/** The heads World holds now: claim id -> lifecycle, origin and payload. */
async function heads(life: Life) {
	const read = await life.world.read({
		access: ACCESS,
		scope: SCOPE,
		asOf: NOW,
	});
	if (read.status !== "ready") throw new Error(JSON.stringify(read));
	return new Map(
		read.snapshot.assertions.map((a) => [
			a.id,
			{ lifecycle: a.lifecycle, origin: a.origin, revision: a.revision, a },
		]),
	);
}

const one = <T>(items: readonly T[]): T => {
	expect(items).toHaveLength(1);
	return items[0]!;
};

function ready(run: Awaited<ReturnType<typeof curate>>): PreparedCuration {
	if (run.prepare.status !== "ready")
		throw new Error(`prepare: ${run.prepare.status} ${run.prepare.reason}`);
	return run.prepare.prepared;
}
function settled(run: Awaited<ReturnType<typeof curate>>) {
	if (run.settle?.status !== "settled")
		throw new Error(`settle: ${JSON.stringify(run.settle)}`);
	return run.settle;
}

const withService = async (life: Life) => {
	expect((await life.world.apply(entityOp())).status).toBe("applied");
};

test("prepare shows the model the utterances, the candidate entities and the live claims, and registers Memory dependents before it answers", async () => {
	const { life, rig } = await started();
	try {
		await withService(life);
		await addMessage(life, "m1", TEXT);
		await received(life);
		expect(worldEdges(life)).toHaveLength(0);
		const prepare = await life.store.write((db) =>
			rig.curation.prepareCurationInTransaction(db, {
				scope: SCOPE,
				eventIds: pending(rig).map((e) => e.eventId),
			}),
		);
		if (prepare.status !== "ready") throw new Error(prepare.status);
		const { model, host } = prepare.prepared;
		expect(model.utterances).toEqual([
			{ label: "e1", speaker: "user", text: TEXT },
		]);
		expect(model.entities).toEqual([
			{ ref: "w1", name: "音声サービス", aliases: ["音声"] },
		]);
		expect(model.claims).toEqual([]);
		// Memory knew what the model would see before this returned.
		expect(worldEdges(life).length).toBeGreaterThan(0);
		expect(host.dependentIds.length).toBeGreaterThan(0);
		expect(mirrorRows(life)[0]!.manifest_id).toBe(host.events[0]!.manifestId);
		// Nothing the model reads is a host id.
		const shown = JSON.stringify(model);
		expect(shown).not.toContain("svc-1");
		expect(shown).not.toContain(host.events[0]!.eventId);
		expect(shown).not.toContain("m1");
	} finally {
		await life.cleanup();
	}
});

test("a person's statement becomes an adopted claim with host-assigned ids, evidence and a manifest", async () => {
	const { life, rig } = await started();
	try {
		await withService(life);
		await addMessage(life, "m1", TEXT);
		await received(life);
		const run = await curate(rig, () => ({
			entities: [],
			claims: [
				claimOf({
					validFrom: "2026-09",
					validUntil: null,
					predicate: "available",
				}),
			],
		}));
		const result = settled(run);
		expect(result.touched.messageIds).toEqual(["m1"]);
		const element = one(result.elements);
		expect(element).toMatchObject({
			kind: "claim",
			index: 0,
			status: "applied",
			outcome: "adopted",
			messageId: "m1",
		});
		const claimId = element.claimId!;
		expect(result.touched.claimIds).toEqual([claimId]);
		expect(claimId).toMatch(/^ax-/);
		const head = (await heads(life)).get(claimId)!;
		expect(head).toMatchObject({ lifecycle: "active", origin: "user_report" });
		expect(head.a.evidence[0]).toMatchObject({
			kind: "user_statement",
			stance: "supports",
		});
		expect(head.a.validTime).toMatchObject({
			kind: "period",
			precision: "month",
			original: "2026-09..",
		});
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "applied",
			manifest_id: null,
		});
		expect(inboxRows(life).map((r) => r.status)).toEqual(["applied"]);
		expect(checkpointRows(life)[0]!.applied_cursor).toBe(
			mirrorRows(life)[0]!.received_cursor,
		);
		expect(pending(rig)).toEqual([]);
	} finally {
		await life.cleanup();
	}
});

test("an adopted assistant answer is input; what it says is a hypothesis, never a report of the person", async () => {
	const ports = testPorts();
	const { life, rig } = await started(ports);
	try {
		await withService(life);
		await addMessage(life, "m1", "音声サービスを速くしたい。");
		await addMessage(
			life,
			"a1",
			"cacheを入れると音声サービスは速くなるかもしれません。",
			"assistant",
		);
		ports.adopted.add("a1");
		const report = await received(life);
		expect(report.received).toBe(2);
		expect(mirrorRows(life).map((r) => [r.speaker, r.conversation_id])).toEqual(
			[
				["user", "c1"],
				["assistant", "c1"],
			],
		);
		expect(pending(rig).map((e) => e.speaker)).toEqual(["user", "assistant"]);
		const run = await curate(rig, () => ({
			entities: [],
			claims: [
				// the answer's words as the person's report: refused
				claimOf({
					evidence: "e2",
					origin: "user_report",
					predicate: "faster_with_cache",
				}),
				// the person's words as a hypothesis: refused
				claimOf({
					evidence: "e1",
					origin: "model_hypothesis",
					predicate: "wanted",
				}),
				claimOf({
					evidence: "e2",
					origin: "model_hypothesis",
					predicate: "faster_with_cache",
				}),
			],
		}));
		const result = settled(run);
		expect(
			result.elements.map((e) => [e.index, e.status, e.reasonCodes]),
		).toEqual([
			[0, "dropped", ["origin_mismatch"]],
			[1, "dropped", ["origin_mismatch"]],
			[2, "applied", []],
		]);
		expect(result.elements[2]).toMatchObject({
			outcome: "adopted_hypothesis",
			messageId: "a1",
		});
		const head = (await heads(life)).get(result.elements[2]!.claimId!)!;
		expect(head).toMatchObject({
			lifecycle: "active",
			origin: "model_hypothesis",
		});
		expect(
			[...(await heads(life)).values()].filter(
				(h) => h.origin === "user_report",
			),
		).toHaveLength(0);
		expect(
			JSON.stringify(
				run.prepare.status === "ready" ? run.prepare.prepared.model : {},
			),
		).toContain('"speaker":"assistant"');
	} finally {
		await life.cleanup();
	}
});

test("an assistant message that no run adopted, or a blocked message, is never input", async () => {
	const ports = testPorts();
	const { life, rig } = await started(ports);
	try {
		await addMessage(life, "a1", "未採用の回答です。", "assistant");
		await addMessage(life, "a2", "採用された回答です。", "assistant");
		await addMessage(life, "m1", "ブロックされた発言です。");
		await addMessage(life, "m2", "普通の発言です。");
		ports.adopted.add("a2");
		ports.blocked.add("m1");
		const report = await received(life);
		expect(report).toMatchObject({ received: 2, skippedInputs: 1 });
		expect(mirrorRows(life).map((r) => [r.state, r.reason])).toEqual([
			["received", null],
			["skipped", "SOURCE_BLOCKED"],
			["received", null],
		]);
		expect(pending(rig).map((e) => e.messageId)).toEqual(["a2", "m2"]);
	} finally {
		await life.cleanup();
	}
});

test("a message blocked or un-adopted after receipt is final: it never reaches the model", async () => {
	const ports = testPorts();
	const { life, rig } = await started(ports);
	try {
		await addMessage(life, "a1", "採用された回答です。", "assistant");
		await addMessage(life, "m1", "後からブロックされる発言です。");
		await addMessage(life, "m2", "普通の発言です。");
		ports.adopted.add("a1");
		await received(life);
		ports.blocked.add("m1");
		ports.adopted.delete("a1");
		const run = await curate(rig, nothing);
		const prepared = ready(run);
		if (run.prepare.status !== "ready") throw new Error("unreachable");
		expect(run.prepare.finalized.map((f) => [f.messageId, f.reason])).toEqual([
			["a1", "NOT_ADOPTED"],
			["m1", "SOURCE_BLOCKED"],
		]);
		expect(prepared.model.utterances.map((u) => u.text)).toEqual([
			"普通の発言です。",
		]);
		expect(JSON.stringify(rig.shown)).not.toContain("ブロック");
		expect(mirrorRows(life).map((r) => [r.state, r.reason])).toEqual([
			["rejected", "NOT_ADOPTED"],
			["rejected", "SOURCE_BLOCKED"],
			["applied", null],
		]);
	} finally {
		await life.cleanup();
	}
});

test("a correction supersedes the old value and is adopted; a denial retracts the claim", async () => {
	const { life, rig } = await started();
	try {
		await withService(life);
		await addMessage(life, "m1", TEXT);
		await received(life);
		const first = settled(
			await curate(rig, () => ({
				entities: [],
				claims: [
					claimOf({ predicate: "available" }),
					claimOf({
						predicate: "region",
						value: { type: "string", value: "東京" },
					}),
				],
			})),
		);
		await addMessage(life, "m2", "いや、音声サービスは使えない。");
		await received(life);
		const second = await curate(rig, (model) => {
			expect(model.claims.map((c) => [c.ref, c.predicate, c.status])).toEqual(
				expect.arrayContaining([
					["c1", expect.any(String), "adopted"],
					["c2", expect.any(String), "adopted"],
				]),
			);
			const target = model.claims.find((c) => c.predicate === "available")!;
			return {
				entities: [],
				claims: [
					claimOf({
						op: "correct",
						ref: target.ref,
						value: { type: "boolean", value: false },
					}),
				],
			};
		});
		const corrected = settled(second);
		expect(corrected.elements[0]).toMatchObject({ outcome: "corrected" });
		expect(corrected.touched.claimIds).toHaveLength(1);
		let state = await heads(life);
		const id = corrected.touched.claimIds[0]!;
		expect(first.touched.claimIds).toContain(id);
		expect(state.get(id)!.a.predicate).toBe("available");
		expect(state.get(id)).toMatchObject({ lifecycle: "active", revision: 4 });
		expect(state.get(id)!.a.payload).toMatchObject({
			kind: "value",
			value: { kind: "boolean", value: false },
		});
		const revisions = assertionRows(life).filter((r) => r.id === id);
		expect(revisions.map((r) => [r.revision, r.lifecycle])).toEqual([
			[1, "candidate"],
			[2, "superseded"],
			[3, "candidate"],
			[4, "active"],
		]);
		await addMessage(
			life,
			"m3",
			"音声サービスの地域は東京ではない、それは違う。",
		);
		await received(life);
		const third = settled(
			await curate(rig, (model) => ({
				entities: [],
				claims: [
					claimOf({
						op: "retract",
						ref: model.claims.find((c) => c.predicate === "region")!.ref,
						subject: null,
						predicate: null,
						value: null,
					}),
				],
			})),
		);
		expect(third.elements[0]).toMatchObject({ outcome: "retracted" });
		const retracted = assertionRows(life).filter(
			(r) => r.id === third.touched.claimIds[0],
		);
		expect(retracted.at(-1)).toMatchObject({ lifecycle: "retracted" });
		state = await heads(life);
		expect(state.has(third.touched.claimIds[0]!)).toBe(false);
	} finally {
		await life.cleanup();
	}
});

test("only the person's own words may correct a claim, and a stale target is dropped", async () => {
	const ports = testPorts();
	const { life, rig } = await started(ports);
	try {
		await withService(life);
		await addMessage(life, "m1", TEXT);
		await received(life);
		await curate(rig, () => ({ entities: [], claims: [claimOf()] }));
		await addMessage(life, "a1", "実は使えないと思います。", "assistant");
		ports.adopted.add("a1");
		await received(life);
		const run = await curate(rig, () => ({
			entities: [],
			claims: [
				claimOf({
					op: "correct",
					ref: "c1",
					evidence: "e1",
					origin: "model_hypothesis",
					value: { type: "boolean", value: false },
				}),
				claimOf({
					op: "retract",
					ref: "c9",
					evidence: "e1",
					origin: "model_hypothesis",
				}),
			],
		}));
		expect(settled(run).elements.map((e) => [e.status, e.reasonCodes])).toEqual(
			[
				["dropped", ["correct_requires_user_report"]],
				["dropped", ["unknown_ref"]],
			],
		);
		// The claim moves between prepare and settle: the element is a conflict, nothing else is undone.
		await addMessage(life, "m2", "音声サービスはやはり使える。");
		await received(life);
		const prepare = await life.store.write((db) =>
			rig.curation.prepareCurationInTransaction(db, {
				scope: SCOPE,
				eventIds: pending(rig).map((e) => e.eventId),
			}),
		);
		if (prepare.status !== "ready") throw new Error(prepare.status);
		const target = prepare.prepared.host.claims[0]!;
		// A rival change commits first.
		await life.store.write((db) =>
			rig.curation.settleCurationInTransaction(db, {
				prepared: prepare.prepared,
				output: {
					entities: [],
					claims: [
						claimOf({
							op: "correct",
							ref: target.ref,
							value: { type: "boolean", value: true },
							evidence: prepare.prepared.model.utterances.find(
								(u) => u.speaker === "user",
							)!.label,
						}),
					],
				},
			}),
		);
		expect(pending(rig)).toEqual([]);
	} finally {
		await life.cleanup();
	}
});

test("an answer may never retract or correct a claim, only the person's own words may retract", async () => {
	const ports = testPorts();
	const { life, rig } = await started(ports);
	try {
		await withService(life);
		await addMessage(life, "m1", TEXT);
		await received(life);
		const first = settled(
			await curate(rig, () => ({ entities: [], claims: [claimOf()] })),
		);
		const claimId = first.touched.claimIds[0]!;
		await addMessage(life, "a1", "それは違うと思います。", "assistant");
		ports.adopted.add("a1");
		await received(life);
		const answered = await curate(rig, (model) => ({
			entities: [],
			claims: [
				claimOf({
					op: "retract",
					ref: model.claims[0]!.ref,
					subject: null,
					predicate: null,
					value: null,
					evidence: "e1",
					origin: "model_hypothesis",
				}),
			],
		}));
		expect(
			settled(answered).elements.map((e) => [e.status, e.reasonCodes]),
		).toEqual([["dropped", ["retract_requires_user_report"]]]);
		expect((await heads(life)).get(claimId)).toMatchObject({
			lifecycle: "active",
		});
		// The person's own denial does retract it.
		await addMessage(life, "m2", "いや、音声サービスについてそれは違う。");
		await received(life);
		const denied = settled(
			await curate(rig, (model) => ({
				entities: [],
				claims: [
					claimOf({
						op: "retract",
						ref: model.claims[0]!.ref,
						subject: null,
						predicate: null,
						value: null,
					}),
				],
			})),
		);
		expect(denied.elements[0]).toMatchObject({ outcome: "retracted" });
		expect((await heads(life)).has(claimId)).toBe(false);
	} finally {
		await life.cleanup();
	}
});

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

test("the feed tells the steward which conversations got events, after the receipt committed", async () => {
	const ports = testPorts();
	const { life } = await started(ports);
	try {
		await addMessage(life, "m1", TEXT);
		await received(life);
		expect(ports.received).toEqual([["c1"]]);
		// Nothing new: nobody is told.
		await received(life);
		// A message that is not input: nobody is told.
		await addMessage(life, "a1", "承知しました。", "assistant");
		await received(life);
		expect(ports.received).toEqual([["c1"]]);
		ports.adopted.add("a2");
		await addMessage(life, "a2", "採用された回答です。", "assistant");
		await received(life);
		expect(ports.received).toEqual([["c1"], ["c1"]]);
		// A callback that throws never undoes the receipt.
		const failing = testPorts();
		failing.intake.onEventsReceived = () => {
			throw new Error("kick_failed");
		};
		const next = await openLife({ intake: failing.intake });
		try {
			await next.lifecycle.recoverWorld();
			await addMessage(next, "m1", TEXT);
			expect(await received(next)).toMatchObject({
				received: 1,
				blocked: null,
			});
			expect(mirrorRows(next)).toHaveLength(1);
		} finally {
			await next.cleanup();
		}
	} finally {
		await life.cleanup();
	}
});

test("a pending listing carries message, version, speaker and conversation, oldest first and bounded", async () => {
	const { life, rig } = await started();
	try {
		await addMessage(life, "m1", "一つ目。");
		await addMessage(life, "m2", "二つ目。");
		await addMessage(life, "m3", "三つ目。");
		await received(life);
		const all = pending(rig);
		expect(all.map((e) => [e.messageId, e.speaker, e.conversationId])).toEqual([
			["m1", "user", "c1"],
			["m2", "user", "c1"],
			["m3", "user", "c1"],
		]);
		expect(all[0]!.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(all[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(pending(rig, 2)).toHaveLength(2);
		expect(pending(rig, 0)).toEqual([]);
	} finally {
		await life.cleanup();
	}
});

test("a conversation's pending events are read in the query: a busy neighbour does not crowd them out, an event without a conversation never blocks", async () => {
	const { life, rig } = await started();
	try {
		for (let i = 0; i < 205; i++) await addMessage(life, `a${i}`, `話${i}。`);
		await life.conversation.append({
			id: "b1",
			conversationId: "c2",
			role: "user",
			text: "別の会話。",
			createdAt: "2026-10-09T00:00:00.000Z",
			runId: null,
		});
		await received(life);
		// 205 events of c1 come first, yet c2's only event is found.
		expect(pending(rig, 12, "c2").map((e) => e.messageId)).toEqual(["b1"]);
		expect(pending(rig, 300, "c1")).toHaveLength(200);
		// Events received before the steward existed carry no conversation: never listed, never in the way.
		await life.store.write((db) =>
			db
				.query(
					"UPDATE world_host_extract_event SET conversation_id = NULL WHERE seq <= 205",
				)
				.run(),
		);
		expect(pending(rig, 12, "c1")).toEqual([]);
		expect(pending(rig, 12).map((e) => e.messageId)).toEqual(["b1"]);
	} finally {
		await life.cleanup();
	}
});

test("a held window is offered again when entities change, also past the first page of 500", async () => {
	const { life, rig } = await started();
	try {
		for (let i = 0; i < 500; i++)
			expect(
				(
					await life.world.apply(
						request(`fill-${i}`, {
							kind: "entity.register",
							entity: {
								id: `a-${String(i).padStart(3, "0")}`,
								displayName: `埋め草${i}`,
								aliases: [],
								externalRefs: [],
							},
						}),
					)
				).status,
			).toBe("applied");
		await withService(life);
		await addMessage(life, "m1", "未登録の何かが9月から使える。");
		await received(life);
		const held = await curate(rig, () => ({
			entities: [],
			claims: [claimOf({ subject: "未登録の何か" })],
		}));
		expect(held.settle).toMatchObject({ status: "held" });
		expect(pending(rig)).toEqual([]);
		// "other-1" sorts after the 500 listed ones: only the digest's tail can see it.
		await life.world.apply(
			request("late", {
				kind: "entity.register",
				entity: {
					id: "other-1",
					displayName: "未登録の何か",
					aliases: [],
					externalRefs: [],
				},
			}),
		);
		expect(pending(rig)).toHaveLength(1);
	} finally {
		await life.cleanup();
	}
});

test("drain of a whole conversation settles every event once", async () => {
	const { life, rig } = await started();
	try {
		await withService(life);
		for (let i = 1; i <= 3; i++)
			await addMessage(life, `m${i}`, `音声サービスの話${i}。`);
		await received(life);
		const runs = await drain(rig, nothing);
		expect(runs).toHaveLength(1);
		expect(mirrorRows(life).map((r) => r.state)).toEqual([
			"applied",
			"applied",
			"applied",
		]);
		const output: CurationOutput = { entities: [], claims: [] };
		expect(output.claims).toEqual([]);
	} finally {
		await life.cleanup();
	}
});

// --- forget operations -------------------------------------------------------

/** Two claims of one entity, each from its own window (so each stands on its own message). */
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
