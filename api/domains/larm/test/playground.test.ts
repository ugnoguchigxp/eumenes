import { expect, test } from "bun:test";
import { createLarmPlayground, silentWav, type TestProgress } from "..";
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
	) => Response | Promise<Response> | undefined,
) {
	const calls: {
		path: string;
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
	const fetcher = async (url: RequestInfo | URL, init: RequestInit = {}) => {
		const u = new URL(String(url));
		const path = u.pathname;
		const headers = new Headers(init.headers);
		const body =
			typeof init.body === "string" ? JSON.parse(init.body) : init.body;
		calls.push({
			path,
			method: init.method ?? "GET",
			body,
			auth: headers.get("authorization"),
		});
		const override = await change?.(path, init);
		if (override) return override;
		if (path === "/v3/agent-profiles") {
			const selector = u.searchParams.get("profile");
			const kind =
				selector === "SAAA-w-Image"
					? "image"
					: selector === "SAAA-w-music"
						? "music"
						: undefined;
			return Response.json({
				contractVersion: "agent-connection.v3",
				catalogRevision: revision,
				requestedProfile: selector,
				profiles: [
					{
						id: "profile",
						providers,
						services: kind
							? [
									{
										name: kind,
										model: `model-${kind}`,
										protocol: `larm.${kind}-generation.v1`,
										capability: `media.${kind}.generate`,
										endpoint:
											kind === "image"
												? "/v1/images/generations"
												: "/v1/music/generations",
										startupPolicy: { minWarmInstances: 0, idleTtlSeconds: 0 },
									},
								]
							: [],
					},
				],
			});
		}
		if (path === "/v1/agent-connections") {
			requested = body.providers;
			return Response.json(
				{
					id: "test",
					agentProfile: "profile",
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
		profile: "SAAA-gemma4-26b",
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
test("image and music fetch artifacts without making a warm connection", async () => {
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
	expect(h.calls.some((c) => c.path === "/v1/agent-connections")).toBe(false);
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
			profile: "SAAA",
			audience: "same-host",
		}),
	).toThrow("invalid_larm_url");
});
