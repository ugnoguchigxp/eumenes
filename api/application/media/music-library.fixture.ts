import { answerAnalysis } from "../toolchain/analysis-round.fixture";
import { readFileSync } from "node:fs";
import { createLarmPlayground, type LarmPort } from "../../domains/larm";
export const playbackQuestion = "bright pianoの保存曲をタグで探して聴きたい";
export const playbackPlan = {
	title: "明るいピアノ",
	q: "",
	tags: ["明るい", "ピアノ"],
	favorite: null,
	sort: "createdAt",
	order: "desc",
};
export function musicLibraryFixture(correctablePlan = false) {
	const requests: {
		path: string;
		method: string;
		query: string;
		range: string | null;
		auth: string | null;
	}[] = [];
	const audio = readFileSync(
		new URL("../../../tests/browser/fixtures/silence.opus", import.meta.url),
	);
	const tracks = ["one", "two", "three"].map((id, i) => ({
		id,
		title: `ピアノ ${id}`,
		prompt: "bright fast-paced piano",
		tags:
			i === 2 ? ["落ち着いた", "ピアノ"] : ["明るい", "ピアノ", "アップテンポ"],
		instrumental: true,
		model: "fixture",
		format: "opus",
		durationSeconds: 30,
		createdAt: new Date(1000 + i * 1000).toISOString(),
		favorite: false,
		audioUrl: `/v1/music/tracks/${id}/audio`,
		metadataUrl: `/v1/music/tracks/${id}/metadata`,
	}));
	const stages: string[] = [];
	let failure: number | undefined;
	const gateway = () =>
		createLarmPlayground({
			baseUrl: "http://127.0.0.1:9999/v1",
			token: "control-fixture",
			profile: "fixture",
			audience: "test",
			fetch: (async (url, init = {}) => {
				const u = new URL(String(url)),
					method = init.method ?? "GET",
					headers = new Headers(init.headers);
				requests.push({
					path: u.pathname,
					method,
					query: u.search,
					range: headers.get("range"),
					auth: headers.get("authorization"),
				});
				if (failure)
					return Response.json(
						{
							error: {
								code: failure === 507 ? "music_storage_full" : "fixture_error",
								message: "契約のエラー",
							},
						},
						{ status: failure },
					);
				if (u.pathname === "/v1/music/tags")
					return Response.json({
						tags: [
							{ tag: "ピアノ", count: tracks.length },
							{ tag: "明るい", count: 2 },
							{ tag: "アップテンポ", count: 2 },
						],
					});
				if (u.pathname === "/v1/music/tracks") {
					const tags = u.searchParams.get("tags")?.split(",") ?? [];
					const q = u.searchParams.get("q") ?? "";
					let found = tracks.filter(
						(t) =>
							tags.every((tag) => t.tags.includes(tag)) && t.title.includes(q),
					);
					if (u.searchParams.has("favorite"))
						found = found.filter(
							(t) => t.favorite === (u.searchParams.get("favorite") === "true"),
						);
					found.sort((a, b) =>
						u.searchParams.get("order") === "asc"
							? a.createdAt.localeCompare(b.createdAt)
							: b.createdAt.localeCompare(a.createdAt),
					);
					const offset = Number(u.searchParams.get("cursor") ?? 0),
						limit = Number(u.searchParams.get("limit") ?? 50);
					return Response.json({
						tracks: found.slice(offset, offset + limit),
						total: found.length,
						...(offset + limit < found.length
							? { nextCursor: String(offset + limit) }
							: {}),
					});
				}
				const id = u.pathname.split("/")[4];
				const t = tracks.find((t) => t.id === id);
				if (!t)
					return Response.json(
						{ error: { code: "track_not_found", message: "削除済みです" } },
						{ status: 404 },
					);
				if (u.pathname.endsWith("/favorite")) {
					t.favorite = method === "PUT";
					return new Response(null, { status: 204 });
				}
				if (method === "DELETE") {
					tracks.splice(tracks.indexOf(t), 1);
					return new Response(null, { status: 204 });
				}
				if (u.pathname.endsWith("/metadata"))
					return Response.json({ id: t.id, prompt: t.prompt });
				if (u.pathname.endsWith("/audio")) {
					const range = headers.get("range"),
						match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
					const start = match ? Number(match[1]) : 0,
						end =
							match && match[2]
								? Math.min(Number(match[2]), audio.length - 1)
								: audio.length - 1;
					if (start >= audio.length)
						return new Response(null, {
							status: 416,
							headers: { "Content-Range": `bytes */${audio.length}` },
						});
					return new Response(audio.subarray(start, end + 1), {
						status: range ? 206 : 200,
						headers: {
							"Content-Type": "audio/ogg; codecs=opus",
							"Accept-Ranges": "bytes",
							"Content-Length": String(end - start + 1),
							...(range
								? { "Content-Range": `bytes ${start}-${end}/${audio.length}` }
								: {}),
						},
					});
				}
				return Response.json(t);
			}) as typeof fetch,
		});
	const model: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		close: async () => {},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		answer: async (messages, _signal, options) => {
			if (
				answerAnalysis(options, {
					call: "music_library",
					announcement: "準備します。",
					kind: "action",
				})
			)
				return "";
			if (options?.tools?.length) {
				stages.push("route");
				if (!options.tools.some((t) => t.function.name === "music_library"))
					throw new Error("playback_not_offered");
				options.onToolCalls!([
					{
						id: "playback",
						name: "music_library",
						arguments: JSON.stringify({
							request: playbackQuestion,
						}),
					},
				]);
				return "";
			}
			if (messages[0]!.content.includes("OUTPUT_SCHEMA=")) {
				stages.push("plan");
				if (!messages[1]!.content.includes("libraryTags"))
					throw new Error("tags_missing");
				const plan = JSON.stringify(playbackPlan);
				return correctablePlan ? plan.slice(0, -1) + ",}" : plan;
			}
			stages.push("answer");
			const result = JSON.parse(
				messages.find((m) => m.content.includes('"musicResult":'))!.content,
			).musicResult;
			return result.state === "completed"
				? "保存曲のプレイリストを開きました。"
				: "保存曲を取得できませんでした。";
		},
	};
	return {
		gateway,
		model,
		tracks,
		audio,
		requests,
		stages,
		setFailure: (status: number | undefined) => {
			failure = status;
		},
	};
}
