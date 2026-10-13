import { z } from "zod";
export const attachmentSchema = z.object({
	id: z.uuid(),
	conversationId: z.string(),
	name: z.string(),
	mime: z.enum(["image/jpeg", "image/png", "image/bmp"]),
	originalMime: z.enum(["image/jpeg", "image/png", "image/bmp"]),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	size: z.number().int().positive(),
	digest: z.string(),
	createdAt: z.string(),
});
export type Attachment = z.infer<typeof attachmentSchema>;
/** Eumenes resource caps; the current Provider's possibly lower limits are also enforced. */
export const attachmentLimits = {
	maxBytes: 3 * 1024 * 1024,
	maxImages: 8,
	maxPixels: 16 * 1024 * 1024,
	maxDimension: 8192,
	maxAspect: 100,
	pendingHours: 24,
	pendingBytes: 64 * 1024 * 1024,
};
export const attachmentErrors = {
	image_invalid: 422,
	image_format_unsupported: 415,
	image_mime_mismatch: 415,
	image_too_large: 413,
	image_count_exceeded: 413,
	image_dimensions_exceeded: 413,
	attachment_not_found: 404,
	attachment_source_unavailable: 409,
	attachment_capacity: 429,
} as const;
