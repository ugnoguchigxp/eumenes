import { expect, test } from "bun:test";
import { requirementHarness, requests } from "./requirement-harness";
import { fixtureVerification } from "./research-fixture";
import { validateRequirementAdoption } from "../service/requirement-verification";
const draft = {
	outcome: "not_found",
	summary: "条件不明",
	claims: [],
	limitations: ["資料なし"],
	checks: [
		{
			requirementId: "r1",
			status: "unknown",
			value: null,
			evidence: [],
			reason: "根拠なし",
		},
		{
			requirementId: "p1.quantity",
			status: "unknown",
			value: null,
			evidence: [],
			reason: "根拠なし",
		},
	],
	externalRules: [],
};
for (const when of ["pending", "accepted"])
	test(`R19 profile revision invalidates ${when} verification authority`, async () => {
		const { h, child, dto } = await requirementHarness();
		try {
			await h.runRawModelStep(child.id, {
				action: "finish",
				requirements: requests,
				report: draft,
			});
			if (when === "accepted")
				await h.runRawModelStep(child.id, fixtureVerification(draft as never));
			const report = when === "accepted" ? h.agents.report(child.id) : null;
			await h.caps.putRequirementProfile(dto.id, dto.stateToken, {
				...dto.data,
				title: "改訂された確認基準",
			});
			if (report)
				expect(() =>
					h.store.read((db) =>
						validateRequirementAdoption(db, h.task(child.id), report, h.caps),
					),
				).toThrow("requirement_profile_invalidated");
			else {
				await h.runRawModelStep(child.id, fixtureVerification(draft as never));
				expect(h.task(child.id).state).toBe("failed");
			}
		} finally {
			await h.close();
		}
	});
test("R19/R23 accepted report cannot outlive deletion of its frozen contract and draft", async () => {
	const { h, child } = await requirementHarness();
	try {
		await h.runRawModelStep(child.id, {
			action: "finish",
			requirements: requests,
			report: draft,
		});
		await h.runRawModelStep(child.id, fixtureVerification(draft as never));
		await h.store.write((db) =>
			h.agents.deleteTaskDataInTransaction(db, "requirements"),
		);
		for (const table of [
			"agent_requirement_contracts",
			"agent_requirement_drafts",
		])
			expect(
				h.store.read((db) =>
					db.query(`SELECT COUNT(*) AS n FROM ${table}`).get(),
				),
			).toEqual({ n: 0 });
	} finally {
		await h.close();
	}
});
