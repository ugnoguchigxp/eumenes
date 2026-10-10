import type { DraftReport } from "../contracts/requirements";
/** Test-only model stub. It exercises host contracts, not semantic accuracy. */
export function fixtureResearchOutput(data: any, raw: string) {
	let action: any;
	try {
		action = JSON.parse(raw);
	} catch {
		return raw;
	}
	if (
		!action ||
		typeof action !== "object" ||
		!["invoke", "finish"].includes(action.action)
	)
		return raw;
	if (!data.requirementContract && !action.requirements)
		action.requirements = [
			{
				id: "r1",
				statement: "現在の依頼の条件を確認して答える",
				requestQuote: (data.originalRequest ?? data.task.question).slice(
					0,
					512,
				),
				valueSchema: { type: "string", maxLength: 2000 },
			},
		];
	if (action.action === "finish" && action.report && !action.report.checks) {
		const refs = action.report.claims?.[0]?.evidence ?? [],
			known =
				["answered", "partial"].includes(action.report.outcome) &&
				refs.length > 0;
		action.report.checks = (
			data.requirementContract?.requirements ?? action.requirements
		).map((r: any) => ({
			requirementId: r.id,
			status: known ? "satisfied" : "unknown",
			value: known ? action.report.summary : null,
			evidence: known ? refs : [],
			reason: known ? "根拠に基づくfixture報告" : "資料から確認できない",
		}));
		action.report.externalRules ??= [];
	}
	return JSON.stringify(action);
}
export const fixtureVerification = (draft: DraftReport) => ({
	requestCovered: true,
	summarySupported: true,
	limitationsConsistent: true,
	claims: draft.claims.map((_, index) => ({ index, supported: true })),
	checks: draft.checks.map((c) => ({
		requirementId: c.requirementId,
		status: c.status,
		supported: true,
		reason: "fixture semantic verifier",
	})),
	externalRules: draft.externalRules.map((r) => ({
		id: r.id,
		supported: true,
	})),
});
