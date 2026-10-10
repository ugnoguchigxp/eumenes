import { z } from "zod";
export const researchReport = z
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
						evidence: z
							.array(z.string().regex(/^e[1-9][0-9]*$/))
							.min(1)
							.max(3),
					})
					.strict(),
			)
			.max(8),
		limitations: z.array(z.string().max(300)).max(8),
	})
	.strict()
	.refine((r) =>
		["answered", "partial"].includes(r.outcome)
			? r.claims.length > 0
			: r.claims.length === 0,
	);
export const researchAction = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("invoke"),
			tool: z.string().min(1).max(128),
			arguments: z.unknown(),
		})
		.strict(),
	z.object({ action: z.literal("finish"), report: researchReport }).strict(),
]);
