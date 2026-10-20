import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createLarmPlayground } from "../service/playground";
import { musicRequest } from "../service/music-request";
import {
	musicGenerationInput,
	musicProviders,
} from "../contracts/music-generation";
import type {
	LarmTestTarget,
	TestInput,
	TestProgress,
} from "../contracts/playground";
import { musicProviderFixture as catalog } from "./music-generation.fixture";
const target: LarmTestTarget = {
	id: "audio",
	name: "audio",
	model: "catalog-alias",
	capability: "media.music.generate",
	protocol: "larm.music-generation.v1",
	kind: "music",
	mode: "service",
	endpoint: "/v1/music/generations",
	profile: "fixture",
	revision: "1",
	onDemand: true,
	primary: true,
};
const audio = new Uint8Array(
	readFileSync(
		new URL("../../../../tests/browser/fixtures/silence.opus", import.meta.url),
	),
);
const cases: TestInput[] = [
	{ text: "orchestral music", instrumental: true, durationSeconds: 30 },
	{
		text: "singing",
		instrumental: false,
		lyrics: "[Verse]\n朝",
		durationSeconds: 600,
	},
	{ text: "confirmation chime", task: "sound-effect", durationSeconds: 1.5 },
];
for (const input of cases)
	test(`structured request for ${input.task ?? input.instrumental}`, () => {
		const body = musicRequest(input, catalog);
		expect(body).toMatchObject({
			model: "auto",
			prompt: input.text,
			durationSeconds: input.durationSeconds,
			outputFormat: "opus",
			quality: "balanced",
		});
		expect(body.task).toBe(input.task ?? "music");
		if (input.task === "sound-effect") {
			expect(body.lyrics).toBeUndefined();
			expect(body.instrumental).toBeUndefined();
		} else expect(body.instrumental).toBe(input.instrumental);
		if (input.lyrics) expect(body.lyrics).toBe(input.lyrics);
	});
test("catalog models are retained and omitted duration stays omitted for all three uses", () => {
	expect(musicProviders.parse(catalog)).toEqual(catalog);
	for (const input of cases) {
		const { durationSeconds: _seconds, ...rest } = input;
		expect(musicRequest(rest, catalog).durationSeconds).toBeUndefined();
	}
	expect(
		catalog.providers[0]!.models.map((m) => m.defaultDurationSeconds),
	).toEqual([120, 180, 5]);
});
test("duration limits come from models, preserve fractions, and never clamp", () => {
	for (const input of cases) {
		const max = input.instrumental === false ? 600 : 120;
		expect(
			musicRequest({ ...input, durationSeconds: max }, catalog).durationSeconds,
		).toBe(max);
		expect(() =>
			musicRequest({ ...input, durationSeconds: max + 0.1 }, catalog),
		).toThrow();
	}
});

