import { z } from "zod";
export const perceptionTask = z.enum([
	"describe",
	"referring",
	"detection",
	"count_box",
	"segmentation",
	"matting",
	"ocr",
	"ocr_grounding",
]);
export const perceptionOptions = z
	.strictObject({
		task: perceptionTask,
		query: z.union([
			z.string().max(2048),
			z.array(z.string().min(1).max(128)).min(1).max(32),
		]),
		maxNewTokens: z.number().int().min(16).max(512).optional(),
	})
	.superRefine((v, c) => {
		if (
			(Array.isArray(v.query) && v.task !== "detection") ||
			(typeof v.query === "string" && !v.query.trim() && v.task !== "ocr")
		)
			c.addIssue({ code: "custom", message: "invalid_visual_query" });
	});
const dim = z.number().int().positive().max(8192);
const ms = z.number().finite().nonnegative();
const positiveTokens = z.number().int().positive();
const perceptionExecution = z.discriminatedUnion("backend", [
	z.strictObject({
		device: z.literal("cuda:0"),
		backend: z.literal("transformers"),
		dtype: z.literal("bfloat16"),
		decoderDtype: z.literal("float32"),
		outputTokens: positiveTokens,
		visualTokens: positiveTokens,
	}),
	z.strictObject({
		device: z.literal("cpu"),
		backend: z.literal("llama.cpp"),
		dtype: z.literal("qad-q4_0"),
		decoderDtype: z.null(),
		outputTokens: z.number().int().nonnegative(),
		visualTokens: positiveTokens,
		inputTokens: positiveTokens,
	}),
]);
export const perceptionResult = z
	.strictObject({
		contractVersion: z.literal("larm.visual-perception.v1"),
		model: z.string().min(1).max(128),
		modelRevision: z.string().regex(/^[a-f0-9]{40}$/),
		task: perceptionTask,
		image: z.strictObject({
			width: dim,
			height: dim,
			orientation: z.literal("exif-normalized"),
		}),
		response: z.string().max(65536),
		detections: z
			.array(
				z.strictObject({
					label: z.string().max(4096),
					box: z.tuple([ms, ms, ms, ms]),
					text: z.string().max(4096).optional(),
				}),
			)
			.max(128),
		masks: z
			.array(
				z.strictObject({
					detectionIndex: z.number().int().min(0).max(127),
					encoding: z.literal("png-base64"),
					mode: z.enum(["binary", "alpha"]),
					width: dim,
					height: dim,
					// List/detail APIs strip mask data; the provider boundary validates actual base64 and PNG bytes.
					data: z.string().max(5_600_000),
				}),
			)
			.max(8),
		count: z.number().int().nonnegative().optional(),
		truncated: z.boolean(),
		timings: z.strictObject({
			imageDecodeMs: ms,
			preprocessMs: ms,
			generationMs: ms,
			maskMs: ms,
			postprocessMs: ms,
			totalMs: ms,
		}),
		execution: perceptionExecution,
	})
	.superRefine((v, c) => {
		if (
			v.execution.backend === "llama.cpp" &&
			(v.task !== "describe" ||
				v.detections.length !== 0 ||
				v.masks.length !== 0 ||
				Object.hasOwn(v, "count") ||
				v.execution.visualTokens >= v.execution.inputTokens)
		)
			c.addIssue({ code: "custom", message: "invalid_visual_cpu_result" });
		if (
			v.image.width * v.image.height > 4194304 ||
			v.detections.some(
				({ box: [x, y, x2, y2] }) =>
					x2 < x || y2 < y || x2 > v.image.width || y2 > v.image.height,
			) ||
			v.masks.some(
				(m) =>
					m.detectionIndex >= v.detections.length ||
					(v.task !== "segmentation" && v.task !== "matting") ||
					(v.task === "segmentation" && m.mode !== "binary") ||
					(v.task === "matting" && m.mode !== "alpha") ||
					m.width !== v.image.width ||
					m.height !== v.image.height,
			) ||
			(v.task === "describe" && v.detections.length > 0) ||
			(v.count !== undefined &&
				(v.task !== "count_box" ||
					v.truncated ||
					v.count !== v.detections.length))
		)
			c.addIssue({ code: "custom", message: "invalid_visual_result" });
	});
export type PerceptionOptions = z.infer<typeof perceptionOptions>;
export type PerceptionResult = z.infer<typeof perceptionResult>;
export const analysisCreate = z
	.strictObject({
		requestId: z.uuid(),
		conversationId: z.string().min(1).max(120),
		expectedRevision: z.number().int().nonnegative(),
		frameIndex: z.number().int().min(0).max(59).optional(),
		task: perceptionTask,
		query: z.union([
			z.string().max(2048),
			z.array(z.string().min(1).max(128)).min(1).max(32),
		]),
		maxNewTokens: z.number().int().min(16).max(512).optional(),
	})
	.refine(
		(v) =>
			perceptionOptions.safeParse({
				task: v.task,
				query: v.query,
				maxNewTokens: v.maxNewTokens,
			}).success,
	);
export type AnalysisCreate = z.infer<typeof analysisCreate>;
export const stopObservationSchema = z.object({
	status: z.enum(["observing", "cold", "unconfirmed"]),
	connectionId: z.string().max(160),
	allocationId: z.string().max(160).optional(),
	runtimeId: z.string().max(160).optional(),
	releasedAt: z.string().optional(),
	observedAt: z.string().optional(),
	checkedAt: ms,
	reason: z
		.enum([
			"release_unconfirmed",
			"runtime_unknown",
			"observation_failed",
			"observation_timeout",
			"observation_interrupted",
		])
		.optional(),
});
export type StopObservation = z.infer<typeof stopObservationSchema>;
export const analysisRecordSchema = z.object({
	id: z.uuid(),
	sourceId: z.uuid(),
	sourceRevision: z.number().int().nonnegative(),
	frameIndex: z.number().int().min(0).max(59).nullable(),
	timestamp: ms.nullable(),
	actualTimestamp: ms.nullable(),
	sourceDigest: z.string().min(1),
	settingsVersion: z.string().min(1),
	options: perceptionOptions,
	state: z.enum([
		"queued",
		"starting",
		"running",
		"completed",
		"failed",
		"cancelling",
		"cancelled",
	]),
	result: perceptionResult.nullable(),
	errorCode: z.string().nullable(),
	releaseConfirmed: z.boolean().nullable(),
	stopObservation: stopObservationSchema.optional(),
	waitingMs: ms.nullable(),
	inferenceMs: ms.nullable(),
	elapsedMs: ms.nullable(),
	createdAt: ms,
	updatedAt: ms,
});
export type AnalysisRecord = z.infer<typeof analysisRecordSchema>;
export type PerceptionPort = {
	version: () => string;
	perceive: (
		image: { bytes: Uint8Array; mime: string; width: number; height: number },
		options: PerceptionOptions,
		signal: AbortSignal,
		progress: (
			phase:
				| "running"
				| "connection"
				| "released"
				| "release_failed"
				| "lifecycle",
			value?: string,
			observation?: StopObservation,
		) => Promise<void>,
	) => Promise<{
		result: PerceptionResult;
		waitingMs: number;
		inferenceMs: number;
		elapsedMs: number;
		releaseConfirmed: boolean;
	}>;
	release: (id: string) => Promise<void>;
};
export const analysisErrors = {
	analysis_not_found: 404,
	analysis_not_ready: 409,
	analysis_busy: 409,
	analysis_source_changed: 409,
	analysis_connection_changed: 409,
	analysis_unconfigured: 503,
	analysis_image_too_large: 413,
} as const;
