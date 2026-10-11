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
export const firstResearchAction = z.discriminatedUnion("action", [
	invoke.extend({ requirements: z.array(requestRequirement).min(1).max(12) }),
	finish.extend({ requirements: z.array(requestRequirement).min(1).max(12) }),
]);
const findings = draftReportBase.omit({ checks: true, externalRules: true });
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
export const searchAction = z.discriminatedUnion("action", [
	invoke,
	z.object({ action: z.literal("finish"), report: searchReport }).strict(),
]);
