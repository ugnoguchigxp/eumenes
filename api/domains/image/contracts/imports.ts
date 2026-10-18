import { z } from "zod";
import { imageArtifact } from "../../larm/contracts";

export const imageImportView = z.object({
	requestId: z.uuid(),
	status: z.enum([
		"ready",
		"pending",
		"unknown",
		"succeeded",
		"deleted",
		"failed",
		"expired",
		"blocked",
	]),
	createdAt: z.number(),
	expiresAt: z.number(),
	retryAfterMs: z.number().int().min(0),
	artifact: imageArtifact.optional(),
	errorCode: z.string().max(128).optional(),
	httpStatus: z.number().int().optional(),
});
export type ImageImportView = z.infer<typeof imageImportView>;
