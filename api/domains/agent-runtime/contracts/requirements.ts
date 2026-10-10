import { z } from "zod";
import {
	requirementSpec,
	requirementId,
	profileSnapshot,
	jsonSchema,
	utcDateTime,
} from "../../capabilities/contracts";
export const requestRequirement = z
	.object({
		id: z.string().regex(/^r[1-9][0-9]*$/),
		statement: z.string().min(1).max(500),
		requestQuote: z.string().min(1).max(512),
		valueSchema: jsonSchema,
	})
	.strict();
export type RequestRequirement = z.infer<typeof requestRequirement>;
export const frozenRequirement = requirementSpec.safeExtend({
	id: requirementId,
	origin: z.discriminatedUnion("kind", [
		z
			.object({
				kind: z.literal("request"),
				requestQuote: z.string().min(1).max(512),
			})
			.strict(),
		z
			.object({
				kind: z.literal("profile"),
				revisionId: z.string(),
				localId: requirementId.max(56),
			})
			.strict(),
	]),
});
export const requirementContract = z
	.object({
		version: z.literal(1),
		taskId: z.string(),
		rootRunId: z.string(),
		cancelEpoch: z.number().int().nonnegative(),
		originalRequest: z.string().min(1).max(8000),
		question: z.string().min(1).max(8000),
		requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
		profiles: z.array(profileSnapshot).max(4),
		requirements: z.array(frozenRequirement).min(1).max(12),
	})
	.strict();
export type RequirementContract = z.infer<typeof requirementContract>;
export type FrozenRequirement = z.infer<typeof frozenRequirement>;
export const checkStatus = z.enum([
	"satisfied",
	"unsatisfied",
	"unknown",
	"not_applicable",
]);
export const evidenceRefs = z.array(z.string().regex(/^e[1-9][0-9]*$/)).max(3);
export const requirementCheck = z
	.object({
		requirementId: requirementId,
		status: checkStatus,
		value: z.json(),
		evidence: evidenceRefs,
		reason: z.string().min(1).max(300),
	})
	.strict();
export type RequirementCheck = z.infer<typeof requirementCheck>;
export const externalRuleBase = z
	.object({
		id: z.string().regex(/^x[1-9][0-9]*$/),
		requirementId: requirementId,
		statement: z.string().min(1).max(500),
		scope: z.string().min(1).max(300),
		validFrom: utcDateTime.nullable(),
		validUntil: utcDateTime.nullable(),
		evidence: evidenceRefs.min(1),
	})
	.strict();
export const externalRule = externalRuleBase.refine(
	(r) =>
		!r.validFrom ||
		!r.validUntil ||
		Date.parse(r.validFrom) <= Date.parse(r.validUntil),
);
export const draftReportBase = z
	.object({
		outcome: z.enum([
			"answered",
			"partial",
			"not_found",
			"clarification_required",
			"failed",
		]),
		summary: z.string().min(1).max(2000),
		claims: z
			.array(
				z
					.object({
						text: z.string().min(1).max(500),
						evidence: evidenceRefs.min(1),
					})
					.strict(),
			)
			.max(8),
		limitations: z.array(z.string().min(1).max(300)).max(8),
		checks: z.array(requirementCheck).min(1).max(12),
		externalRules: z.array(externalRule).max(12),
	})
	.strict();
export const draftReport = z.discriminatedUnion("outcome", [
	draftReportBase.extend({
		outcome: z.enum(["answered", "partial"]),
		claims: draftReportBase.shape.claims.min(1),
	}),
	draftReportBase.extend({
		outcome: z.enum(["not_found", "clarification_required", "failed"]),
		claims: draftReportBase.shape.claims.max(0),
	}),
]);
export type DraftReport = z.infer<typeof draftReport>;
export const requirementVerification = z
	.object({
		requestCovered: z.boolean(),
		summarySupported: z.boolean(),
		limitationsConsistent: z.boolean(),
		claims: z
			.array(
				z
					.object({
						index: z.number().int().min(0).max(7),
						supported: z.boolean(),
					})
					.strict(),
			)
			.max(8),
		checks: z
			.array(
				z
					.object({
						requirementId: requirementId,
						status: checkStatus,
						supported: z.boolean(),
						reason: z.string().min(1).max(160),
					})
					.strict(),
			)
			.min(1)
			.max(12),
		externalRules: z
			.array(
				z
					.object({
						id: z.string().regex(/^x[1-9][0-9]*$/),
						supported: z.boolean(),
					})
					.strict(),
			)
			.max(12),
	})
	.strict();
export type RequirementVerification = z.infer<typeof requirementVerification>;
export const canonicalEvidence = z
	.object({
		sourceId: z.string(),
		viewId: z.string().uuid(),
		quote: z.string().max(400),
	})
	.strict();
export const reportRequirements = z
	.object({
		contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
		requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
		profiles: z
			.array(
				profileSnapshot.pick({
					revisionId: true,
					hash: true,
					generation: true,
				}),
			)
			.max(4),
		items: z
			.array(
				frozenRequirement
					.pick({
						id: true,
						statement: true,
						required: true,
						applicability: true,
					})
					.extend({
						origin: z.discriminatedUnion("kind", [
							z.object({ kind: z.literal("request") }).strict(),
							z
								.object({
									kind: z.literal("profile"),
									revisionId: z.string(),
									localId: requirementId.max(56),
								})
								.strict(),
						]),
					})
					.strict(),
			)
			.min(1)
			.max(12),
		checks: z
			.array(
				requirementCheck.extend({
					evidence: z.array(canonicalEvidence).max(3),
				}),
			)
			.min(1)
			.max(12),
		externalRules: z
			.array(
				externalRuleBase.extend({
					evidence: z.array(canonicalEvidence).min(1).max(3),
				}),
			)
			.max(12),
		verificationDigest: z.string().regex(/^[a-f0-9]{64}$/),
		semanticVerification: z.literal("model_checked"),
	})
	.strict();
export type ReportRequirements = z.infer<typeof reportRequirements>;
