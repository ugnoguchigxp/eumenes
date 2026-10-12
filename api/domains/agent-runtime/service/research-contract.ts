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
		tool: z.string().min(1).max(128),
		arguments: z.unknown(),
	})
	.strict();
const finish = z
	.object({ action: z.literal("finish"), report: researchReport })
	.strict();
export const researchAction = z.discriminatedUnion("action", [invoke, finish]);
/** Refs of the requirement catalog the sub-agent applies; chosen once, at the first step. */
const profileRefs = z
	.array(z.string().regex(/^p[1-9][0-9]*$/))
	.max(4)
	.optional();
export const firstResearchAction = z.discriminatedUnion("action", [
	invoke.extend({
		requirements: z.array(requestRequirement).min(1).max(12),
		requirementProfiles: profileRefs,
	}),
	finish.extend({
		requirements: z.array(requestRequirement).min(1).max(12),
		requirementProfiles: profileRefs,
	}),
]);
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
