import { z } from "zod";
export const messageSchema = z.object({
	id: z.string(),
	conversationId: z.string(),
	role: z.enum(["user", "assistant"]),
	text: z.string(),
	createdAt: z.string(),
	runId: z.string().nullable(),
});
export type Message = z.infer<typeof messageSchema>;
export const conversationSchema = z.object({
	id: z.string(),
	revision: z.number().int(),
	messages: z.array(messageSchema),
});
export type Conversation = z.infer<typeof conversationSchema>;
