import { z } from "zod";
import type { Prepared } from "../../capabilities";

export const guidedWeb = (p: Prepared | undefined) =>
	p?.package.schemaKey === "guidedResearch";
const mission = z
	.object({
		facts: z.array(z.string().min(1).max(200)).min(1).max(8),
		conditions: z.array(z.string().min(1).max(160)).max(4),
	})
	.strict();
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
export const guidedReport = z
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
export const guidedAction = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("invoke"),
			tool: z.string().min(1).max(200),
			arguments: z.record(z.string(), z.unknown()),
			/** Each planned argument has the same canonical read input as the first call. */
			readAhead: z
				.array(z.object({ url: z.string().url().max(2048) }).strict())
				.max(5)
				.optional(),
			mission: mission.optional(),
		})
		.strict(),
	z.object({ action: z.literal("wait"), mission: mission.optional() }).strict(),
	z
		.object({
			action: z.literal("finish"),
			report: guidedReport,
			mission: mission.optional(),
		})
		.strict(),
]);
export type GuidedAction = z.infer<typeof guidedAction>;
export type GuidedReport = z.infer<typeof guidedReport>;
export type WebMission = z.infer<typeof mission>;
