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
	model: z.string().optional(),
	actualModel: z.string().nullable(),
	errorCode: z.string().nullable(),
	/** Set while LARM's free-memory wait is running: when it began and how many tries were scheduled. */
	capacityWait: z
		.object({ startedAt: z.number(), count: z.number().int() })
		.optional(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type ImageRecord = z.infer<typeof imageRecord>;

export { imagePlanV2 } from "../../capabilities/contracts";
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

export const prototypeImageRequest = z.strictObject({
	operationId: z.uuid(),
	prompt: z.string().trim().min(1).max(2_000),
	width: z.int().min(100).max(1280),
	height: z.int().min(100).max(1280),
	format: z.enum(["png", "webp"]),
	seed: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
	deadline: z.int().positive().optional(),
});
export const prototypeImageView = z.object({
	operationId: z.uuid(),
	state: z.enum(["generating", "completed", "failed", "cancelled"]),
	phase: z.string(),
	errorCode: z.string().nullable(),
	deadline: z.number(),
});
export type PrototypeImageRequest = z.output<typeof prototypeImageRequest>;
