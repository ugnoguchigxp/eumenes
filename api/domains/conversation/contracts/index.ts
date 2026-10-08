import { z } from "zod";
import { avatarMotionSchema, speechDeliverySchema } from "../../delivery";
export const messageSchema = z.object({
	id: z.string(),
	conversationId: z.string(),
	role: z.enum(["user", "assistant"]),
	text: z.string(),
	createdAt: z.string(),
	runId: z.string().nullable(),
	avatarMotion: avatarMotionSchema.optional(),
	delivery: speechDeliverySchema.optional(),
});
export type Message = z.infer<typeof messageSchema>;
export const conversationSchema = z.object({
	id: z.string(),
	revision: z.number().int(),
	messages: z.array(messageSchema),
});
export type Conversation = z.infer<typeof conversationSchema>;
