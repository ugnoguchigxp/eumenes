import { z } from "zod";
export * from "./correction";
export const maxInputBytes = 16 * 1024 * 1024;
export const inputMime = z.enum([
	"image/jpeg",
	"image/png",
	"image/webp",
	"video/mp4",
	"video/quicktime",
	"video/webm",
]);
const dimension = z.number().int().positive().max(65536);
const point = z.tuple([z.number().nonnegative(), z.number().nonnegative()]);
export const ocrLine = z.object({
	text: z.string().max(10000),
	confidence: z.number().finite().min(0).max(1),
	polygon: z.array(point).length(4),
});
const lines = z.array(ocrLine).max(10000);
export const imageResult = z.object({
	kind: z.literal("image"),
	model: z.string().min(1).max(200),
	width: dimension,
	height: dimension,
	text: z.string().max(1000000),
	lines,
});
export const videoResult = z.object({
	kind: z.literal("video"),
	model: z.string().min(1).max(200),
	video: z.object({
		width: dimension,
		height: dimension,
		durationSeconds: z.number().nonnegative().max(30).optional(),
	}),
	frames: z
		.array(
			z.object({
				timestampSeconds: z.number().nonnegative().max(30),
				text: z.string().max(1000000),
				lines,
			}),
		)
		.max(60),
});
export const ocrResult = z
	.union([imageResult, videoResult])
	.superRefine((r, ctx) => {
		const width = r.kind === "image" ? r.width : r.video.width;
		const height = r.kind === "image" ? r.height : r.video.height;
		const groups =
			r.kind === "image" ? [r.lines] : r.frames.map((f) => f.lines);
		if (
			groups.some((group) =>
				group.some((line) =>
					line.polygon.some(([x, y]) => x > width || y > height),
				),
			)
		)
			ctx.addIssue({ code: "custom", message: "polygon_outside_source" });
		if (
			r.kind === "video" &&
			r.frames.some(
				(f, i) =>
					i > 0 && f.timestampSeconds <= r.frames[i - 1]!.timestampSeconds,
			)
		)
			ctx.addIssue({ code: "custom", message: "frame_order_invalid" });
	});
export const ocrState = z.enum([
	"queued",
	"starting",
	"running",
	"cancelling",
	"completed",
	"failed",
	"cancelled",
]);
export const ocrRecord = z.object({
	id: z.uuid(),
	conversationId: z.string(),
	name: z.string(),
	mime: inputMime,
	state: ocrState,
	revision: z.number().int(),
	progress: z.unknown().nullable(),
	errorCode: z.string().nullable(),
	result: ocrResult.nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
	canRecheck: z.boolean().optional(),
});
export type OcrRecord = z.infer<typeof ocrRecord>;
export type OcrResult = z.infer<typeof ocrResult>;
export const upstreamId = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[a-zA-Z0-9_-]+$/);
export const acceptedJob = z.object({
	id: upstreamId,
	statusUrl: z.string().max(2048),
});
export const jobResult = z
	.object({
		id: upstreamId.optional(),
		status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
		progress: z.unknown().optional(),
		result: ocrResult.nullish(),
		error: z.unknown().optional(),
	})
	.refine((j) => j.status !== "completed" || !!j.result);
export type Connection = {
	revision: number;
	baseUrl: string;
	credential: string;
	credentialVersion?: string;
};
export const errorStatus = {
	ocr_not_found: 404,
	ocr_not_ready: 409,
	ocr_not_configured: 503,
	ocr_capacity: 429,
	ocr_text_too_large: 413,
	ocr_connection_changed: 409,
	ocr_correction_not_found: 404,
	ocr_correction_not_ready: 409,
	ocr_correction_capacity: 429,
	ocr_correction_unavailable: 503,
	ocr_correction_text_too_large: 413,
} as const;
