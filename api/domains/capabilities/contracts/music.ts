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
