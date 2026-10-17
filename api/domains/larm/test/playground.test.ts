import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	createLarmPlayground,
	findServiceTarget,
	silentWav,
	type TestProgress,
} from "..";
const revision = "a".repeat(64);
const names = ["llm", "asr", "tts", "embedding", "system-one"];
const protocols = [
	"openai.chat-completions.v1",
	"openai.audio-transcriptions.v1",
	"openai.audio-speech.v1",
	"larm.embedding.v1",
	"larm.system-one.v1",
];
const endpoints = [
	"/v1/chat/completions",
	"/v1/audio/transcriptions",
	"/v1/audio/speech",
	"/v1/embed",
	"/v1/systemone",
];
function fixture(
	change?: (
		path: string,
		init: RequestInit,
		url: URL,
	) => Response | Promise<Response> | undefined,
) {
	const calls: {
		path: string;
		url: string;
		method: string;
		body: unknown;
		auth: string | null;
	}[] = [];
	let requested = ["llm"];
	const providers = names.map((name, i) => ({
		name,
		protocol: protocols[i],
		endpoint: endpoints[i],
		model: `model-${name}`,
		capability: name,
	}));
	const service = (kind: "image" | "music") => ({
		name: kind,
		description: "Synchronous image or asynchronous music generation",
		model: `model-${kind}`,
		protocol: `larm.${kind}-generation.v1`,
		capability: `media.${kind}.generate`,
		endpoint:
			kind === "image" ? "/v1/images/generations" : "/v1/music/generations",
		startupPolicy: { minWarmInstances: 0, idleTtlSeconds: 0 },
	});
	const fetcher = async (url: RequestInfo | URL, init: RequestInit = {}) => {
		const u = new URL(String(url));
		const path = u.pathname;
		const headers = new Headers(init.headers);
		const body =
			typeof init.body === "string" ? JSON.parse(init.body) : init.body;
		calls.push({
			path,
			url: u.href,
			method: init.method ?? "GET",
			body,
			auth: headers.get("authorization"),
		});
		const override = await change?.(path, init, u);
		if (override) return override;
		if (path === "/openapi.json") return new Response(null, { status: 404 });
		if (path === "/v3/agent-profiles") {
			const selector = u.searchParams.get("profile");

			// The unselected catalog lists every profile without services; a profile fetched by id carries them.
			const profiles = [
				{ id: "profile", providers, services: [], withServices: [] },
				{
					id: "image-profile",
					providers: [],
					services: [],
					withServices: [service("image")],
				},
				{
					id: "music-profile",
					providers: [],
					services: [],
					withServices: [service("music")],
				},
			];
			const selected = !selector
				? profiles
				: profiles.filter(
						(p) =>
							p.id === selector ||
							(selector === "test-profile" && p.id === "profile"),
					);
			return Response.json({
				contractVersion: "agent-connection.v3",
				catalogRevision: revision,
				requestedProfile: selector,
				profiles: selected.map(({ withServices, ...p }) => ({
					...p,
					...(selector ? { services: withServices } : {}),
				})),
			});
		}
		if (path === "/v1/agent-connections") {
			requested = body.providers ?? names;
			return Response.json(
				{
					id: "test",
					agentProfile:
						body.profile === "image-profile" ? "image-profile" : "profile",
					services: body.profile === "image-profile" ? [service("image")] : [],
					catalogRevision: revision,
					status: "ready",
					providers: providers
						.filter((p) => requested.includes(p.name))
						.map((p) => ({ ...p, readiness: "ready", claimable: true })),
				},
				{ status: 201 },
			);
		}
		if (path === "/v1/agent-connections/test" && init.method === "DELETE")
			return new Response(null, { status: 204 });
		if (path.endsWith("/health")) {
			const name = path.split("/").at(-2);
			return Response.json({
				name,
				capability: name,
				ready: true,
				acceptingRequests: true,
			});
		}
		if (path.endsWith("/claim"))
			return Response.json({
				id: "test",
				status: "ready",
				expiresAt: new Date(Date.now() + 300_000).toISOString(),
				providers: providers
					.filter((p) => requested.includes(p.name))
					.map((p) => ({
						...p,
						endpoint: ["embedding", "system-one"].includes(p.name)
							? `http://127.0.0.1:9999/${p.name}${p.endpoint}`
							: undefined,
						baseUrl: `http://127.0.0.1:9999/${p.name}/v1`,
						credential: {
							type: "bearer",
							token: "short-lived",
							expiresAt: new Date(Date.now() + 300_000).toISOString(),
						},
						configuration: {
							fields: {
								baseURL: `http://127.0.0.1:9999/${p.name}/v1`,
								model: p.model,
							},
						},
					})),
			});
		if (path === "/v1/audio/voices")
			return Response.json({ default_voice: "sample" });
		if (path.endsWith("/chat/completions"))
			return Response.json({
				choices: [{ message: { content: "こんにちは" } }],
			});
		if (path.endsWith("/transcriptions"))
			return Response.json({ text: "テスト" });
		if (path.endsWith("/speech"))
			return new Response(silentWav(), {
				headers: { "Content-Type": "audio/wav" },
			});
		if (path.endsWith("/embed"))
			return Response.json({
				embeddings: [
					[1, 0],
					[1, 0],
				],
				dimension: 2,
			});
		if (path.endsWith("/systemone"))
			return Response.json({
				model: "model-system-one",
				answers: { intent: { choice: "greeting" } },
			});
		if (path === "/v1/images/generations")
			return Response.json({
				status: "succeeded",
				artifact: {
					id: "image-1",
					contentUrl: "/v1/image-artifacts/image-1/content",
					mimeType: "image/png",
					model: "model-image",
				},
			});
		if (path === "/v1/image-artifacts/image-1/content")
			return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
				headers: { "Content-Type": "image/png" },
			});
		if (path === "/v1/music/generations")
			return Response.json(
				{ jobId: "music-1", status: "queued" },
				{ status: 202 },
			);
		if (path === "/v1/music/generations/music-1" && init.method === "DELETE")
			return Response.json({ jobId: "music-1", status: "cancelled" });
		if (path === "/v1/music/generations/music-1")
			return Response.json({
				jobId: "music-1",
				status: "completed",
				result: {
					id: "music-1",
					model: "model-music",
					audioUrl: "/v1/music/generations/music-1/audio",
					metadataUrl: "/v1/music/generations/music-1/metadata",
					format: "mp3",
				},
			});
		if (path.endsWith("/metadata")) return Response.json({ id: "music-1" });
		if (path.endsWith("/audio"))
			return new Response(new Uint8Array([73, 68, 51, 0]), {
				headers: { "Content-Type": "audio/mpeg" },
			});
		throw new Error(`unexpected_fixture_${path}`);
	};
	const gateway = createLarmPlayground({
		baseUrl: "http://127.0.0.1:9999",
		token: "control-secret",
		profile: "test-profile",
		audience: "same-host",
		pollMs: 1,
		fetch: fetcher as typeof fetch,
	});
	return { gateway, calls };
}
test("catalog merges selector-only cold services without starting anything", async () => {
	const h = fixture();
	const c = await h.gateway.catalog(AbortSignal.timeout(1000));
	expect(c.targets).toHaveLength(7);
	expect(c.targets.filter((t) => t.onDemand)).toHaveLength(2);
	expect(c.errors).toEqual([]);
	expect(h.calls.every((c) => c.method === "GET")).toBe(true);
	expect(JSON.stringify(c)).not.toContain("control-secret");
});
test("services missing from the unselected catalog are fetched again by profile id", async () => {
	const h = fixture();
	const c = await h.gateway.catalog(AbortSignal.timeout(1000));
	const queried = h.calls
		.filter((x) => x.path === "/v3/agent-profiles")
		.map((x) => new URL(x.url).searchParams.get("profile"));
	// Saved profile first, then the whole catalog, then each profile that came back without services.
	expect(queried).toEqual([
		"test-profile",
		null,
		"profile",
		"image-profile",
		"music-profile",
	]);
	expect(
		c.targets
			.filter((t) => t.mode === "service")
			.map((t) => [t.capability, t.selector]),
	).toEqual([
		["media.image.generate", "image-profile"],
		["media.music.generate", "music-profile"],
	]);
});
test("every warm provider executes independently, validates claim and releases", async () => {
	const h = fixture();
	const c = await h.gateway.catalog(AbortSignal.timeout(1000));
	for (const t of c.targets.filter((t) => t.mode === "provider")) {
		const result = await h.gateway.execute(
			t,
			{ text: "こんにちは", comparison: "こんにちは" },
			AbortSignal.timeout(1000),
			async () => {},
		);
		expect(result.text || result.bytes).toBeTruthy();
	}
	expect(h.calls.filter((c) => c.method === "DELETE")).toHaveLength(5);
	const claims = h.calls.filter((c) => c.path.endsWith("/claim"));
	expect(
		claims.some((c) =>
			JSON.stringify(c.body).includes("larm-embedding-provider-v1"),
		),
	).toBe(true);
	expect(h.calls.find((c) => c.path === "/llm/v1/chat/completions")?.auth).toBe(
		"Bearer short-lived",
	);
});
test("semantic health is distinct from catalog presence, and cold diagnosis does not generate", async () => {
	const h = fixture((path) =>
		path.endsWith("/llm/health")
			? Response.json(
					{
						name: "llm",
						capability: "llm",
						ready: true,
						acceptingRequests: false,
						reason: "provider_busy",
					},
					{ status: 503 },
				)
			: undefined,
	);
	const c = await h.gateway.catalog(AbortSignal.timeout(1000));
	const llm = c.targets.find((t) => t.kind === "llm")!;
	expect((await h.gateway.health(llm, AbortSignal.timeout(1000))).state).toBe(
		"busy",
	);
	const image = c.targets.find((t) => t.kind === "image")!;
	const n = h.calls.length;
	expect((await h.gateway.health(image, AbortSignal.timeout(1000))).state).toBe(
		"on-demand",
	);
	expect(h.calls).toHaveLength(n);
});
test("image acquires and releases a connection while music remains direct", async () => {
	const h = fixture();
	const c = await h.gateway.catalog(AbortSignal.timeout(1000));
	for (const kind of ["image", "music"]) {
		const t = c.targets.find((t) => t.kind === kind)!;
		const progress: TestProgress[] = [];
		const r = await h.gateway.execute(
			t,
			{ text: "test" },
			AbortSignal.timeout(1000),
			async (p) => {
				progress.push(p);
			},
		);
		expect(r.bytes?.length).toBeGreaterThan(0);
		expect(progress.some((p) => p.artifact)).toBe(true);
	}
	expect(
		h.calls.filter((c) => c.path === "/v1/agent-connections"),
	).toHaveLength(1);
	const lifecycle = h.calls.filter(
		(c) =>
			c.path.startsWith("/v1/agent-connections") ||
			c.path === "/v1/images/generations" ||
			c.path === "/v1/image-artifacts/image-1/content",
	);
	expect(lifecycle.map((c) => `${c.method} ${c.path}`)).toEqual([
		"POST /v1/agent-connections",
		"POST /v1/images/generations",
		"GET /v1/image-artifacts/image-1/content",
		"DELETE /v1/agent-connections/test",
	]);
	expect(lifecycle[0]!.body).toMatchObject({
		profile: "image-profile",
		expectedCatalogRevision: revision,
	});
	expect(lifecycle[0]!.body).toHaveProperty("providers", ["llm"]);
});
test("music requests Opus once and fetches Ogg Opus with Control authentication after completion", async () => {
	const audio = new Uint8Array(
		readFileSync(
			new URL(
				"../../../../tests/browser/fixtures/silence.opus",
				import.meta.url,
			),
		),
	);
	let polls = 0;
	const h = fixture((path) => {
		if (path === "/v1/music/generations/music-1") {
			polls++;
			return Response.json({
				jobId: "music-1",
				status: polls === 1 ? "encoding" : "completed",
				...(polls === 1
					? {}
					: {
							result: {
								id: "music-1",
								model: "model-music",
								format: "opus",
								audioUrl: "/v1/music/generations/music-1/audio",
								metadataUrl: "/v1/music/generations/music-1/metadata",
							},
						}),
			});
		}
		if (path.endsWith("/audio")) {
			expect(polls).toBe(2);
			return new Response(audio, {
				headers: { "content-type": "audio/ogg; codecs=opus" },
			});
		}
	});
	const target = (
		await h.gateway.catalog(AbortSignal.timeout(1000))
	).targets.find((t) => t.kind === "music")!;
	const progress: TestProgress[] = [];
	const result = await h.gateway.execute(
		target,
		{ text: "test", durationSeconds: 30 },
		AbortSignal.timeout(1000),
		async (p) => {
			progress.push(p);
		},
	);
	expect(result.mime).toBe("audio/ogg");
	expect(result.bytes).toEqual(audio);
	expect(progress.map((p) => p.phase)).toEqual([
		"generating",
		"queued",
		"encoding",
		"completed",
		"fetching-result",
	]);
	const posts = h.calls.filter((c) => c.method === "POST");
	expect(posts).toHaveLength(1);
	expect(posts[0]!.body).toMatchObject({
		model: "model-music",
		outputFormat: "opus",
		durationSeconds: 30,
	});
	expect(h.calls.every((c) => c.auth === "Bearer control-secret")).toBe(true);
	expect(h.calls.some((c) => c.path.includes("/claim"))).toBe(false);
});
for (const invalid of [
	"not-ogg",
	"vorbis",
	"truncated",
	"mime-mismatch",
	"unknown-format",
])
	test(`music rejects invalid Opus result: ${invalid}`, async () => {
		const audio = new Uint8Array(
			readFileSync(
				new URL(
					"../../../../tests/browser/fixtures/silence.opus",
					import.meta.url,
				),
			),
		);
		if (invalid === "not-ogg") audio[0] = 0;
		if (invalid === "vorbis") audio[28] = 0;
		const h = fixture((path) => {
			if (path === "/v1/music/generations/music-1")
				return Response.json({
					jobId: "music-1",
					status: "completed",
					result: {
						id: "music-1",
						model: "model-music",
						format: invalid === "unknown-format" ? "aac" : "opus",
						audioUrl: "/v1/music/generations/music-1/audio",
						metadataUrl: "/v1/music/generations/music-1/metadata",
					},
				});
			if (path.endsWith("/audio"))
				return new Response(
					invalid === "truncated" ? audio.slice(0, 32) : audio,
					{
						headers: {
							"content-type":
								invalid === "mime-mismatch" ? "audio/wav" : "audio/ogg",
						},
					},
				);
		});
		const target = (
			await h.gateway.catalog(AbortSignal.timeout(1000))
		).targets.find((t) => t.kind === "music")!;
		await expect(
			h.gateway.execute(
				target,
				{ text: "test" },
				AbortSignal.timeout(1000),
				async () => {},
			),
		).rejects.toThrow(
			invalid === "mime-mismatch" || invalid === "unknown-format"
				? "invalid_artifact_type"
				: "invalid_artifact_content",
		);
		expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(1);
	});
