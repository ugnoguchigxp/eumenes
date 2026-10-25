import { z } from "zod";
import type { HttpErrorStatus } from "../../../infrastructure/http";
import { speechDeliverySchema } from "../../delivery";
import { runViewingSchema } from "../../dialogue/contracts";
export const voiceStartSchema = z.object({
	sessionId: z.uuid(),
	generation: z.number().int().positive(),
});
export const sampleInputSchema = z
	.object({
		voice: z.string().trim().max(200).optional(),
		style: z.preprocess(
			(value) => (value === null ? undefined : value),
			z.string().trim().min(1).max(200).optional(),
		),
		speed: z.number().min(0.5).max(2).optional(),
		pitchScale: z.number().min(-0.15).max(0.15).optional(),
		intonationScale: z.number().min(0).max(2).optional(),
	})
	.strict();
export const replayInputSchema = z.object({
	runId: z.string().min(1).max(120).optional(),
	/** A runless message (agency utterance): its stored host delivery is used for the clause. */
	messageId: z.string().min(1).max(512).optional(),
	text: z.string().trim().min(1).max(65536),
});
export const voiceTurnSchema = z.object({
	utteranceId: z.uuid(),
	sessionId: z.uuid(),
	generation: z.number().int().positive(),
	sequence: z.number().int().positive(),
	status: z.enum([
		"recognizing",
		"input_ready",
		"merged",
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
	voice_input_stale: 409,
	voice_input_not_ready: 409,
	voice_audio_capacity: 503,
} as const satisfies Record<string, HttpErrorStatus>;

const ms = z.number().int().nonnegative().max(600_000);
/** Where the input's time went in the browser before its transcript was shown (ms, numbers only). */
export const inputTimingSchema = z
	.object({
		audioMs: ms,
		preRollMs: ms,
		trailMs: ms,
		endToSegmentMs: ms,
		encodeMs: ms,
		uploadMs: ms,
		uploadToShownMs: ms,
	})
	.strict();
export type InputTiming = z.infer<typeof inputTimingSchema>;
export const inputCommitSchema = z
	.object({
		revision: z.number().int().nonnegative(),
		/** The saved item on screen when the user spoke; re-checked by the host like a typed message's. */
		viewing: runViewingSchema.optional(),
		timing: inputTimingSchema.optional(),
	})
	.strict();
