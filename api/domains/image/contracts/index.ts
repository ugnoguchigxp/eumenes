import { z } from "zod";
import type { HttpErrorStatus } from "../../../infrastructure/http";
export const imageRecord = z.object({
	id: z.string().uuid(),
	runId: z.string(),
	conversationId: z.string(),
	state: z.enum(["planning", "generating", "completed", "failed", "cancelled"]),
	action: z.enum(["generate", "studio", "library"]).nullable(),
	title: z.string(),
	description: z.string(),
	prompt: z.string().nullable(),
	width: z.number().nullable(),
	height: z.number().nullable(),
	format: z.enum(["png", "webp"]).nullable(),
	seed: z.number().nullable(),
	phase: z.string(),
	artifactId: z.string().nullable(),
	mime: z.string().nullable(),
	actualModel: z.string().nullable(),
	errorCode: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type ImageRecord = z.infer<typeof imageRecord>;

export { imagePlan } from "../../capabilities/contracts";
export { imageImportView, type ImageImportView } from "./imports";

/** HTTP status of the image codes, which the conversation's attachments and the imports share. */
export const errorStatus = {
	image_invalid: 422,
	image_format_unsupported: 415,
	image_mime_mismatch: 415,
	image_too_large: 413,
	image_dimensions_exceeded: 413,
	invalid_import_request: 400,
	image_import_not_found: 404,
	idempotency_conflict: 409,
	image_import_capacity: 429,
	image_import_connection_changed: 409,
} as const satisfies Record<string, HttpErrorStatus>;