for (const format of ["wav", "flac"] as const)
	test(`music still accepts an existing ${format} result`, async () => {
		const audio =
			format === "wav" ? silentWav() : new TextEncoder().encode("fLaC");
		const mime = format === "wav" ? "audio/wav" : "audio/flac";
		const h = fixture((path) => {
			if (path === "/v1/music/generations/music-1")
				return Response.json({
					jobId: "music-1",
					status: "completed",
					result: {
						id: "music-1",
						model: "model-music",
						format,
						audioUrl: "/v1/music/generations/music-1/audio",
						metadataUrl: "/v1/music/generations/music-1/metadata",
					},
				});
			if (path.endsWith("/audio"))
				return new Response(audio, { headers: { "content-type": mime } });
		});
		const target = (
			await h.gateway.catalog(AbortSignal.timeout(1000))
		).targets.find((t) => t.kind === "music")!;
		const result = await h.gateway.execute(
			target,
			{ text: "test" },
			AbortSignal.timeout(1000),
			async () => {},
		);
		expect(result.mime).toBe(mime);
		expect(result.bytes).toEqual(audio);
	});
test("image POST failures are not retried and late cancellation is reported unknown", async () => {
	let post = 0;
	const h = fixture((path) => {
		if (path === "/v1/images/generations") {
			post++;
			throw new TypeError("network");
		}
		return undefined;
	});
	const t = (await h.gateway.catalog(AbortSignal.timeout(1000))).targets.find(
		(t) => t.kind === "image",
	)!;
	await expect(
		h.gateway.execute(
			t,
			{ text: "test" },
			AbortSignal.timeout(1000),
			async () => {},
		),
	).rejects.toThrow("generation_unknown");
	expect(post).toBe(1);
});
test("artifact origin mismatch never forwards control credential", async () => {
	const h = fixture((path) =>
		path === "/v1/images/generations"
			? Response.json({
					status: "succeeded",
					artifact: {
						id: "image-1",
						contentUrl:
							"http://other.example/v1/image-artifacts/image-1/content",
						mimeType: "image/png",
					},
				})
			: undefined,
	);
	const t = (await h.gateway.catalog(AbortSignal.timeout(1000))).targets.find(
		(t) => t.kind === "image",
	)!;
	await expect(
		h.gateway.execute(
			t,
			{ text: "test" },
			AbortSignal.timeout(1000),
			async () => {},
		),
	).rejects.toThrow("invalid_artifact_origin");
	expect(h.calls.filter((c) => c.path.includes("/content"))).toHaveLength(0);
});
test("music cancellation collects a late job and confirms remote cancellation", async () => {
	const controller = new AbortController();
	const h = fixture((path) => {
		if (path === "/v1/music/generations") {
			controller.abort();
			return Response.json({ jobId: "music-1" }, { status: 202 });
		}
	});
	const t = (await h.gateway.catalog(AbortSignal.timeout(1000))).targets.find(
		(t) => t.kind === "music",
	)!;
	await expect(
		h.gateway.execute(t, { text: "test" }, controller.signal, async () => {}),
	).rejects.toBeDefined();
	expect(
		h.calls.some((c) => c.path.endsWith("music-1") && c.method === "DELETE"),
	).toBe(true);
});
test("invalid claim cannot run inference and still releases connection", async () => {
	const h = fixture((path) =>
		path.endsWith("/claim")
			? Response.json({ id: "other", status: "ready" })
			: undefined,
	);
	const t = (await h.gateway.catalog(AbortSignal.timeout(1000))).targets[0]!;
	await expect(
		h.gateway.execute(
			t,
			{ text: "test" },
			AbortSignal.timeout(1000),
			async () => {},
		),
	).rejects.toThrow("invalid_claim");
	expect(h.calls.some((c) => c.method === "DELETE")).toBe(true);
	expect(h.calls.some((c) => c.path.endsWith("chat/completions"))).toBe(false);
});

