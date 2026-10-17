import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createLarmPlayground, type LarmPort } from "../../domains/larm";
import { png } from "./image.fixture";
export const musicQuestion = "Tetrisをテーマにした30秒の楽曲を作って";
export const musicTestPlan = {
	title: "落ちるブロックのリズム",
	description: "軽快なチップチューンを短い構成で。",
	prompt:
		"An instrumental chiptune inspired by falling blocks, bright square wave melody, lively arpeggios and a clear ending.",
	durationSeconds: 30,
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
		question?: string;
		artworkFailure?: boolean;
	} = {},
) {
	const requests: Array<{ method: string; path: string; body: unknown }> = [];
	const stages: string[] = [];
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
				if (path === "/v1/music/generations") {
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
						status: "completed",
						result: {
							id: "track",
							model: "fixture-music",
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
			if (options?.tools?.[0]?.function.name === "find_toolchain") {
				options.onToolCalls!([
					{ id: "discovery", name: "find_toolchain", arguments: "{}" },
				]);
				return "";
			}
			if (options?.tools?.length) {
				stages.push("route");
				options.onToolCalls!([
					{
						id: "music",
						name: "music",
						arguments: JSON.stringify({
							announcement: "準備します。",
							request: fixtureOptions.question ?? musicQuestion,
						}),
					},
				]);
				return "";
			}
			if (messages[0]!.content.includes("OUTPUT_SCHEMA=")) {
				stages.push("plan");
				if (mode === "invalid-plan") return "{}";
				const plan = JSON.stringify(fixtureOptions.plan ?? musicTestPlan);
				return mode === "correctable-plan" ? plan.slice(0, -1) + ",}" : plan;
			}
			stages.push("answer");
			const result = messages.find((m) => m.content.includes('"musicResult":'));
			if (!result) throw new Error("music_result_missing");
			return JSON.parse(result.content).musicResult.state === "completed"
				? "楽曲ができました。"
				: "楽曲を生成できませんでした。";
		},
	};
	return { model, gateway, requests, stages, audio, artwork };
}
