import { z } from "zod";
import { imageArtifact, imageArtifactId } from "./image-library";

const base = {
	requestId: z.uuid(),
	createdAt: z.iso.datetime(),
	expiresAt: z.iso.datetime(),
	statusUrl: z.string().max(2048),
};
export const imageImportReceipt = z.union([
	z.object({ ...base, status: z.literal("pending") }),
	z.object({
		...base,
		status: z.literal("succeeded"),
		deleted: z.literal(false),
		artifact: imageArtifact,
	}),
	z.object({
		...base,
		status: z.literal("succeeded"),
		deleted: z.literal(true),
		artifactId: imageArtifactId,
	}),
	z.object({
		...base,
		status: z.literal("failed"),
		error: z.object({
			code: z.string().min(1).max(128),
			message: z.string().max(2048),
		}),
	}),
]);
