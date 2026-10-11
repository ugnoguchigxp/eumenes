import { z } from "zod";
export const musicRequest = z.strictObject({
	question: z.string().trim().min(1).max(8000),
});
export const musicPlan = z.strictObject({
	title: z.string().trim().min(1).max(120),
	description: z.string().trim().min(1).max(500),
	prompt: z.string().trim().min(1).max(4000),
	durationSeconds: z.number().positive().finite(),
});
/** V1 remains immutable for installed capability revisions and queued work. */
export const musicPlanV2 = musicPlan.extend({
	durationSeconds: z.number().int().min(1).max(600),
	instrumental: z.boolean(),
	lyrics: z.string().max(4000).optional(),
	language: z.string().min(2).max(32).optional(),
});
export const musicPlaybackPlan = z.strictObject({
	title: z.string().trim().min(1).max(120),
	q: z.string().max(512),
	tags: z.array(z.string().min(1).max(64)).max(32),
	favorite: z.boolean().nullable(),
	sort: z.enum(["createdAt", "relevance"]),
	order: z.enum(["asc", "desc"]),
});
