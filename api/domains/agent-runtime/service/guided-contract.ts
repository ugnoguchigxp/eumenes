import { z } from "zod";
import type { Prepared } from "../../capabilities";
import { finishLinks } from "./resource-access";

export const guidedWeb = (p: Prepared | undefined) =>
	["guidedResearch", "guidedCandidates"].includes(p?.package.schemaKey ?? "");
const claim = z
	.object({
		text: z.string().min(1).max(500),
		status: z.enum(["verified", "unknown", "conflicting"]),
		evidence: z.array(z.string().regex(/^e[1-9][0-9]*$/)).max(3),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.status !== "unknown" && !value.evidence.length)
			ctx.addIssue({
				code: "custom",
				path: ["evidence"],
				message: "body evidence required",
			});
	});
const guidedReport = z
	.object({
		completion: z.enum(["complete", "incomplete"]),
		answer: z.string().trim().min(1).max(8000),
		summary: z.string().min(1).max(1200),
		claims: z.array(claim).max(8),
		limitations: z.array(z.string().max(300)).max(8),
		recipe: z
			.object({
				signature: z.string().trim().min(1).max(200),
				url: z.string().url().max(2048),
				readHint: z.string().trim().min(1).max(200),
			})
			.strict()
			.optional(),
	})
	.strict();
const invoke = z
	.object({
		action: z.literal("invoke"),
		tool: z.string().min(1).max(200),
		arguments: z.record(z.string(), z.unknown()),
		/** Further URLs read in the same batch; each becomes a `{url}` read like the first call. */
		readAhead: z.array(z.string().url().max(2048)).max(5).optional(),
	})
	.strict();
const wait = z.object({ action: z.literal("wait") }).strict();
const finish = z
	.object({
		action: z.literal("finish"),
		report: guidedReport,
		links: finishLinks,
	})
	.strict();
export const guidedAction = z.discriminatedUnion("action", [
	invoke,
	wait,
	finish,
]);

export const candidateReport = guidedReport
	.omit({ recipe: true })
	.extend({
		resultKind: z
			.enum(["candidates", "facts", "mixed"])
			.describe(
				"candidates: candidateRefsを1件以上選び、claimsのevidenceは空。facts: candidateRefsは空。mixed: candidateRefsを1件以上選び、本文根拠eNを持つclaimも1件以上必要。候補だけなら本文読取は不要。",
			),
		candidateRefs: z
			.array(z.string().regex(/^c[1-9][0-9]*$/))
			.max(5)
			.describe(
				"提示されたcNのみ。resultKindがfactsなら[]、candidatesまたはmixedなら1〜5件。cNをclaims.evidenceへ入れない。",
			),
	})
	.superRefine((value, ctx) => {
		if (
			(value.resultKind === "facts" && value.candidateRefs.length) ||
			(value.resultKind === "candidates" &&
				value.claims.some((c) => c.evidence.length)) ||
			(value.resultKind === "mixed" &&
				!value.claims.some((c) => c.evidence.length)) ||
			(value.resultKind !== "facts" && !value.candidateRefs.length)
		)
			ctx.addIssue({
				code: "custom",
				path: ["candidateRefs"],
				message: "candidate required",
			});
	})
	.meta({
		examples: [
			{
				completion: "incomplete",
				answer:
					"外部検索で候補を1件見つけました。本文は未確認で、要求された残りの件数は不足しています。",
				summary: "候補1件、残り不足",
				resultKind: "candidates",
				candidateRefs: ["c1"],
				claims: [],
				limitations: ["本文未確認", "要求件数に不足"],
			},
		],
	});
// Top-level examples replace the whole output schema in controlInstructions.
// Keep the report example nested so invoke/wait/finish remain visible to the model.
const candidateAction = z.discriminatedUnion("action", [
	invoke,
	wait,
	z
		.object({
			action: z.literal("finish"),
			report: candidateReport,
			links: finishLinks,
		})
		.strict(),
]);

export const guidedActionFor = (p: Prepared) =>
	p.package.schemaKey === "guidedCandidates" ? candidateAction : guidedAction;
export type GuidedAction = z.infer<typeof guidedAction>;
export type GuidedReport = z.infer<typeof guidedReport> & {
	resultKind?: "candidates" | "facts" | "mixed";
	candidateRefs?: string[];
};
