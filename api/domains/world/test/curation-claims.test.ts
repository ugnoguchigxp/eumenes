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
	testPorts,
	TEXT,
	started,
	received,
	heads,
	one,
	ready,
	settled,
	withService,
} from "./curation-fixture";

// World curation: prepare, adopted claims, assistant answers and corrections. See curation-fixture.ts for the shared rig.

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
