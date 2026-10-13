import { z } from "zod";
export const imageRecord = z.object({
	id: z.string().uuid(),
	runId: z.string(),
	conversationId: z.string(),
	state: z.enum(["planning", "generating", "completed", "failed", "cancelled"]),
	action: z.enum(["generate", "studio", "library"]).nullable(),
	title: z.string(),
	description: z.string(),
	prompt: z.string().nullable(),
	width: z.number().nullable(),
	height: z.number().nullable(),
	format: z.enum(["png", "webp"]).nullable(),
	seed: z.number().nullable(),
	phase: z.string(),
	artifactId: z.string().nullable(),
	mime: z.string().nullable(),
	actualModel: z.string().nullable(),
	errorCode: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type ImageRecord = z.infer<typeof imageRecord>;

export { imagePlan } from "../../capabilities/contracts";
