import { expect, test } from "bun:test";
import {
	freezeRequirements,
	readRequirements,
	validateDraft,
} from "../service/requirements";
import { requirementHarness, requests } from "./requirement-harness";
import { externalRule } from "../contracts/requirements";
test("external rule validity compares instants rather than their UTC string spelling", () => {
	const rule = {
		id: "x1",
		requirementId: "r1",
		statement: "期間限定の条件",
		scope: "確認対象",
		evidence: ["e1"],
		validFrom: "2026-10-10T00:00:00Z",
		validUntil: "2026-10-10T00:00:00.001Z",
	};
	expect(externalRule.safeParse(rule).success).toBe(true);
	expect(
		externalRule.safeParse({
			...rule,
			validFrom: rule.validUntil,
			validUntil: rule.validFrom,
		}).success,
	).toBe(false);
});
test("R10/R12/R14 request quote, profile merge and unknown/null constraints are fixed once", async () => {
	const { h, child } = await requirementHarness();
	try {
		const frozen = await h.store.write((db) =>
			freezeRequirements(db, h.task(child.id), requests, h.caps, Date.now()),
		);
		expect(frozen.contract.requirements.map((r) => r.id)).toEqual([
			"r1",
			"p1.quantity",
		]);
		expect(frozen.contract.requirements[0]).toMatchObject({
			required: true,
			allowNotApplicable: false,
		});
		const draft = {
			outcome: "partial",
			summary: "一部確認できない",
			claims: [{ text: "数量は2", evidence: ["e1"] }],
			limitations: ["明示条件不明"],
			checks: [
				{
					requirementId: "r1",
					status: "unknown",
					value: null,
					evidence: [],
					reason: "未確認",
				},
				{
					requirementId: "p1.quantity",
					status: "satisfied",
					value: 2,
					evidence: ["e1"],
					reason: "資料で確認",
				},
			],
			externalRules: [],
		};
		expect(validateDraft(draft, frozen.contract).checks[0]!.value).toBeNull();
		for (const invalid of [
			{ ...draft, outcome: "answered" },
			{
				...draft,
				checks: [
					{ ...draft.checks[0], status: "not_applicable", evidence: ["e1"] },
					draft.checks[1],
				],
			},
			{
				...draft,
				checks: [draft.checks[0], { ...draft.checks[1], value: "2" }],
			},
			{ ...draft, checks: [draft.checks[0]] },
		])
			expect(() => validateDraft(invalid, frozen.contract)).toThrow(
				"invalid_requirement_report",
			);
		await expect(
			h.store.write((db) =>
				freezeRequirements(db, h.task(child.id), requests, h.caps, Date.now()),
			),
		).rejects.toThrow();
		expect(
			h.store.read((db) => readRequirements(db, h.task(child.id), h.caps))
				?.digest,
		).toBe(frozen.digest);
	} finally {
		await h.close();
	}
});
test("R08/R11 invalid quote and 13 conditions fail without truncating or saving any contract", async () => {
	const { h, child } = await requirementHarness();
	try {
		await expect(
			h.store.write((db) =>
				freezeRequirements(
					db,
					h.task(child.id),
					[{ ...requests[0]!, requestQuote: "存在しない引用" }],
					h.caps,
					Date.now(),
				),
			),
		).rejects.toThrow("invalid_requirement_contract");
		await expect(
			h.store.write((db) =>
				freezeRequirements(
					db,
					h.task(child.id),
					Array.from({ length: 12 }, (_, i) => ({
						...requests[0]!,
						id: `r${i + 1}`,
					})),
					h.caps,
					Date.now(),
				),
			),
		).rejects.toThrow("requirement_capacity_exceeded");
		expect(
			h.store.read((db) =>
				db.query("SELECT COUNT(*) AS n FROM agent_requirement_contracts").get(),
			),
		).toEqual({ n: 0 });
	} finally {
		await h.close();
	}
});
