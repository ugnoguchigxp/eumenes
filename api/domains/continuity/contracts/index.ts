import { z } from "zod";
export const continuityKinds = ["goal", "decision", "open_question"] as const;
export const continuityStatuses = ["active", "resolved", "retracted"] as const;
export const continuityItemSchema = z.object({
	id: z.string(),
	conversationId: z.string(),
	kind: z.enum(continuityKinds),
	text: z.string().min(1).max(2000),
	status: z.enum(continuityStatuses),
	revision: z.number().int(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type ContinuityItem = z.infer<typeof continuityItemSchema>;
export const addContinuitySchema = z.object({
	kind: z.enum(continuityKinds),
	text: z.string().trim().min(1).max(2000),
});
export type AddContinuity = z.infer<typeof addContinuitySchema>;
export const continuityTransitionSchema = z.object({
	expectedRevision: z.number().int().min(1),
	status: z.enum(["resolved", "retracted"]),
});
export type ContinuityTransition = z.infer<typeof continuityTransitionSchema>;
/** Goals, decisions and open questions that must survive restarts and topic changes. */
export interface ContinuitySnapshot {
	/** Changes whenever any item of the conversation changes. */
	revision: number;
	items: ContinuityItem[];
}
