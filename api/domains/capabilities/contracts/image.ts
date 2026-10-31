import { z } from "zod";
export const imageRequest = z.strictObject({
	question: z.string().trim().min(1).max(8000),
});
/** Flat tool contract; the planner interprets intent, the host validates API constraints. */
export const imagePlan = z.strictObject({
	action: z.enum(["generate", "studio", "library"]),
	title: z.string().trim().min(1).max(120),
	description: z.string().max(500),
	prompt: z.string().max(8192),
	width: z.number().int().min(100).max(1280),
	height: z.number().int().min(100).max(1280),
	format: z.enum(["png", "webp"]),
	seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

/** Explicit request model; omission keeps LARM's default. Steps stay owned by LARM. */
export const imagePlanV2 = imagePlan.extend({
	model: z.string().trim().min(1).max(200).optional(),
});
