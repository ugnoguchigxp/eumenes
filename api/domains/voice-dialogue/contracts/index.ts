import { z } from "zod";
import { speechDeliverySchema } from "../../delivery";
export const voiceStartSchema = z.object({
	sessionId: z.uuid(),
	generation: z.number().int().positive(),
});
export const sampleInputSchema = z
	.object({
		voice: z.string().trim().max(200).optional(),
		style: z.string().trim().min(1).max(200).optional(),
		speed: z.number().min(0.5).max(2).optional(),
		pitchScale: z.number().min(-0.15).max(0.15).optional(),
		intonationScale: z.number().min(0).max(2).optional(),
	})
	.strict();
export const replayInputSchema = z.object({
	runId: z.string().min(1).max(120).optional(),
	text: z.string().trim().min(1).max(65536),
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
			z.object({
				index: z.number().int().nonnegative(),
				text: z.string(),
				delivery: speechDeliverySchema.optional(),
			}),
		)
		.optional(),
	audioComplete: z.boolean().optional(),
	/** P3-08: from the run (explicit): World was read, or World blocked the run. */
	worldUsed: z.boolean().optional(),
	worldBlocked: z.boolean().optional(),
});
export type VoiceTurn = z.infer<typeof voiceTurnSchema>;

export const previewResultSchema = z.object({
	utteranceId: z.string(),
	text: z.string(),
});
export const replaySentencesSchema = z.object({
	sentences: z.array(z.string()),
});
