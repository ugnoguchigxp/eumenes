import { z } from "zod";
import { modelInputSchema } from "../../../infrastructure/model-input";

const captureRef = z.object({
	runId: z.string(),
	id: z.string(),
	number: z.number().int().positive(),
	at: z.number(),
});

const captureSummary = captureRef.extend({
	inferenceId: z.string(),
	attemptId: z.string(),
	expiresAt: z.number(),
	boundary: modelInputSchema.shape.boundary,
	status: z.string(),
	accepted: z.boolean(),
	available: z.boolean(),
});

export const runContextSchema = z.object({
	runId: z.string(),
	conversationId: z.string(),
	status: z.string(),
	captures: z.array(captureSummary),
	preferredId: z.string().nullable(),
	empty: z.enum(["preparing", "no_send", "unavailable"]),
});

export const contextCaptureSchema = z.object({
	summary: captureSummary,
	input: modelInputSchema,
	cut: z.string().nullable(),
	previous: captureRef.nullable(),
});

export type ContextCaptureSummary = z.infer<typeof captureSummary>;
export type RunContext = z.infer<typeof runContextSchema>;
export type ContextCapture = z.infer<typeof contextCaptureSchema>;
