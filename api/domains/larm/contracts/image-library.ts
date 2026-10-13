import { z } from "zod";
export const imageArtifactId = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const imageArtifactDelete = z.strictObject({
	id: imageArtifactId,
	deleted: z.literal(true),
});
export const imageArtifact = z.object({
	id: imageArtifactId,
	createdAt: z.string().datetime(),
	format: z.enum(["webp", "png"]),
	mimeType: z.enum(["image/webp", "image/png"]),
	width: z.number().int().min(1).max(16384),
	height: z.number().int().min(1).max(16384),
	hasAlpha: z.boolean(),
	bytes: z.number().int().positive(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	model: z.string().optional(),
	modelRevision: z.string().optional(),
	seed: z.number().int().nonnegative().optional(),
	steps: z.number().int().positive().optional(),
	contentUrl: z.string(),
});
export const imageLibrary = z.object({
	images: imageArtifact.array(),
	totalBytes: z.number().int().nonnegative(),
	maxBytes: z.number().int().positive(),
	targetBytes: z.number().int().nonnegative(),
});
