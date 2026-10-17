import { expect, jest } from "bun:test";
import { createLarm } from "..";
export const names = ["llm", "asr", "tts"] as const;
export const protocols = {
	llm: "openai.chat-completions.v1",
	asr: "openai.audio-transcriptions.v1",
	tts: "openai.audio-speech.v1",
	"system-one": "larm.system-one.v1",
	"tts-english": "openai.audio-speech.v1",
	"language-fixture": "larm.system-one.v1",
};
export const paths = {
	llm: "/v1/chat/completions",
	asr: "/v1/audio/transcriptions",
	tts: "/v1/audio/speech",
	"system-one": "/v1/systemone",
	"tts-english": "/v1/audio/speech",
	"language-fixture": "/v1/systemone",
};
export const result = (value: unknown, status = 200) =>
	Response.json(value, { status });
export function fixture(
	mismatch = false,
	selectedProfile = "test-profile",
	initialExpiryMs = 900_000,
	ttsModel = "model-tts",
	decisions = false,
	routing = false,
	englishModel = "model-tts-english",
) {
	const providerNames = routing
		? ([...names, "system-one", "tts-english", "language-fixture"] as const)
		: decisions
			? ([...names, "system-one"] as const)
			: names;
	const calls: string[] = [];
	const requests: Record<string, unknown>[] = [];
	const agentProfile = "fixture-profile";
	const model = (name: string) =>
		name === "tts-english"
			? englishModel
			: name === "tts"
				? ttsModel
				: `model-${name}`;
	const contextWindow =
		selectedProfile === "test-profile-large"
			? {
					maxTokens: 262144,
					outputReserveTokens: 4096,
					safetyMarginTokens: 1976,
				}
			: { maxTokens: 4096, outputReserveTokens: 512, safetyMarginTokens: 128 };
	let expiryMs = initialExpiryMs;
	let tokenVersion = 1;
	const catalog = {
		contractVersion: "agent-connection.v3",
		catalogRevision: "rev1",
		requestedProfile: selectedProfile,
		profiles: [
			{
				id: agentProfile,
				providers: providerNames.map((name) => ({
					name,
					...(name === "system-one"
						? { capability: "decision.system-one" }
						: {}),
					...(name === "tts-english"
						? { capability: "speech.tts.english" }
						: {}),
					...(name === "language-fixture"
						? { capability: "decision.sentence-language" }
						: {}),
					protocol: protocols[name],
					endpoint: paths[name],
					model: model(name),
					...(name === "llm" ? { contextWindow } : {}),
				})),
				services: [],
			},
		],
	};
	const created = (requested: string[]) => ({
		id: "connection1",
		profile: selectedProfile,
		agentProfile,
		status: "ready",
		expiresAt: new Date(Date.now() + expiryMs).toISOString(),
		providers: requested.map((name) => ({
			name,
			protocol: protocols[name as keyof typeof protocols],
			endpoint: paths[name as keyof typeof paths],
			model: model(name),
			readiness: "ready",
			claimable: true,
		})),
	});
	const claim = (requested: string[]) => ({
		...created(requested),
		allocationId: "allocation1",
		providers: requested.map((name) => ({
			name,
			protocol: protocols[name as keyof typeof protocols],
			baseUrl: `http://127.0.0.1/${name}/v1`,
			endpoint: `http://127.0.0.1/${name}${paths[name as keyof typeof paths]}`,
			model: mismatch && name === "llm" ? "wrong-model" : model(name),
			credential: { token: `secret-${name}-${tokenVersion}` },
			secretFields: { apiKey: `providers.${name}.credential.token` },
			configuration: {
				fields: {
					[name === "system-one" || name === "language-fixture"
						? "daemonURL"
						: "baseURL"]: `http://127.0.0.1/${name}/v1`,
					model: mismatch && name === "llm" ? "wrong-model" : model(name),
					...(name === "tts" ? { voice: "fixture-voice" } : {}),
				},
			},
			contextWindow: name === "llm" ? contextWindow : undefined,
		})),
	});
	let requested = ["llm"];
	const fetcher = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const compression = init as RequestInit & {
			compress: unknown;
			decompress: unknown;
		};
		const url = new URL(String(input));
		expect(compression.compress).toBe(
			init?.body != null && !url.pathname.startsWith("/v1/agent-connections")
				? "gzip"
				: false,
		);
		expect(compression.decompress).toBe(true);
		expect(new Headers(init?.headers).get("Accept-Encoding")).toBe("gzip");
		calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
		if (url.pathname === "/v3/agent-profiles") return result(catalog);
		if (url.pathname === "/v1/agent-connections" && init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			requests.push(body);
			requested = body.providers ?? [...providerNames];
			expect(body.expectedCatalogRevision).toBe("rev1");
			expect(new Headers(init.headers).get("Idempotency-Key")).toBeTruthy();
			return result(created(requested), 201);
		}
		if (url.pathname === "/v1/agent-connections/connection1/claim") {
			expect(new Headers(init?.headers).has("Idempotency-Key")).toBe(false);
			return result(claim(requested));
		}
		if (url.pathname === "/v1/agent-connections/connection1/renew") {
			expect(new Headers(init?.headers).get("Idempotency-Key")).toBeTruthy();
			expect(JSON.parse(String(init?.body))).toEqual({ ttlSeconds: 900 });
			expiryMs = 900_000;
			tokenVersion++;
			return result(created(requested));
		}
		if (
			url.pathname === "/v1/agent-connections/connection1" &&
			init?.method === "GET"
		)
			return result(created(requested));
		if (
			url.pathname === "/v1/agent-connections/connection1" &&
			init?.method === "DELETE"
		)
			return new Response(null, { status: 204 });
		if (url.pathname === "/llm/v1/chat/completions") {
			expect(new Headers(init?.headers).get("Authorization")).toBe(
				`Bearer secret-llm-${tokenVersion}`,
			);
			return result({ choices: [{ message: { content: "承知しました" } }] });
		}
		if (url.pathname === "/asr/v1/audio/transcriptions") {
			const body =
				init?.body instanceof Blob
					? await new Response(init.body, { headers: init.headers }).formData()
					: init?.body;
			expect(body instanceof FormData).toBe(true);
			if (body instanceof FormData) {
				expect(body.get("response_format")).toBe("json");
				expect(body.get("language")).toBeNull();
			}
			return result({ text: "こんにちは" });
		}
		if (url.pathname === "/tts/v1/audio/speech") {
			expect(JSON.parse(String(init?.body)).voice).toBe("fixture-voice");
			const wav = new Uint8Array(44);
			wav.set(new TextEncoder().encode("RIFF"), 0);
			wav.set(new TextEncoder().encode("WAVE"), 8);
			return new Response(wav);
		}
		return result({ error: "not_found" }, 404);
	};
	return { fetcher, calls, requests };
}
// Give each created connection a distinct ID, preserving the public fixture contract.
export function lifecycleFixture(initialExpiryMs = 900_000) {
	const fake = fixture(false, "test-profile", initialExpiryMs);
	let generation = 0;
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.pathname === "/v1/agent-connections" && init?.method === "POST")
			generation++;
		const id = `connection${generation}`;
		url.pathname = url.pathname.replace(/connection\d+/, "connection1");
		const response = await fake.fetcher(url, init);
		if (
			!url.pathname.startsWith("/v1/agent-connections") ||
			response.status === 204
		)
			return response;
		const body = (await response.json()) as Record<string, unknown>;
		if (body.id) body.id = id;
		return result(body, response.status);
	};
	return { ...fake, fetcher, generation: () => generation };
}
export const idleMessage =
	"provider bearer token belongs to an idle-released connection";
export const idleReleased = () =>
	result(
		{ error: { code: "connection_idle_released", message: idleMessage } },
		409,
	);
export const question = [{ role: "user" as const, content: "確認" }];
export const freshSignal = () => new AbortController().signal;
export function makeLarm(
	fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
	idleTimeoutMs?: number,
) {
	return createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		fetch: fetcher,
		idleTimeoutMs,
	});
}
/** Drives fake timers in `stepMs` steps until `work` settles (service poll/pause timers). */
export async function driveFakeTimers<T>(work: Promise<T>, stepMs: number) {
	let settled = false;
	void work.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	for (let i = 0; !settled && i < 200; i++) {
		await new Promise((resolve) => setImmediate(resolve));
		if (!settled) jest.advanceTimersByTime(stepMs);
	}
	return work;
}
// SEC-4: provider hosts are pinned to the LARM host or an explicit allow-list.
export function claimAt(
	fetcher: ReturnType<typeof fixture>["fetcher"],
	origin: string,
) {
	return async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await fetcher(input, init);
		if (!new URL(String(input)).pathname.endsWith("/claim")) return response;
		const text = (await response.text()).replaceAll(
			"http://127.0.0.1/",
			`${origin}/`,
		);
		return new Response(text, { status: response.status });
	};
}
