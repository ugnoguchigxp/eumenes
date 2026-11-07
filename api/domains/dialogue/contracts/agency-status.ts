import { z } from "zod";

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