test("direct service runtime model IDs are returned separately from catalog IDs", async () => {
	const h = fixture((path) =>
		path === "/v1/images/generations"
			? Response.json({
					status: "succeeded",
					artifact: {
						id: "image-1",
						model: "Vendor/Runtime-Model",
						contentUrl: "/v1/image-artifacts/image-1/content",
						mimeType: "image/png",
					},
				})
			: undefined,
	);
	const target = (
		await h.gateway.catalog(AbortSignal.timeout(1000))
	).targets.find((t) => t.kind === "image")!;
	const result = await h.gateway.execute(
		target,
		{ text: "test" },
		AbortSignal.timeout(1000),
		async () => {},
	);
	expect(target.model).toBe("model-image");
	expect(result.actualModel).toBe("Vendor/Runtime-Model");
});

test("malformed local hostnames cannot receive credentials", () => {
	expect(() =>
		createLarmPlayground({
			baseUrl: "http://127.attacker.example",
			profile: "test-profile",
			audience: "same-host",
		}),
	).toThrow("invalid_larm_url");
});

function hostClaim(origin: string) {
	const expiresAt = new Date(Date.now() + 300_000).toISOString();
	return Response.json({
		id: "test",
		status: "ready",
		expiresAt,
		providers: [
			{
				name: "llm",
				protocol: "openai.chat-completions.v1",
				endpoint: undefined,
				model: "model-llm",
				baseUrl: `${origin}/llm/v1`,
				credential: { type: "bearer", token: "short-lived", expiresAt },
				configuration: {
					fields: { baseURL: `${origin}/llm/v1`, model: "model-llm" },
				},
			},
		],
	});
}
async function executeLlm(origin: string, hosts?: string) {
	const previous = process.env.EUMENES_LARM_PROVIDER_HOSTS;
	if (hosts === undefined) delete process.env.EUMENES_LARM_PROVIDER_HOSTS;
	else process.env.EUMENES_LARM_PROVIDER_HOSTS = hosts;
	try {
		const h = fixture((path) =>
			path.endsWith("/claim") ? hostClaim(origin) : undefined,
		);
		const c = await h.gateway.catalog(AbortSignal.timeout(1000));
		const target = c.targets.find(
			(t) => t.kind === "llm" && t.mode === "provider",
		)!;
		return await h.gateway.execute(
			target,
			{ text: "こんにちは" },
			AbortSignal.timeout(1000),
			async () => {},
		);
	} finally {
		if (previous === undefined) delete process.env.EUMENES_LARM_PROVIDER_HOSTS;
		else process.env.EUMENES_LARM_PROVIDER_HOSTS = previous;
	}
}
test("playground claims on the LARM host, another port included, are accepted", async () => {
	expect((await executeLlm("http://127.0.0.1:8080")).text).toBeTruthy();
});
test("playground claims on another private host are refused unless listed", async () => {
	await expect(executeLlm("http://10.9.9.9")).rejects.toThrow(
		"larm_provider_host_mismatch",
	);
	await expect(executeLlm("http://other.local")).rejects.toThrow(
		"larm_provider_host_mismatch",
	);
	expect((await executeLlm("http://10.9.9.9", "10.9.9.9")).text).toBeTruthy();
});
test("a missing baseUrl leaves the playground unconfigured", async () => {
	const gateway = createLarmPlayground({
		token: "control-secret",
		profile: "test-profile",
		audience: "saaa-desktop",
		fetch: (async () => {
			throw new Error("must_not_contact");
		}) as unknown as typeof fetch,
	});
	const catalog = await gateway.catalog(AbortSignal.timeout(1000));
	expect(catalog.targets).toEqual([]);
	expect(JSON.stringify(catalog.errors)).toContain(
		"larm_base_url_unconfigured",
	);
});

