import { z } from "zod";
import { speechDeliverySchema } from "../../delivery/contracts";

export const runSpeechInputSchema = z.object({ screenId: z.uuid() }).strict();
export const runSpeechPlayedSchema = runSpeechInputSchema
	.extend({
		generationId: z.uuid(),
		index: z.number().int().nonnegative(),
		audible: z.boolean(),
	})
	.strict();
const identity = { runId: z.string(), sessionId: z.uuid() };
export const runSpeechEventSchema = z.discriminatedUnion("type", [
	z.object({ ...identity, type: z.literal("start") }),
	z.object({
		...identity,
		type: z.literal("generation"),
		generationId: z.uuid(),
	}),
	z.object({
		...identity,
		type: z.literal("audio"),
		generationId: z.uuid(),
		index: z.number().int().nonnegative(),
		text: z.string().max(65536),
		wav: z.string().max(5_333_336),
		delivery: speechDeliverySchema.optional(),
	}),
	z.object({ ...identity, type: z.literal("finished") }),
	z.object({ ...identity, type: z.literal("error"), reason: z.string() }),
]);
export type RunSpeechEvent = z.infer<typeof runSpeechEventSchema>;
export type RunSpeechPlayed = z.infer<typeof runSpeechPlayedSchema>;
