import { z } from "zod";
export const musicRecord = z.object({
	id: z.string(),
	runId: z.string(),
	conversationId: z.string(),
	state: z.enum(["planning", "generating", "completed", "failed", "cancelled"]),
	title: z.string(),
	description: z.string(),
	prompt: z.string().nullable(),
	durationSeconds: z.number().nullable(),
	phase: z.string(),
	jobId: z.string().nullable(),
	errorCode: z.string().nullable(),
	mime: z.string().nullable(),
	actualModel: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type MusicRecord = z.infer<typeof musicRecord>;
