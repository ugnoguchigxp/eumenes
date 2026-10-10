import { z } from "zod";
import type { HttpErrorStatus } from "../../../infrastructure/http";
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
	/** Clauses that could not be spoken and were skipped. */
	audioSkipped: z.number().int().nonnegative().optional(),
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

/** HTTP status of each error code this domain throws; merged by `api/application/error-status.ts`. */
export const errorStatus = {
	voice_sequence_out_of_order: 409,
	voice_utterance_conflict: 409,
	voice_preview_busy: 409,
	voice_sequence_invalid: 400,
	voice_turn_inactive: 409,
	voice_audio_capacity: 503,
} as const satisfies Record<string, HttpErrorStatus>;
