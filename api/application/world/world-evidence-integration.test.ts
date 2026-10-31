import { expect, test } from "bun:test";
import { buildWorldSlice, toSliceReceipt } from "eumenes-world-model";
import type { ConditionSpec } from "eumenes-world-model";
import { createWorldQuery } from "../../domains/world";
import {
	ACCESS,
	NOW,
	PURPOSE,
	SCOPE,
	addMessage,
	claim,
	currentRef,
	entityOp,
	registerClaim,
	withHarness,
} from "../../domains/world/test/fixture";
import { sha256Hex } from "../../infrastructure/digest";
import { sourceOf } from "./world-research-readings";
import { boot, invoke, QUESTION } from "./world-research.fixture";

const condition: ConditionSpec = {
	kind: "expression",
	expression: {
		kind: "all",
		items: Array.from({ length: 8 }, (_, i) => ({
			kind: "compare" as const,
			key: `observation-${i}`,
			op: "eq" as const,
			value: { kind: "string" as const, value: `条件${i}の値` },
		})),
	},
};
const validTime = {
	kind: "period" as const,
	precision: "exact" as const,
	original: "UTC epoch ms 1791500000000 から 1791500001000 未満",
	start: { earliest: NOW, latest: NOW },
	end: { earliest: NOW + 1000, latest: NOW + 1000 },
};
const value = "長い資料の値\n".repeat(30) + "末尾の制約: 例外扱いにしない";

test("World readings retain the entire value, predicate, condition and valid time", () => {
	const predicate = "long_".repeat(20);
	const basis = {
		id: "claim",
		revision: 1,
		subjectId: "subject",
		predicate,
		value: { kind: "string", value },
		status: "candidate",
		freshness: "fresh",
		origin: "document_claim",
		causalEligible: false,
		condition,
		validTime,
		refutations: [],
		evidence: [],
		sources: [],
	};
	const reading = sourceOf(
		basis,
		"scope",
		"2026-10-31T00:00:00Z",
		() => "対象",
	)!;
	expect(reading.body).toContain(value);
	expect(reading.body).toContain(predicate);
	expect(reading.body).toContain('observation-7 = "条件7の値"');
	expect(reading.body).toContain(JSON.stringify(validTime));
	expect(reading.truncated).toBe(false);
	expect(reading.viewDigest).toBe(sha256Hex(reading.body));
	const changed = sourceOf(
		{ ...basis, value: { kind: "string", value: value + "追記" } },
		"scope",
		"2026-10-31T00:00:00Z",
		() => "対象",
	)!;
	expect(changed.viewDigest).not.toBe(reading.viewDigest);
});

test("host SQLite query retains source digest, representation and exact byte range", async () => {
	await withHarness(async (h) => {
		await addMessage(h, "original", value);
		const whole = currentRef(h, "original");
		const ref = {
			...whole,
			range: { startByte: 0, endByte: new TextEncoder().encode(value).length },
		};
		const assertion = claim("ranged", [ref], {
			condition,
			validTime,
			payload: { kind: "value", value: { kind: "string", value } },
		});
		assertion.evidence[0] = {
			...assertion.evidence[0]!,
			quoteDigest: sha256Hex(value),
		} as (typeof assertion.evidence)[number];
		expect(
			(await h.world.apply(registerClaim("ranged", assertion))).status,
		).toBe("applied");
		const result = await createWorldQuery({
			store: h.store,
			world: h.world,
			purpose: PURPOSE,
			now: () => NOW,
		}).query(
			{ principal: SCOPE.principal, scopeKeys: [SCOPE.scopeKey] },
			{ mode: "snapshot" },
		);
		if (result.status !== "ok" || result.result.mode !== "snapshot")
			throw new Error(JSON.stringify(result));
		const entry = result.result.entries[0]!;
		expect(entry.sources).toContainEqual(whole);
		expect(entry.evidence[0]?.source).toEqual(ref);
		expect(entry.evidence[0]?.quoteDigest).toBe(sha256Hex(value));
		expect(entry.condition).toEqual(condition);
		expect(entry.validTime).toEqual(validTime);
		expect(entry.conditionEvaluation).toMatchObject({ result: "unknown" });
		const reading = sourceOf(
			entry,
			SCOPE.scopeKey,
			"2026-10-31T00:00:00Z",
			() => "対象",
		)!;
		expect(reading.body).toContain(value);
		expect(reading.body).toContain('observation-7 = "条件7の値"');
	});
});

