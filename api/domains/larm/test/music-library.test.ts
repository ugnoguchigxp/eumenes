import { expect, test } from "bun:test";
import { createLarmPlayground, trackQuery } from "..";
import { trackQueryParams } from "../contracts/music-library";
test("Unicode query and cursor are encoded without changing conditions", () => {
	const query = trackQuery.parse({
		q: "明るい piano",
		tags: ["明るい", "ピアノ"],
		favorite: true,
		sort: "relevance",
		order: "desc",
		cursor: "次 /+=",
	});
	const p = trackQueryParams(query);
	expect(p.get("q")).toBe(query.q);
	expect(p.get("tags")).toBe("明るい,ピアノ");
	expect(p.get("cursor")).toBe(query.cursor!);
	expect(trackQueryParams(trackQuery.parse({})).has("tags")).toBe(false);
	expect(() =>
		trackQuery.parse({ tags: Array(9).fill("x".repeat(64)) }),
	).toThrow();
});
test("track references cannot send Control authentication to another origin", async () => {
	const requests: string[] = [];
	const g = createLarmPlayground({
		baseUrl: "http://127.0.0.1:9999/v1",
		token: "control",
		profile: "unused",
		audience: "unused",
		fetch: (async (url) => {
			requests.push(String(url));
			return Response.json({
				id: "one",
				title: "曲",
				tags: [],
				prompt: "piano",
				instrumental: true,
				model: "fixture",
				format: "opus",
				durationSeconds: 30,
				createdAt: new Date().toISOString(),
				favorite: false,
				audioUrl: "http://127.0.0.1:9998/v1/music/tracks/one/audio",
				metadataUrl: "/v1/music/tracks/one/metadata",
			});
		}) as typeof fetch,
	});
	await expect(
		g.library.audio("one", undefined, AbortSignal.timeout(1000)),
	).rejects.toThrow("invalid_artifact_origin");
	expect(requests).toHaveLength(1);
	expect(requests[0]).toBe("http://127.0.0.1:9999/v1/music/tracks/one");
});