test("image uses the discovered service URL and preserves arbitrary dimensions and seed", async () => {
	const serviceUrl = "http://127.0.0.1:9999/discovered-image-api";
	let connectionUrl = serviceUrl;
	const h = fixture((path, _init, url) => {
		if (path === "/v1/agent-connections")
			return Response.json(
				{
					id: "test",
					agentProfile: "image-profile",
					catalogRevision: revision,
					status: "ready",
					providers: [],
					services: [
						{
							name: "image",
							model: "model-image-discovered",
							protocol: "larm.image-generation.v1",
							capability: "media.image.generate",
							url: connectionUrl,
							description: "Generate a single image",
						},
					],
				},
				{ status: 201 },
			);
		if (
			path === "/v3/agent-profiles" &&
			url.searchParams.get("profile") === "image-profile"
		)
			return Response.json({
				contractVersion: "agent-connection.v3",
				catalogRevision: revision,
				requestedProfile: "image-profile",
				profiles: [
					{
						id: "image-profile",
						providers: [],
						services: [
							{
								name: "image",
								model: "model-image-discovered",
								protocol: "larm.image-generation.v1",
								capability: "media.image.generate",
								endpoint: "/v1/images/generations",
								url: "http://127.0.0.1:9999/catalog-only-image-api",
								startupPolicy: { minWarmInstances: 0 },
							},
						],
					},
				],
			});
		if (path === "/discovered-image-api")
			return Response.json({
				status: "succeeded",
				artifacts: [
					{
						id: "image-1",
						contentUrl: "/v1/image-artifacts/image-1/content",
						mimeType: "image/png",
					},
				],
			});
	});
	const target = (
		await h.gateway.catalog(AbortSignal.timeout(1000))
	).targets.find((t) => t.kind === "image")!;
	await h.gateway.execute(
		target,
		{ text: "写真", width: 1200, height: 777, seed: 42, format: "png" },
		AbortSignal.timeout(1000),
		async () => {},
	);
	expect(h.calls.find((c) => c.url === serviceUrl)?.body).toEqual({
		model: "model-image-discovered",
		prompt: "写真",
		width: 1200,
		height: 777,
		seed: 42,
		format: "png",
	});
	expect(h.calls.some((c) => c.path === "/v1/agent-connections")).toBe(true);
	connectionUrl = "http://192.168.0.99:9810/foreign";
	await expect(
		h.gateway.execute(
			target,
			{ text: "写真" },
			AbortSignal.timeout(1000),
			async () => {},
		),
	).rejects.toThrow("invalid_artifact_origin");
	expect(h.calls.some((c) => c.url.includes("192.168.0.99"))).toBe(false);
});

