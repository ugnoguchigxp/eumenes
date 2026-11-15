import type { VideoJob } from "../../larm/contracts";

export const videoId = "video_" + "a".repeat(32);
const statusUrl = `/v1/videos/generations/${videoId}`;
export const artifact = {
	id: videoId,
	title: "テスト動画",
	model: "fixture-model",
	modelRevision: "a".repeat(40),
	engineSha256: "b".repeat(64),
	sha256: "c".repeat(64),
	quantization: "fixture-quantization",
	createdAt: "2026-11-14T00:00:00Z",
	width: 480,
	height: 480,
	durationSeconds: 5,
	fps: 24,
	frames: 120,
	steps: 4,
	seed: 42,
	bytes: 16,
	mimeType: "video/mp4" as const,
	contentUrl: statusUrl + "/content",
	metadataUrl: statusUrl + "/metadata",
};
export const job = (
	status: VideoJob["status"],
	phase = status as string,
	extra: Partial<VideoJob> = {},
): VideoJob => ({
	jobId: videoId,
	statusUrl,
	eventsUrl: statusUrl + "/events",
	status,
	phase,
	updatedAt: new Date().toISOString(),
	...extra,
});
