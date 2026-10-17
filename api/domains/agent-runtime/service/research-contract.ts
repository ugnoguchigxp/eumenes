import { z } from "zod";
import {
	draftReport,
	draftReportBase,
	requestRequirement,
} from "../contracts/requirements";
export const researchReport = draftReport;
const invoke = z
	.object({
		action: z.literal("invoke"),
		tool: z.string().min(1).max(128).describe("現在のTOOLSのid。"),
		arguments: z
			.unknown()
			.describe("選んだTOOLSのinputSchemaに従う。不要な任意項目は省略する。"),
	})
	.strict();
const finish = z
	.object({ action: z.literal("finish"), report: researchReport })
	.strict();
/** Minimal valid examples; `controlInstructions` renders them as OUTPUT_FORMAT. */
const invokeExample = { action: "invoke", tool: "TOOLSのid", arguments: {} };
const reportExample = {
	outcome: "answered",
	summary: "調査結果の要約",
	claims: [{ text: "確認した事実", evidence: ["e1"] }],
	limitations: [],
	checks: [
		{
			requirementId: "r1",
			status: "satisfied",
			value: "取得した値",
			evidence: ["e1"],
			reason: "根拠による判断の理由",
		},
	],
	externalRules: [],
};
const requirementsExample = [
	{
		id: "r1",
		statement: "依頼から抽出した確認条件",
		requestQuote: "依頼原文の連続する引用",
		valueSchema: { type: "string" },
	},
];
export const researchAction = z
	.discriminatedUnion("action", [invoke, finish])
	.meta({
		examples: [invokeExample, { action: "finish", report: reportExample }],
	});
/** Refs of the requirement catalog the sub-agent applies; chosen once, at the first step. */
const profileRefs = z
	.array(z.string().regex(/^p[1-9][0-9]*$/))
	.max(4)
	.optional()
	.describe(
		"requirementCatalogのref（最大4件）。titleとscopeを依頼に照らして適用するものだけ。合うものがなければ省略。",
	);
const firstRequirements = z
	.array(requestRequirement)
	.min(1)
	.max(12)
	.describe(
		"原文の依頼要件だけをr1から連番で。profile要件は複製しない（依頼要件とprofile要件の合計は12件以内）。",
	);
export const firstResearchAction = z
	.discriminatedUnion("action", [
		invoke.extend({
			requirements: firstRequirements,
			requirementProfiles: profileRefs,
		}),
		finish.extend({
			requirements: firstRequirements,
			requirementProfiles: profileRefs,
		}),
	])
	.meta({
		examples: [
			{ ...invokeExample, requirements: requirementsExample },
			{
				action: "finish",
				requirements: requirementsExample,
				report: reportExample,
			},
		],
	});
const findings = draftReportBase
	.omit({ checks: true, externalRules: true })
	.extend({
		/** Optional: a fetch procedure worth keeping, judged by the host before it is saved. */
		recipe: z
			.object({
				signature: z.string().trim().min(1).max(200),
				url: z.string().max(2048),
				readHint: z.string().trim().min(1).max(200),
			})
			.strict()
			.optional(),
	});
export const searchReport = z.discriminatedUnion("outcome", [
	findings.extend({
		outcome: z.enum(["answered", "partial"]),
		claims: findings.shape.claims.min(1),
	}),
	findings.extend({
		outcome: z.enum(["not_found", "clarification_required", "failed"]),
		claims: findings.shape.claims.max(0),
	}),
]);
export const searchAction = z
	.discriminatedUnion("action", [
		invoke,
		z.object({ action: z.literal("finish"), report: searchReport }).strict(),
	])
	.meta({
		examples: [
			{ action: "invoke", tool: "TOOLSのid", arguments: {} },
			{
				action: "finish",
				report: {
					outcome: "answered",
					summary: "調査結果の要約",
					claims: [{ text: "確認した事実", evidence: ["e1"] }],
					limitations: [],
				},
			},
		],
	});