test("image defaults an omitted edge to 512, format to webp and seed to zero", async () => {
	const h = fixture();
	const target = (
		await h.gateway.catalog(AbortSignal.timeout(1000))
	).targets.find((t) => t.kind === "image")!;
	await h.gateway.execute(
		target,
		{ text: "写真", width: 100 },
		AbortSignal.timeout(1000),
		async () => {},
	);
	expect(
		h.calls.find((c) => c.path === "/v1/images/generations")?.body,
	).toEqual({
		model: "model-image",
		prompt: "写真",
		width: 100,
		height: 512,
		seed: 0,
		format: "webp",
	});
});
test("services are chosen by capability and protocol in catalog order, never by name", async () => {
	const h = fixture();
	const { targets } = await h.gateway.catalog(AbortSignal.timeout(1000));
	expect(
		findServiceTarget(
			targets,
			"media.image.generate",
			"larm.image-generation.v1",
		)?.profile,
	).toBe("image-profile");
	expect(findServiceTarget(targets, "media.music.generate")?.profile).toBe(
		"music-profile",
	);
	expect(
		findServiceTarget(targets, "media.image.generate", "other.protocol.v1"),
	).toBeUndefined();
	// A provider with the same capability is not a service; a second service loses to the first.
	const second = {
		...targets.find((t) => t.mode === "service")!,
		id: "second",
		profile: "later-image-profile",
	};
	expect(
		findServiceTarget(
			[
				{ ...targets[0]!, capability: "media.image.generate" },
				...targets,
				second,
			],
			"media.image.generate",
		)?.profile,
	).toBe("image-profile");
});
