import { z } from "zod";

/** Content-free activity lease. Revisions fence delayed reports from a departed screen. */
export const agencyActivitySchema = z
	.object({
		screenId: z.uuid(),
		revision: z.number().int().min(1),
		sentAt: z.number().int().min(0),
		typing: z.boolean(),
		playing: z.boolean(),
		visible: z.boolean(),
		leaving: z.boolean().optional(),
	})
	.strict();
export type AgencyActivity = z.infer<typeof agencyActivitySchema>;

/** Operational metadata only: no observation, memory, prompt or connection contents. */
export const agencyStatusSchema = z.object({
	conversationId: z.string(),
	activeConversationId: z.string().nullable(),
	displayedConversationId: z.string().nullable(),
	displayExpiresAt: z.number().nullable(),
	actionsEnabled: z.boolean(),
	tracked: z.boolean(),
	busy: z.boolean(),
	idle: z
		.object({
			blockedBy: z.string().nullable(),
			unanswered: z.number(),
			level: z.number(),
			nextIntervalSec: z.number(),
		})
		.nullable(),
	counts: z.object({
		interests: z.number(),
		openIntents: z.number(),
		inFlight: z.number(),
	}),
});
