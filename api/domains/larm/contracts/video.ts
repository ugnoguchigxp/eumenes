import { z } from "zod";

const code = z.string().regex(/^[a-z][a-z0-9_]{0,127}$/);
const address = z.string().min(1).max(2048);
export const videoId = z.string().regex(/^video_[a-f0-9]{32}$/);
export const videoSeed = z.number().int().min(0).max(2_147_483_647);
// LARM measures string lengths in characters.
const text = (max: number) =>
	z
		.string()
		.trim()
		.min(1)
		.refine((v) => Array.from(v).length <= max);

const videoDimension = z.number().int().positive();
const videoDuration = z.number().positive();
export const videoSize = z.object({
	width: videoDimension,
	height: videoDimension,
});
export const videoOptions = z.object({
	sizes: videoSize.array().min(1).max(64),
	durations: videoDuration.array().min(1).max(32),
});
export type VideoOptions = z.infer<typeof videoOptions>;

export const videoInput = z
	.strictObject({
		prompt: text(8192),
		title: text(256).optional(),
		seed: videoSeed.optional(),
		width: videoDimension.optional(),
		height: videoDimension.optional(),
		durationSeconds: videoDuration.optional(),
	})
	.refine((v) => (v.width === undefined) === (v.height === undefined));
export type VideoInput = z.infer<typeof videoInput>;
export const videoArtifact = z.object({
	id: videoId,
	title: z.string(),
	createdAt: z.iso.datetime({ offset: true }),
	model: z.string(),
	modelRevision: z.string(),
	quantization: z.string(),
	engineSha256: z.string(),
	sha256: z.string(),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	durationSeconds: z.number().positive(),
	fps: z.number().positive(),
	frames: z.number().int().positive(),
	steps: z.number().int().positive(),
	seed: videoSeed,
	mimeType: z.literal("video/mp4"),
	bytes: z
		.number()
		.int()
		.positive()
		.max(64 * 1024 * 1024),
	contentUrl: address,
	metadataUrl: address,
});
export const videoList = z.object({ videos: videoArtifact.array() });
export const videoMetadata = videoArtifact.extend({ request: z.unknown() });
export const videoStatus = z.enum([
	"queued",
	"running",
	"completed",
	"failed",
	"cancelled",
]);
export const videoJob = z.object({
	jobId: videoId,
	status: videoStatus,
	phase: code.optional(),
	updatedAt: z.iso.datetime({ offset: true }),
	statusUrl: address,
	eventsUrl: address,
	result: videoArtifact.optional(),
	error: z.object({ code }).optional(),
});
export type VideoJob = z.infer<typeof videoJob>;
export type VideoArtifact = z.infer<typeof videoArtifact>;