test("updated distribution selects an exact claim on the host store and refuses an old receipt after correction", async () => {
	await withHarness(async (h) => {
		expect((await h.world.apply(entityOp())).status).toBe("applied");
		await addMessage(h, "m1", "確認済みの資料");
		const ref = currentRef(h, "m1");
		for (const [id, text] of [
			["a-background", "背景".repeat(500)],
			["z-needed", "必要な記録"],
		])
			expect(
				(
					await h.world.apply(
						registerClaim(
							id!,
							claim(id!, [ref], {
								payload: {
									kind: "value",
									value: { kind: "string", value: text },
								},
							}),
						),
					)
				).status,
			).toBe("applied");
		const read = await h.world.read({
			access: ACCESS,
			scope: SCOPE,
			asOf: NOW,
		});
		if (read.status !== "ready") throw new Error(JSON.stringify(read));
		const result = buildWorldSlice(
			{
				contractVersion: 1,
				snapshot: read.snapshot,
				request: {
					focusAssertionRefs: [{ id: "z-needed", revision: 1 }],
					maxBytes: 1800,
				},
			},
			sha256Hex,
		);
		if (!result.ok) throw new Error(JSON.stringify(result));
		expect(result.value.units.map((u) => u.assertionId)).toEqual(["z-needed"]);
		expect(result.value.status).toBe("partial");
		expect(result.value.budget.usedBytes).toBeLessThanOrEqual(1800);
		const receipt = toSliceReceipt(result.value);
		expect(
			(await h.world.validateUsage(receipt, { access: ACCESS, scope: SCOPE }))
				.status,
		).toBe("valid");
		await h.conversation.correct({ messageId: "m1", text: "訂正された資料" });
		expect(
			await h.world.validateUsage(receipt, { access: ACCESS, scope: SCOPE }),
		).toMatchObject({ status: "blocked", reasonCode: "SOURCE_CHANGED" });
	});
});

test("the registered research route exposes a long claim's final condition and preserves its evidence through report adoption", async () => {
	const h = await boot(
		[
			() => invoke("world.find", { names: ["音声サービス"] }),
			() =>
				invoke("world.query", {
					mode: "snapshot",
					entityIds: ["svc-1"],
					depth: 0,
				}),
			(packet) => {
				const observed = packet.observations.find((o) =>
					o.excerpts.some((e) => e.quote.includes("末尾の制約")),
				);
				const body = observed?.excerpts.map((e) => e.quote).join("");
				expect(body).toContain(value);
				expect(body).toContain('observation-7 = "条件7の値"');
				expect(body).toContain(JSON.stringify(validTime));
				expect(body).toContain("CLAIM_NOT_VALID");
				const excerpt = observed?.excerpts.find((e) =>
					e.quote.includes("末尾の制約"),
				);
				if (!excerpt) throw new Error("expected_evidence_missing");
				return {
					action: "finish",
					report: {
						outcome: "answered",
						summary: "記録には条件があり、有効期間外です。",
						claims: [
							{
								text: "末尾の制約も適用条件に含まれています。",
								evidence: [excerpt.reference],
							},
						],
						limitations: ["有効期間外の記録です。"],
					},
				};
			},
		],
		{
			async seed({ apply, assertion }) {
				expect(
					await apply("long-evidence", {
						kind: "assertion.register",
						assertion: {
							...assertion("long-evidence", "svc-1", "long-value", value),
							condition,
							validTime,
						},
					}),
				).toMatchObject({ status: "applied" });
			},
		},
	);
	const { done } = await h.ask(QUESTION);
	expect(done?.status).toBe("completed");
	expect(h.reported()).toContain("world_claim");
});

test("whole-claim byte limits still mark an overfull research result as partial", async () => {
	const h = await boot(
		[
			() => invoke("world.find", { names: ["音声サービス"] }),
			() =>
				invoke("world.query", {
					mode: "snapshot",
					entityIds: ["svc-1"],
					depth: 0,
				}),
			(packet) => {
				expect(packet.operations.at(-1)?.notes?.completeness).toBe("partial");
				expect(packet.operations.at(-1)?.notes?.reasons).toContain(
					"PRESENTATION_BUDGET",
				);
				expect(
					packet.observations.filter((o) => o.basis === "world").length,
				).toBeLessThan(13);
				const excerpt = packet.observations.flatMap((o) => o.excerpts)[0]!;
				return {
					action: "finish",
					report: {
						outcome: "answered",
						summary: "上限に達したため一部の記録だけ確認しました。",
						claims: [
							{
								text: "表示されている記録だけを確認しました。",
								evidence: [excerpt.reference],
							},
						],
						limitations: ["予算上限による部分取得です。"],
					},
				};
			},
		],
		{
			async seed({ apply, assertion }) {
				for (let i = 0; i < 12; i++)
					expect(
						await apply(`large-${i}`, {
							kind: "assertion.register",
							assertion: assertion(
								`large-${i}`,
								"svc-1",
								"large-value",
								"長".repeat(600),
							),
						}),
					).toMatchObject({ status: "applied" });
			},
		},
	);
	expect((await h.ask(QUESTION)).done?.status).toBe("completed");
});
