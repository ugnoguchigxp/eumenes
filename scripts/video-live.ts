/**
 * Makes one real video with the saved LARM Control, via the Eumenes API handlers in-process.
 * A test video is deleted only after its content and metadata have been checked.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createApp } from "../api/application/app";
import { registerVideoAdmission } from "../api/application/media/video-admission";
import { createVideoClient } from "../api/domains/larm";
import {
	createQueue,
	migrations as queueMigrations,
} from "../api/domains/queue";
import { createVideo, migrations, registerVideo } from "../api/domains/video";
import {
	videoMetadataView,
	videoRequestView,
	videoWorkspace,
} from "../api/domains/video/contracts";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import { openStore } from "../api/infrastructure/sqlite";
import { liveLarmSettings } from "./live-larm";

if (!process.argv.includes("--run")) {
	console.log("実生成1本を確認するには bun scripts/video-live.ts --run");
	process.exit(0);
}
const { baseUrl } = liveLarmSettings();
const token = resolveLarmToken(process.env);
if (!baseUrl || !token) throw new Error("larm_connection_unconfigured");
const port = createVideoClient({ baseUrl, token });
const service = await port.discover(AbortSignal.timeout(15000));
const fixtureRoot = mkdtempSync(join(tmpdir(), "eumenes-video-live-"));
const fixtureToken = crypto.randomUUID();
const store = openStore(join(fixtureRoot, "db"), [
	...queueMigrations,
	...migrations,
]);
const queue = createQueue(store, { pollMs: 100 });
const video = createVideo({ store, queue, port: () => port });
const app = createApp({
	token: fixtureToken,
	origin: "http://localhost",
	modules: [
		{
			mount(app) {
				registerVideoAdmission(app, video);
				registerVideo(app, video);
				// Checks the mounted admission gate without starting an unrelated workload.
				app.post("/api/compute/jobs", (c) => c.body(null, 204));
			},
		},
	],
});
function request(path: string, init: RequestInit = {}) {
	return app.request(path, {
		...init,
		headers: { Authorization: `Bearer ${fixtureToken}`, ...init.headers },
	});
}
function requireStatus(response: Response, status: number) {
	if (response.status !== status)
		throw new Error(`unexpected_http_${response.status}_expected_${status}`);
	return response;
}
queue.start();
const id = crypto.randomUUID();
const started = Date.now();
try {
	const before = await port.list(AbortSignal.timeout(15000));
	console.log(
		JSON.stringify({
			phase: "ready",
			model: service.model,
			savedBefore: before.length,
		}),
	);
	const submitted = await request("/api/videos/generations", {
		method: "POST",
		headers: { "Content-Type": "application/json", "Idempotency-Key": id },
		body: JSON.stringify({
			prompt:
				"A small silver cat walks across a sunlit garden. One continuous fixed-camera shot. Gentle birdsong and rustling leaves.",
			title: "Eumenes 動画生成の受入確認",
		}),
	});
	videoRequestView.parse(await requireStatus(submitted, 202).json());
	let last = "";
	const deadline = Date.now() + 20 * 60 * 1000;
	while (Date.now() < deadline) {
		const state = videoWorkspace.parse(
			await (await request("/api/videos/workspace")).json(),
		);
		const r = state.request;
		if (!r || r.id !== id) throw new Error("request_identity_mismatch");
		const phase = r.job?.phase ?? r.state;
		if (phase !== last) {
			last = phase;
			console.log(
				JSON.stringify({
					phase,
					jobId: r.job?.jobId,
					elapsedSeconds: Math.round((Date.now() - started) / 1000),
				}),
			);
		}
		if (r.state === "unconfirmed" || r.state === "rejected")
			throw new Error(r.errorCode ?? "video_acceptance_unconfirmed");
		if (r.state === "tracking") {
			requireStatus(
				await request("/api/compute/jobs", { method: "POST" }),
				409,
			);
		}
		if (r.state !== "finished") {
			await sleep(3000);
			continue;
		}
		if (r.job?.status !== "completed" || !r.job.result)
			throw new Error(r.errorCode ?? "video_generation_failed");
		const item = r.job.result;
		requireStatus(await request("/api/compute/jobs", { method: "POST" }), 204);
		const path = `/api/videos/${item.id}`;
		const range = requireStatus(
			await request(path + "/content", { headers: { Range: "bytes=0-31" } }),
			206,
		);
		if (
			(await range.arrayBuffer()).byteLength !== 32 ||
			range.headers.get("Content-Range") !== `bytes 0-31/${item.bytes}`
		)
			throw new Error("video_range_mismatch");
		const metadata = videoMetadataView.parse(
			await requireStatus(await request(path + "/metadata"), 200).json(),
		);
		const full = requireStatus(await request(path + "/content"), 200);
		const bytes = new Uint8Array(await full.arrayBuffer());
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (bytes.byteLength !== metadata.bytes || digest !== metadata.sha256)
			throw new Error("video_checksum_mismatch");
		const mp4 = join(fixtureRoot, "generated.mp4");
		await Bun.write(mp4, bytes);
		const probe = Bun.spawnSync([
			"ffprobe",
			"-v",
			"error",
			"-show_streams",
			"-of",
			"json",
			mp4,
		]);
		if (probe.exitCode !== 0) throw new Error("video_decode_failed");
		const streams = JSON.parse(probe.stdout.toString()).streams as {
			codec_type: string;
			width?: number;
			height?: number;
			r_frame_rate?: string;
			nb_frames?: string;
			duration?: string;
		}[];
		const picture = streams.find((s) => s.codec_type === "video");
		if (
			picture?.width !== 480 ||
			picture.height !== 480 ||
			picture.r_frame_rate !== "24/1" ||
			picture.nb_frames !== "120" ||
			Number(picture.duration) !== 5 ||
			!streams.some((s) => s.codec_type === "audio")
		)
			throw new Error("video_stream_properties_mismatch");
		// Never delete a video that was present before this single test request.
		if (before.some((v) => v.id === item.id))
			throw new Error("video_not_created_by_test");
		requireStatus(await request(path, { method: "DELETE" }), 204);
		const remaining = await port.list(AbortSignal.timeout(15000));
		if (remaining.some((v) => v.id === item.id))
			throw new Error("video_delete_unconfirmed");
		console.log(
			JSON.stringify({
				phase: "verified",
				range: range.status,
				delete: 204,
				bytes: metadata.bytes,
				shaMatches: true,
				width: picture.width,
				height: picture.height,
				fps: picture.r_frame_rate,
				frames: picture.nb_frames,
				seconds: Number(picture.duration),
				audio: true,
			}),
		);
		break;
	}
	if (Date.now() >= deadline) throw new Error("video_follow_deadline_exceeded");
} finally {
	await queue.close();
	await store.close();
	rmSync(fixtureRoot, { recursive: true, force: true });
}
