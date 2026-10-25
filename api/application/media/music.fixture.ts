import { musicProviderFixture } from "../../domains/larm/test/music-generation.fixture";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createLarmPlayground, type LarmPort } from "../../domains/larm";
import { png } from "./image.fixture";
import {
	answerUtterance,
	handOver,
} from "./conversation-turn.fixture";
export const musicQuestion = "Tetrisをテーマにした30秒の楽曲を作って";
export const musicTestPlan = {
	title: "落ちるブロックのリズム",
	description: "軽快なチップチューンを短い構成で。",
	prompt:
		"An instrumental chiptune inspired by falling blocks, bright square wave melody, lively arpeggios and a clear ending.",
	durationSeconds: 30,
	task: "music",
	instrumental: true,
};
export function musicFixture(
	mode:
		| "success"
		| "failure"
		| "cancel"
		| "invalid-plan"
		| "correctable-plan" = "success",
	fixtureOptions: {
		plan?: Record<string, unknown>;
		artworkFailure?: boolean;
		jobStatuses?: string[];
		postStatus?: number;
	} = {},
) {
	const requests: Array<{ method: string; path: string; body: unknown }> = [];
	const stages: string[] = [];
	const statuses = [...(fixtureOptions.jobStatuses ?? ["completed"])];
	const audio = new Uint8Array(
		readFileSync(
			new URL("../../../tests/browser/fixtures/silence.opus", import.meta.url),
		),
	);
	const artwork = png(256, 256);
	const imageService = {
		name: "image",
		capability: "media.image.generate",
		protocol: "larm.image-generation.v1",
		endpoint: "/v1/images/generations",
		url: "/v1/images/generations",
		model: "fixture-image",
		description: "Image service, synchronous POST, exact dimensions, PNG/WebP",
	};
	const gateway = () =>
		createLarmPlayground({
			baseUrl: "http://127.0.0.1:9999",
			token: "fixture-token",
			profile: "fixture",
			audience: "test",
			pollMs: 1,
			fetch: (async (url, init = {}) => {
				const u = new URL(String(url));
				const path = u.pathname;
				const method = init.method ?? "GET";
				const body =
					typeof init.body === "string" ? JSON.parse(init.body) : null;
				requests.push({ path, method, body });
				if (path === "/v3/agent-profiles") {
					const selector = u.searchParams.get("profile");
					// The unselected catalog lists the profiles without services; fetched by id they carry them.
					const profiles = [
						{
							id: "image-profile",
							providers: [],
							services: [imageService],
						},
						{
							id: "music-profile",
							providers: [],
							services: [
								{
									name: "music",
									model: "fixture-music",
									protocol: "larm.music-generation.v1",
									capability: "media.music.generate",
									endpoint: "/v1/music/generations",
								},
							],
						},
					];
					return Response.json({
						contractVersion: "agent-connection.v3",
						catalogRevision: "1",
						requestedProfile: selector,
						profiles: selector
							? profiles.filter((p) => p.id === selector)
							: profiles.map((p) => ({ ...p, services: [] })),
					});
				}
				if (path === "/v1/agent-connections")
					return Response.json(
						{
							id: "image-connection",
							agentProfile: "image-profile",
							catalogRevision: "1",
							status: "ready",
							providers: [],
							services: [imageService],
						},
						{ status: 201 },
					);
				if (
					path === "/v1/agent-connections/image-connection" &&
					init.method === "DELETE"
				)
					return new Response(null, { status: 204 });
				if (path === "/v1/images/generations")
					return fixtureOptions.artworkFailure
						? new Response(null, { status: 503 })
						: Response.json({
								status: "succeeded",
								artifact: {
									id: "artwork",
									width: body.width,
									height: body.height,
									format: "png",
									mimeType: "image/png",
									createdAt: "2026-10-14T00:00:00Z",
									hasAlpha: false,
									bytes: artwork.length,
									sha256: createHash("sha256").update(artwork).digest("hex"),
									model: "fixture-image",
									contentUrl: "/v1/image-artifacts/artwork/content",
								},
							});
				if (path === "/v1/image-artifacts/artwork" && method === "DELETE")
					return Response.json({ id: "artwork", deleted: true });
				if (path === "/v1/image-artifacts/artwork/content")
					return new Response(artwork, {
						headers: { "Content-Type": "image/png" },
					});
				if (path === "/v1/music/providers")
					return Response.json(musicProviderFixture);
				if (path === "/v1/music/generations") {
					if (fixtureOptions.postStatus)
						return Response.json(
							{ error: "invalid_request" },
							{ status: fixtureOptions.postStatus },
						);
					if (mode === "failure")
						return Response.json({ error: "unavailable" }, { status: 503 });
					return Response.json(
						{ jobId: "track", status: "queued" },
						{ status: 202 },
					);
				}
				if (path.endsWith("/track") && method === "DELETE")
					return Response.json({ jobId: "track", status: "cancelled" });
				if (path.endsWith("/track")) {
					if (mode === "cancel")
						await new Promise((_, reject) => {
							const signal = init.signal!;
							if (signal.aborted) reject(new Error("aborted"));
							else
								signal.addEventListener(
									"abort",
									() => reject(new Error("aborted")),
									{ once: true },
								);
						});
					return Response.json({
						jobId: "track",
						status: statuses.length > 1 ? statuses.shift() : statuses[0],
						result: {
							id: "track",
							model: "fixture-runtime-model",
							provider: "local-audio",
							metadata: { runtime: "fixture-runtime" },
							durationSeconds:
								fixtureOptions.plan?.durationSeconds ??
								(fixtureOptions.plan?.task === "sound-effect"
									? 5
									: fixtureOptions.plan?.instrumental === false
										? 180
										: 120),
							format: "opus",
							audioUrl: "/v1/music/generations/track/audio",
							metadataUrl: "/v1/music/generations/track/metadata",
						},
					});
				}
				if (path.endsWith("/metadata")) return Response.json({ id: "track" });
				if (path.endsWith("/audio"))
					return new Response(audio, {
						headers: { "content-type": "audio/ogg; codecs=opus" },
					});
				throw new Error("unexpected_fixture_request");
			}) as typeof fetch,
		});
	const model: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		close: async () => {},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		answer: async (messages, _signal, options) => {
			const turn = answerUtterance(
				options?.tools,
				messages,
				options?.onToolCalls,
				handOver("music.create", "準備します。"),
				() => stages.push("route"),
			);
			if (turn !== undefined) return turn;
			if (messages[0]!.content.includes("OUTPUT_SCHEMA=")) {
				stages.push("plan");
				if (mode === "invalid-plan") return "{}";
				const plan = JSON.stringify(fixtureOptions.plan ?? musicTestPlan);
				return mode === "correctable-plan" ? plan.slice(0, -1) + ",}" : plan;
			}
			throw new Error("fixture_unexpected_model_call");
		},
	};
	return { model, gateway, requests, stages, audio, artwork };
}
