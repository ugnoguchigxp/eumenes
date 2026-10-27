import { z } from "zod";
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
const detectedObject = z
	.object({
		classId: z.number().int().min(0).max(79),
		label: z.string().min(1).max(120),
		confidence: z.number().finite().min(0).max(1),
		box: z.tuple([
			z.number().nonnegative(),
			z.number().nonnegative(),
			z.number().nonnegative(),
			z.number().nonnegative(),
		]),
	})
	.refine(({ box }) => box[2] >= box[0] && box[3] >= box[1]);
const objects = z.array(detectedObject).max(1000);
export const imageResult = z.object({
	kind: z.literal("image"),
	model: z.string().min(1).max(200),
	width: dimension,
	height: dimension,
	objects,
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
			z.object({ timestampSeconds: z.number().nonnegative().max(30), objects }),
		)
		.max(60),
});
export const detectionResult = z
	.union([imageResult, videoResult])
	.superRefine((r, c) => {
		const width = r.kind === "image" ? r.width : r.video.width;
		const height = r.kind === "image" ? r.height : r.video.height;
		const groups =
			r.kind === "image" ? [r.objects] : r.frames.map((f) => f.objects);
		if (
			groups.some((group) =>
				group.some((o) => o.box[2] > width || o.box[3] > height),
			)
		)
			c.addIssue({ code: "custom", message: "box_outside_source" });
		if (
			r.kind === "video" &&
			r.frames.some(
				(f, i) =>
					i > 0 && f.timestampSeconds <= r.frames[i - 1]!.timestampSeconds,
			)
		)
			c.addIssue({ code: "custom", message: "frame_order_invalid" });
	});
const recognitionState = z.enum([
	"queued",
	"starting",
	"running",
	"cancelling",
	"completed",
	"failed",
	"cancelled",
]);
export const recognitionRecord = z.object({
	id: z.uuid(),
	conversationId: z.string(),
	name: z.string(),
	mime: inputMime,
	state: recognitionState,
	revision: z.number().int(),
	progress: z.unknown().nullable(),
	errorCode: z.string().nullable(),
	result: detectionResult.nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
	canRecheck: z.boolean().optional(),
	/** How the still or video was taken; absent on records saved before it was recorded. */
	origin: z.enum(["camera", "screen", "file"]).optional(),
	captureSave: z.enum(["queued", "saved", "failed", "unconfirmed"]).optional(),
});
export type RecognitionRecord = z.infer<typeof recognitionRecord>;
const upstreamId = z
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
		result: detectionResult.nullish(),
		error: z.unknown().optional(),
	})
	.refine((j) => j.status !== "completed" || !!j.result);
export type Connection = {
	revision: number;
	baseUrl: string;
	credential: string;
	credentialVersion?: string;
};
/**
 * A host-issued request to show an image to the conversation model: a camera or screen still the
 * user agreed to (the screen takes it), or a saved image on screen ("saved"). The id is the run's.
 */
export const handoff = z.object({
	id: z.string(),
	conversationId: z.string(),
	source: z.enum(["camera", "screen", "saved"]),
	recognitionId: z.string().nullable(),
	question: z.string(),
	state: z.enum(["pending", "sent", "cancelled", "expired"]),
	deadline: z.number(),
});
export type Handoff = z.infer<typeof handoff>;
export const handoffLifetimeMs = 120_000;
export const errorStatus = {
	recognition_not_found: 404,
	recognition_not_ready: 409,
	recognition_image_required: 409,
	recognition_handoff_not_found: 404,
	recognition_handoff_closed: 409,
	recognition_not_configured: 503,
	recognition_capacity: 429,
	capture_save_connection_changed: 409,
	capture_save_unavailable: 409,
} as const;
