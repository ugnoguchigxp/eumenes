import { z } from "zod";
export const voiceStartSchema = z.object({
	sessionId: z.uuid(),
	generation: z.number().int().positive(),
});
export const voiceTurnSchema = z.object({
	utteranceId: z.uuid(),
	sessionId: z.uuid(),
	generation: z.number().int().positive(),
	sequence: z.number().int().positive(),
	status: z.enum([
		"recognizing",
		"responding",
		"synthesizing",
		"ready",
		"played",
		"completed",
		"failed",
		"cancelled",
		"interrupted",
	]),
	text: z.string().nullable(),
	runId: z.string().nullable(),
	error: z.string().nullable(),
	revision: z.number().int(),
	audioChunks: z
		.array(
			z.object({ index: z.number().int().nonnegative(), text: z.string() }),
		)
		.optional(),
	audioComplete: z.boolean().optional(),
});
export type VoiceTurn = z.infer<typeof voiceTurnSchema>;