test("rejects contradictory lyrics, unsupported options, formats and reference audio", () => {
	for (const bad of [
		{ prompt: "test", instrumental: true, lyrics: "words" },
		{ prompt: "test", task: "sound-effect", lyrics: "" },
		{ prompt: "test", task: "vocals" },
		{ prompt: "test", durationSeconds: 0.9 },
		{ prompt: "test", durationSeconds: 600.1 },
		{ prompt: "test", providerOptions: { steps: 8 } },
		{ prompt: "test", providerOptions: { guidance_scale: 10.1 } },
		{ prompt: "test", quality: "ultra" },
		{ prompt: "test", referenceAudio: "https://example.com/a.wav" },
		{ prompt: "test", model: "unavailable-xl" },
	])
		expect(musicGenerationInput.safeParse(bad).success).toBe(false);
	for (const outputFormat of ["opus", "wav", "flac", "mp3"] as const)
		expect(
			musicRequest({ text: "test", outputFormat }, catalog).outputFormat,
		).toBe(outputFormat);
	expect(
		musicRequest(
			{ text: "test", providerOptions: { guidance_scale: 0 } },
			catalog,
		).providerOptions,
	).toEqual({ guidance_scale: 0 });
	const changed = {
		providers: [
			{
				id: "new-provider",
				models: [
					{
						id: "dynamic-model",
						task: "music" as const,
						maxDurationSeconds: 17,
						defaultDurationSeconds: 10,
					},
				],
			},
		],
	};
	expect(() =>
		musicRequest({ text: "test", durationSeconds: 17.5 }, changed),
	).toThrow("music_duration_exceeded");
});
function gateway(
	statuses: string[],
	options: {
		postStatus?: number;
		cancelLate?: AbortController;
		format?: string;
	} = {},
) {
	const calls: {
		method: string;
		path: string;
		body?: Record<string, unknown>;
	}[] = [];
	const g = createLarmPlayground({
		baseUrl: "http://127.0.0.1:9999",
		token: "secret",
		audience: "test",
		pollMs: 1,
		fetch: (async (url, init = {}) => {
			expect(new Headers(init.headers).get("Authorization")).toBe(
				"Bearer secret",
			);
			const path = new URL(String(url)).pathname,
				method = init.method ?? "GET";
			calls.push({
				path,
				method,
				body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
			});
			if (path === "/v1/music/providers") return Response.json(catalog);
			if (method === "POST") {
				options.cancelLate?.abort();
				return Response.json(
					{ jobId: "track" },
					{ status: options.postStatus ?? 202 },
				);
			}
			if (method === "DELETE")
				return Response.json({ jobId: "track", status: "cancelled" });
			if (path.endsWith("/metadata")) return Response.json({ id: "track" });
			if (path.endsWith("/audio"))
				return new Response(audio, {
					headers: { "content-type": "audio/ogg" },
				});
			const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
			return Response.json({
				jobId: "track",
				status,
				result: {
					id: "track",
					provider: "local-audio",
					model: "fixture-sfx",
					metadata: { runtime: "fixture-runtime" },
					format: options.format ?? "opus",
					durationSeconds: 1.5,
					audioUrl: "http://127.0.0.1:9999/v1/music/generations/track/audio",
					metadataUrl: "/v1/music/generations/track/metadata",
				},
			});
		}) as typeof fetch,
	});
	return { g, calls };
}
test("one POST while queued/loading/generating/encoding; resolves audio and runtime", async () => {
	const { g, calls } = gateway([
		"queued",
		"loading",
		"generating",
		"encoding",
		"completed",
	]);
	const phases: TestProgress[] = [];
	const output = await g.execute(
		target,
		cases[2]!,
		AbortSignal.timeout(2000),
		async (p) => {
			phases.push(p);
		},
	);
	expect(output).toMatchObject({
		bytes: audio,
		actualModel: "fixture-sfx",
		runtime: "fixture-runtime",
		durationSeconds: 1.5,
	});
	expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
	expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({
		task: "sound-effect",
		model: "auto",
		durationSeconds: 1.5,
	});
	expect(phases.map((p) => p.phase)).toEqual([
		"generating",
		"queued",
		"queued",
		"loading",
		"generating",
		"encoding",
		"completed",
		"fetching-result",
	]);
});
for (const terminal of ["failed", "cancelled"])
	test(`${terminal} never yields successful audio`, async () => {
		const { g, calls } = gateway([terminal]);
		await expect(
			g.execute(target, cases[0]!, AbortSignal.timeout(1000), async () => {}),
		).rejects.toThrow(
			terminal === "failed"
				? "provider_generation_failed"
				: "provider_cancelled",
		);
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
		expect(calls.some((c) => c.path.endsWith("/audio"))).toBe(false);
	});
test("HTTP400 is readable by the host and not retried; invalid length never posts", async () => {
	const { g, calls } = gateway([], { postStatus: 400 });
	await expect(
		g.execute(target, cases[0]!, AbortSignal.timeout(1000), async () => {}),
	).rejects.toThrow("larm_http_400");
	expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
	const invalid = gateway([]);
	await expect(
		invalid.g.execute(
			target,
			{ text: "bgm", instrumental: true, durationSeconds: 121 },
			AbortSignal.timeout(1000),
			async () => {},
		),
	).rejects.toThrow("music_duration_exceeded");
	expect(invalid.calls.some((c) => c.method === "POST")).toBe(false);
});
test("a late 202 after local cancellation sends DELETE and never fetches audio", async () => {
	const c = new AbortController();
	const { g, calls } = gateway(["completed"], { cancelLate: c });
	await expect(
		g.execute(target, cases[0]!, c.signal, async () => {}),
	).rejects.toThrow();
	expect(calls.filter((x) => x.method === "POST")).toHaveLength(1);
	expect(calls.filter((x) => x.method === "DELETE").map((x) => x.path)).toEqual(
		["/v1/music/generations/track"],
	);
	expect(calls.some((x) => x.path.endsWith("/audio"))).toBe(false);
});
