import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVideoClient } from "../../larm";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { openStore } from "../../../infrastructure/sqlite";
import { createVideo, migrations } from "..";

import { artifact, job, videoId } from "./sample.fixture";
export { artifact, job, videoId } from "./sample.fixture";
const statusUrl = artifact.contentUrl.slice(0, -"/content".length);
export function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "eumenes-video-"));
	const path = join(directory, "db");
	const state = {
		job: job("queued"),
		model: "fixture-model",
		loseFirst: false,
		disconnectPoll: false,
		saved: true,
		busy: false,
		retrySeconds: 2,
		width: { const: 480 } as { const: number } | { enum: number[] },
		height: { const: 480 },
		duration: { const: 5 } as { const: number } | { enum: number[] },
	};
	const requests: {
		path: string;
		method: string;
		auth: string | null;
		key: string | null;
		bytes: unknown;
		range: string | null;
		at: number;
	}[] = [];
	const accepted = new Set<string>();
	const remote = createVideoClient({
		baseUrl: "http://127.0.0.1:12937",
		token: "control-fixture",
		fetch: (async (url, init = {}) => {
			const path = new URL(String(url)).pathname;
			const method = init.method ?? "GET";
			const h = new Headers(init.headers);
			const key = h.get("Idempotency-Key");
			requests.push({
				path,
				method,
				key,
				auth: h.get("Authorization"),
				bytes: init.body,
				range: h.get("Range"),
				at: Date.now(),
			});
			if (h.get("Authorization") !== "Bearer control-fixture")
				return Response.json(
					{ error: { code: "unauthorized" } },
					{ status: 401 },
				);
			if (path === "/v3/agent-profiles")
				return Response.json({
					contractVersion: "agent-connection.v3",
					services: [
						{
							capability: "media.video.generate",
							protocol: "larm.video-generation.v1",
							model: state.model,
							description: "Fixture MP4 generation",
							endpoint: "/v1/videos/generations",
						},
					],
				});
			if (path === "/openapi.json")
				return Response.json({
					paths: {
						"/v1/videos/generations": {
							post: {
								requestBody: {
									content: {
										"application/json": {
											schema: {
												$ref: "#/components/schemas/VideoGenerationRequest",
											},
										},
									},
								},
							},
						},
					},
					components: {
						schemas: {
							VideoGenerationRequest: {
								properties: {
									width: state.width,
									height: state.height,
									durationSeconds: state.duration,
								},
							},
						},
					},
				});
			if (path === "/v1/videos/generations" && method === "POST") {
				if (state.busy)
					return Response.json(
						{ error: { code: "on_demand_busy", message: "private" } },
						{ status: 409 },
					);
				accepted.add(key!);
				if (state.loseFirst) {
					state.loseFirst = false;
					throw new TypeError("fixture disconnected");
				}
				return Response.json(state.job, {
					status: 202,
					headers: { "Retry-After": String(state.retrySeconds) },
				});
			}
			if (path === statusUrl) {
				if (method === "DELETE")
					state.job = job("running", "stopping", { result: artifact });
				else if (state.disconnectPoll) {
					state.disconnectPoll = false;
					throw new TypeError("fixture status disconnected");
				}
				return Response.json(state.job, {
					headers: { "Retry-After": String(state.retrySeconds) },
				});
			}
			if (path === "/v1/videos")
				return Response.json({ videos: state.saved ? [artifact] : [] });
			if (path === `/v1/videos/${videoId}` && method === "DELETE") {
				state.saved = false;
				return new Response(null, { status: 204 });
			}
			if (path === artifact.metadataUrl)
				return Response.json({
					...artifact,
					request: {
						prompt: "text",
						seed: 42,
						model: "fixture-model",
						width: 480,
					},
				});
			if (path === artifact.contentUrl) {
				const range = h.get("Range") === "bytes=0-3";
				return new Response(
					range ? new Uint8Array([0, 0, 0, 16]) : new Uint8Array(16),
					{
						status: range ? 206 : 200,
						headers: {
							"Content-Type": "video/mp4",
							"Accept-Ranges": "bytes",
							...(range ? { "Content-Range": "bytes 0-3/16" } : {}),
						},
					},
				);
			}
			throw new Error("unexpected_fixture_request");
		}) as typeof fetch,
	});
	function open() {
		const store = openStore(path, [...queueMigrations, ...migrations]);
		const queue = createQueue(store, { pollMs: 5 });
		const service = createVideo({ store, queue, port: () => remote });
		queue.start();
		return {
			store,
			queue,
			service,
			async close() {
				await queue.close();
				await store.close();
			},
		};
	}
	return {
		open,
		remote,
		state,
		requests,
		accepted,
		dispose: () => rmSync(directory, { recursive: true, force: true }),
	};
}
