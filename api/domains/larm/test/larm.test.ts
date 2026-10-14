import { expect, jest, spyOn, test } from "bun:test";
import { createLarm } from "..";

const names = ["llm", "asr", "tts"] as const;
const protocols = {
	llm: "openai.chat-completions.v1",
	asr: "openai.audio-transcriptions.v1",
	tts: "openai.audio-speech.v1",
	"system-one": "larm.system-one.v1",
	"tts-english": "openai.audio-speech.v1",
	"language-fixture": "larm.system-one.v1",
};
const paths = {
	llm: "/v1/chat/completions",
	asr: "/v1/audio/transcriptions",
	tts: "/v1/audio/speech",
	"system-one": "/v1/systemone",
	"tts-english": "/v1/audio/speech",
	"language-fixture": "/v1/systemone",
};
const result = (value: unknown, status = 200) =>
	Response.json(value, { status });
function fixture(
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
		const url = new URL(String(input));
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
			const body = init?.body;
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
test("control JSON generation is opt-in and ordinary answers keep provider defaults", async () => {
	const fake = fixture();
	const bodies: Record<string, unknown>[] = [];
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		fetch: async (input, init) => {
			if (new URL(String(input)).pathname === "/llm/v1/chat/completions")
				bodies.push(JSON.parse(String(init?.body)));
			return fake.fetcher(input, init);
		},
	});
	try {
		const messages = [{ role: "user" as const, content: "JSON" }];
		await larm.answer(messages, new AbortController().signal, {
			jsonOutput: true,
		});
		await larm.answer(messages, new AbortController().signal);
		expect(bodies[0]?.response_format).toEqual({ type: "json_object" });
		expect(bodies[0]?.temperature).toBe(0);
		expect(bodies[1]?.response_format).toBeUndefined();
		expect(bodies[1]?.temperature).toBeUndefined();
	} finally {
		await larm.close();
	}
});
test("catalog, claim, ASR/LLM/TTS and release use public contract", async () => {
	const fake = fixture();
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		fetch: fake.fetcher,
	});
	const signal = new AbortController().signal;
	expect(
		await larm.answer([{ role: "user", content: "こんにちは" }], signal),
	).toBe("承知しました");
	expect(await larm.transcribe(new Uint8Array(44), signal)).toBe("こんにちは");
	expect((await larm.speak("承知しました", signal)).length).toBe(44);
	await larm.close();
	expect(fake.calls.filter((x) => x.includes("/claim"))).toHaveLength(2);
	expect(fake.calls.filter((x) => x.startsWith("DELETE"))).toHaveLength(2);
});
test("ASR accepts empty silence but rejects missing, nontext or oversized transcripts", async () => {
	for (const text of ["", "  ", undefined, 42, "x".repeat(4097)]) {
		const fake = fixture();
		const larm = createLarm({
			baseUrl: "http://127.0.0.1:9810",
			profile: "test-profile",
			token: "control",
			fetch: async (input, init) =>
				new URL(String(input)).pathname === "/asr/v1/audio/transcriptions"
					? result({ text })
					: fake.fetcher(input, init),
		});
		try {
			const transcript = larm.transcribe(
				new Uint8Array(44),
				new AbortController().signal,
			);
			if (typeof text === "string" && text.length <= 4096)
				expect(await transcript).toBe(text);
			else await expect(transcript).rejects.toThrow("larm_invalid_contract");
		} finally {
			await larm.close();
		}
	}
});
test("voice menu uses claimed provider auth and TTS sends selected voice and speed", async () => {
	const fake = fixture();
	let payload: unknown;
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		voice: "menu-voice",
		speed: 1.3,
		fetch: async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname === "/v1/audio/voices") {
				expect(new Headers(init?.headers).get("Authorization")).toBe(
					"Bearer control",
				);
				expect(url.searchParams.get("model")).toBe("model-tts");
				return result({
					voices: [{ id: "menu-voice", credential: "must-not-leak" }],
				});
			}
			if (url.pathname === "/tts/v1/audio/speech") {
				payload = JSON.parse(String(init?.body));
				const wav = new Uint8Array(44);
				wav.set(new TextEncoder().encode("RIFF"));
				wav.set(new TextEncoder().encode("WAVE"), 8);
				return new Response(wav);
			}
			return fake.fetcher(input, init);
		},
	});
	const signal = new AbortController().signal;
	expect(await larm.voices?.(signal)).toEqual({
		model: "model-tts",
		voices: [
			{
				id: "menu-voice",
				display_name: "menu-voice",
				styles: [],
				capabilities: {},
			},
		],
	});
	expect(fake.calls.filter((c) => c.includes("/claim"))).toHaveLength(1);
	await larm.speak("hello", signal);
	expect(payload).toMatchObject({ voice: "menu-voice", speed: 1.3 });
	await larm.close();
});
test("VOICEVOX catalog labels, style, inclusive numeric bounds and decoded credits reach phrase synthesis", async () => {
	for (const [speed, pitchScale, intonationScale] of [
		[0.5, -0.15, 0],
		[2, 0.15, 2],
	]) {
		const fake = fixture(false, "test-profile", 900000, "voicevox-core");
		let body: Record<string, unknown> = {};
		let catalogRequests = 0;
		const larm = createLarm({
			baseUrl: "http://127.0.0.1:9810",
			profile: "test-profile",
			token: "control",
			voice: "Kasukabe_Tsumugi",
			style: "normal",
			speed,
			pitchScale,
			intonationScale,
			fetch: async (input, init) => {
				const url = new URL(String(input));
				if (url.pathname === "/v1/audio/voices") {
					catalogRequests++;
					expect(url.searchParams.get("model")).toBe("voicevox-core");
					expect(new Headers(init?.headers).get("Authorization")).toBe(
						"Bearer control",
					);
					return result({
						default_voice: "Kasukabe_Tsumugi",
						voices: [
							{
								id: "Kasukabe_Tsumugi",
								display_name: "春日部つむぎ",
								default_style: "normal",
								styles: [
									{ id: "normal", display_name: "ノーマル", style_id: 8 },
								],
								capabilities: {
									speed: { minimum: 0.5, maximum: 2, default: 1 },
									pitch_scale: { minimum: -0.15, maximum: 0.15, default: 0 },
									intonation_scale: { minimum: 0, maximum: 2, default: 1 },
								},
								credit: "VOICEVOX:春日部つむぎ",
								credential: "strip-me",
							},
						],
					});
				}
				if (url.pathname === "/tts/v1/audio/speech") {
					body = JSON.parse(String(init?.body));
					const wav = new Uint8Array(44);
					wav.set(new TextEncoder().encode("RIFF"));
					wav.set(new TextEncoder().encode("WAVE"), 8);
					return new Response(wav, {
						headers: {
							"X-VOICEVOX-Credit": `UTF-8''${encodeURIComponent("VOICEVOX:春日部つむぎ")}`,
						},
					});
				}
				return fake.fetcher(input, init);
			},
		});
		const signal = new AbortController().signal;
		const catalog = await larm.voices?.(signal);
		expect(catalog?.voices[0]?.display_name).toBe("春日部つむぎ");
		expect(JSON.stringify(catalog)).not.toContain("strip-me");
		const exchanges: Array<import("../contracts").LarmExchange> = [];
		await larm.speak("こんにちは。", signal, {
			onExchange: async (exchange) => {
				exchanges.push(exchange);
			},
		});
		expect(body).toEqual({
			model: "voicevox-core",
			input: "こんにちは。",
			voice: "Kasukabe_Tsumugi",
			style: "normal",
			speed,
			pitch_scale: pitchScale,
			intonation_scale: intonationScale,
			response_format: "wav",
		});
		expect(exchanges[0]).toMatchObject({
			speechVoice: "Kasukabe_Tsumugi",
			speechCredit: "VOICEVOX:春日部つむぎ",
		});
		expect(catalogRequests).toBe(1);
		await larm.close();
	}
});
test("a refused VOICEVOX catalog does not block synthesis of a chosen voice", async () => {
	const fake = fixture(false, "test-profile", 900000, "voicevox-core");
	let body: Record<string, unknown> = {};
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		voice: "Zundamon",
		fetch: async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname === "/v1/audio/voices")
				return new Response(
					JSON.stringify({ error: { code: "unauthorized" } }),
					{
						status: 401,
					},
				);
			if (url.pathname === "/tts/v1/audio/speech") {
				body = JSON.parse(String(init?.body));
				const wav = new Uint8Array(44);
				wav.set(new TextEncoder().encode("RIFF"));
				wav.set(new TextEncoder().encode("WAVE"), 8);
				return new Response(wav);
			}
			return fake.fetcher(input, init);
		},
	});
	await larm.speak("こんにちは。", new AbortController().signal);
	expect(body).toMatchObject({ voice: "Zundamon" });
	await larm.close();
});
test("a caller's deadline that aborts a shared connection attempt does not fail other callers", async () => {
	const fake = fixture();
	let slow = true;
	let releaseSlow = () => {};
	const slowGate = new Promise<void>((resolve) => {
		releaseSlow = resolve;
	});
	let slowEntered = () => {};
	const slowStarted = new Promise<void>((resolve) => {
		slowEntered = resolve;
	});
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		voice: "v",
		fetch: async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname === "/tts/v1/audio/speech") {
				const wav = new Uint8Array(44);
				wav.set(new TextEncoder().encode("RIFF"));
				wav.set(new TextEncoder().encode("WAVE"), 8);
				return new Response(wav);
			}
			if (slow && String(input).includes("/v3/")) {
				slowEntered();
				await new Promise<void>((resolve, reject) => {
					void slowGate.then(resolve);
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{ once: true },
					);
				});
			}
			return fake.fetcher(input, init);
		},
	});
	const deadline = new AbortController();
	const first = larm.speak("a", deadline.signal).then(
		() => "ok",
		() => "aborted",
	);
	await slowStarted;
	const second = larm.speak("b", new AbortController().signal);
	deadline.abort(new DOMException("deadline", "TimeoutError"));
	expect(await first).toBe("aborted");
	slow = false;
	releaseSlow();
	expect((await second).length).toBeGreaterThanOrEqual(44);
	await larm.close();
});
test("other models omit VOICEVOX fields and busy responses never replay or replace the connection", async () => {
	for (const status of [200, 429, 422]) {
		const fake = fixture();
		let body: Record<string, unknown> = {},
			calls = 0;
		const larm = createLarm({
			baseUrl: "http://127.0.0.1:9810",
			profile: "test-profile",
			token: "control",
			style: "whisper",
			pitchScale: 0.03,
			intonationScale: 1.15,
			fetch: async (input, init) => {
				if (new URL(String(input)).pathname === "/tts/v1/audio/speech") {
					calls++;
					body = JSON.parse(String(init?.body));
					if (status !== 200)
						return Response.json(
							{ detail: "invalid style" },
							{ status, headers: { "Retry-After": "2" } },
						);
				}
				return fake.fetcher(input, init);
			},
		});
		const speech = larm.speak("確認", new AbortController().signal, {
			intonationScale: 1.8,
		});
		if (status === 200) await speech;
		else await expect(speech).rejects.toThrow(`larm_inference_${status}`);
		expect(body.style).toBeUndefined();
		expect(body.pitch_scale).toBeUndefined();
		expect(body.intonation_scale).toBeUndefined();
		expect(body.speed).toBeUndefined();
		expect(calls).toBe(1);
		expect(fake.calls.filter((c) => c.includes("/claim"))).toHaveLength(1);
		await larm.close();
	}
});
test("mismatched claim is rejected before inference and lease is released", async () => {
	const fake = fixture(true);
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		fetch: fake.fetcher,
	});
	await expect(
		larm.answer(
			[{ role: "user", content: "test" }],
			new AbortController().signal,
		),
	).rejects.toThrow("larm_claim_mismatch");
	expect(fake.calls.some((x) => x.includes("chat/completions"))).toBe(false);
	expect(fake.calls.some((x) => x.startsWith("DELETE"))).toBe(true);
});
test("oversized inference response is rejected while streaming", async () => {
	const fake = fixture();
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		fetch: async (input, init) => {
			if (new URL(String(input)).pathname === "/tts/v1/audio/speech") {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(16_000_001));
							controller.close();
						},
					}),
				);
			}
			return fake.fetcher(input, init);
		},
	});
	await expect(
		larm.speak("test", new AbortController().signal),
	).rejects.toThrow("larm_response_too_large");
	await larm.close();
});
test("simultaneous capability upgrades share one replacement connection", async () => {
	jest.useFakeTimers();
	const fake = fixture();
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		fetch: fake.fetcher,
	});
	const signal = new AbortController().signal;
	try {
		// The conversation lease holds only the llm provider; speech then upgrades it.
		await driveFakeTimers(larm.connect(), 1000);
		await driveFakeTimers(
			Promise.all([larm.speak("回答 1", signal), larm.speak("回答 2", signal)]),
			1000,
		);
		expect(
			fake.calls.filter((call) => call === "POST /v1/agent-connections"),
		).toHaveLength(2);
	} finally {
		jest.useRealTimers();
		await larm.close();
	}
});
test("The saved profile is requested and renews by reclaiming the rotated token", async () => {
	const fake = fixture(false, "test-profile-large", 60_000);
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile-large",
		token: "control",
		fetch: fake.fetcher,
	});
	const signal = new AbortController().signal;
	expect(await larm.answer([{ role: "user", content: "一回目" }], signal)).toBe(
		"承知しました",
	);
	expect(await larm.answer([{ role: "user", content: "二回目" }], signal)).toBe(
		"承知しました",
	);
	expect(fake.requests).toHaveLength(1);
	expect(fake.requests[0]).toMatchObject({
		profile: "test-profile-large",
		audience: "saaa-desktop",
		client: expect.stringMatching(/^eumenes-client-/),
		providers: ["llm"],
		ttlSeconds: 900,
		allowFallback: false,
		deploymentPolicy: "existing-only",
	});
	expect(fake.calls.filter((call) => call.endsWith("/renew"))).toHaveLength(1);
	expect(fake.calls.filter((call) => call.endsWith("/claim"))).toHaveLength(2);
	expect(
		fake.calls.filter(
			(call) => call === "GET /v1/agent-connections/connection1",
		),
	).toHaveLength(1);
	await larm.close();
});
test("voice requests every provider in the saved profile", async () => {
	const fake = fixture(false, "test-profile-large");
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile-large",
		token: "control",
		fetch: fake.fetcher,
	});
	expect(
		await larm.transcribe(new Uint8Array(44), new AbortController().signal),
	).toBe("こんにちは");
	expect(fake.requests).toHaveLength(1);
	expect("providers" in fake.requests[0]!).toBe(false);
	await larm.close();
});
test("an expired connection stops polling and is released", async () => {
	const fake = fixture(false, "test-profile-large");
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile-large",
		token: "control",
		fetch: async (input, init) => {
			const response = await fake.fetcher(input, init);
			if (
				new URL(String(input)).pathname === "/v1/agent-connections" &&
				init?.method === "POST"
			)
				return result({ id: "connection1", status: "expired" }, 201);
			return response;
		},
	});
	await expect(
		larm.answer(
			[{ role: "user", content: "test" }],
			new AbortController().signal,
		),
	).rejects.toThrow("larm_connection_expired");
	expect(
		fake.calls.some((call) => call === "GET /v1/agent-connections/connection1"),
	).toBe(false);
	expect(
		fake.calls.some(
			(call) => call === "DELETE /v1/agent-connections/connection1",
		),
	).toBe(true);
});

test("an explicit baseUrl is the only control origin the token is sent to", async () => {
	const fake = fixture(false, "test-profile-large");
	const origins: string[] = [];
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		token: "control",
		profile: "test-profile-large",
		audience: "",
		fetch: async (input, init) => {
			origins.push(new URL(String(input)).origin);
			return fake.fetcher(input, init);
		},
	});
	expect(larm.status().state).toBe("idle");
	await larm.connect();
	expect(larm.status()).toEqual({ state: "ready", capabilities: ["llm"] });
	expect(origins.every((origin) => origin === "http://127.0.0.1:9810")).toBe(
		true,
	);
	await larm.close();
});

test("without a baseUrl LARM stays unconfigured and never contacts any host", async () => {
	let contacted = 0;
	for (const baseUrl of [undefined, "", "  "]) {
		const larm = createLarm({
			baseUrl,
			token: "control",
			fetch: async () => {
				contacted++;
				return result({});
			},
		});
		expect(larm.status()).toEqual({
			state: "unconfigured",
			capabilities: [],
			error: "larm_base_url_unconfigured",
		});
		await expect(larm.connect()).rejects.toThrow("larm_base_url_unconfigured");
		await expect(
			larm.answer(
				[{ role: "user", content: "x" }],
				new AbortController().signal,
			),
		).rejects.toThrow("larm_base_url_unconfigured");
		await larm.close();
	}
	expect(contacted).toBe(0);
});

test("missing claim voice discovers and caches the advertised default with the control credential", async () => {
	const fake = fixture();
	let discoveries = 0;
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		voice: "",
		fetch: async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname === "/v1/audio/voices") {
				discoveries++;
				expect(url.origin).toBe("http://127.0.0.1:9810");
				expect(url.searchParams.get("model")).toBe("model-tts");
				expect(new Headers(init?.headers).get("Authorization")).toBe(
					"Bearer control",
				);
				return result({
					default_voice: "fixture-voice",
					voices: [{ id: "fixture-voice" }],
				});
			}
			const response = await fake.fetcher(input, init);
			if (url.pathname.endsWith("/claim")) {
				const claim = await response.json();
				for (const provider of claim.providers)
					delete provider.configuration.fields.voice;
				return result(claim);
			}
			return response;
		},
	});
	try {
		const signal = new AbortController().signal;
		expect((await larm.speak("確認", signal)).length).toBe(44);
		expect((await larm.speak("再確認", signal)).length).toBe(44);
		expect(discoveries).toBe(1);
	} finally {
		await larm.close();
	}
});

test("an unadvertised default voice is rejected before speech inference", async () => {
	const fake = fixture();
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		fetch: async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname === "/v1/audio/voices")
				return result({
					default_voice: "missing",
					voices: [{ id: "fixture-voice" }],
				});
			const response = await fake.fetcher(input, init);
			if (url.pathname.endsWith("/claim")) {
				const claim = await response.json();
				for (const provider of claim.providers)
					delete provider.configuration.fields.voice;
				return result(claim);
			}
			return response;
		},
	});
	try {
		await expect(
			larm.speak("確認", new AbortController().signal),
		).rejects.toThrow("larm_invalid_voice_catalog");
		expect(fake.calls.some((call) => call.includes("/audio/speech"))).toBe(
			false,
		);
	} finally {
		await larm.close();
	}
});

test("cancelling a caller returns promptly during allocation and close stops polling", async () => {
	const fake = fixture(false, "test-profile-large");
	let allocated = false;
	let onAllocated = () => {};
	const allocatedSeen = new Promise<void>((resolve) => {
		onAllocated = resolve;
	});
	let observedSignal: AbortSignal | null | undefined;
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile-large",
		token: "control",
		fetch: async (input, init) => {
			const response = await fake.fetcher(input, init);
			if (
				new URL(String(input)).pathname === "/v1/agent-connections" &&
				init?.method === "POST"
			) {
				allocated = true;
				onAllocated();
				observedSignal = init.signal;
				return result({ id: "connection1", status: "pending" }, 202);
			}
			return response;
		},
	});
	const controller = new AbortController();
	const answer = larm.answer(
		[{ role: "user", content: "test" }],
		controller.signal,
	);
	await allocatedSeen;
	expect(allocated).toBe(true);
	controller.abort(new Error("cancelled"));
	await expect(answer).rejects.toThrow("cancelled");
	await larm.close();
	expect(observedSignal?.aborted).toBe(true);
	expect(
		fake.calls.some((call) => call === "GET /v1/agent-connections/connection1"),
	).toBe(false);
	expect(
		fake.calls.some(
			(call) => call === "DELETE /v1/agent-connections/connection1",
		),
	).toBe(true);
});

test("runtime changes notify connecting and ready/failed without exposing credentials", async () => {
	for (const mismatch of [false, true]) {
		const fake = fixture(mismatch);
		const larm = createLarm({
			baseUrl: "http://127.0.0.1:9810",
			profile: "test-profile",
			token: "control",
			fetch: fake.fetcher,
		});
		const observed: ReturnType<typeof larm.status>[] = [];
		const stop = larm.onChange!(() => observed.push(larm.status()));
		try {
			await larm.connect().catch(() => {});
			expect(observed.map((s) => s.state)).toEqual([
				"connecting",
				mismatch ? "failed" : "ready",
			]);
			expect(JSON.stringify(observed)).not.toContain("secret-");
			stop();
			await larm.close();
			expect(observed).toHaveLength(2);
		} finally {
			stop();
			await larm.close();
		}
	}
});

// Give each created connection a distinct ID, preserving the public fixture contract.
function lifecycleFixture(initialExpiryMs = 900_000) {
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
const idleMessage =
	"provider bearer token belongs to an idle-released connection";
const idleReleased = () =>
	result(
		{ error: { code: "connection_idle_released", message: idleMessage } },
		409,
	);
const question = [{ role: "user" as const, content: "確認" }];
const freshSignal = () => new AbortController().signal;
function makeLarm(
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
async function driveFakeTimers<T>(work: Promise<T>, stepMs: number) {
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

test("idle-released JSON before SSE recreates and claims once; both exchanges survive", async () => {
	const fake = lifecycleFixture();
	let calls = 0;
	const larm = makeLarm(async (input, init) => {
		if (String(input).endsWith("chat/completions")) {
			if (!calls++) return idleReleased();
			return new Response(
				'data: {"choices":[{"delta":{"content":"承知"}}]}\n\ndata: {"choices":[{"delta":{"content":"しました"}}]}\n\ndata: [DONE]\n\n',
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		}
		return fake.fetcher(input, init);
	});
	const exchanges: import("..").LarmExchange[] = [];
	const deltas: string[] = [];
	try {
		expect(
			await larm.answerStream!(question, freshSignal(), (x) => deltas.push(x), {
				onExchange: async (x) => {
					exchanges.push(x);
				},
			}),
		).toBe("承知しました");
		expect(deltas).toEqual(["承知", "しました"]);
		expect(exchanges).toMatchObject([
			{
				connectionId: "connection1",
				httpStatus: 409,
				errorCode: "connection_idle_released",
				errorMessage: idleMessage,
			},
			{ connectionId: "connection2", httpStatus: 200 },
		]);
		expect(fake.generation()).toBe(2);
		expect(larm.inspect?.().connectionId).toBe("connection2");
	} finally {
		await larm.close();
	}
});

test("local idle expires a still-valid lease without requests; next voice use requests the profile again", async () => {
	jest.useFakeTimers();
	const fake = lifecycleFixture();
	const larm = makeLarm(fake.fetcher, 35);
	try {
		await larm.prepareVoice!(freshSignal());
		const count = fake.calls.length;
		jest.advanceTimersByTime(55);
		expect(larm.status()).toMatchObject({ state: "idle", capabilities: [] });
		expect(larm.inspect?.().connectionId).toBeUndefined();
		expect(fake.calls).toHaveLength(count);
		expect(await larm.transcribe(new Uint8Array(44), freshSignal())).toBe(
			"こんにちは",
		);
		expect(larm.inspect?.().connectionId).toBe("connection2");
		expect(fake.requests[1]).toMatchObject({
			profile: "test-profile",
		});
	} finally {
		jest.useRealTimers();
		await larm.close();
	}
});

test("an active inference pauses the local idle timer and completion starts a new idle interval", async () => {
	jest.useFakeTimers();
	const fake = lifecycleFixture();
	let ready: () => void = () => {};
	const entered = new Promise<void>((resolve) => {
		ready = resolve;
	});
	let complete: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		complete = resolve;
	});
	const larm = makeLarm(async (input, init) => {
		if (String(input).endsWith("chat/completions")) {
			ready();
			await gate;
		}
		return fake.fetcher(input, init);
	}, 40);
	try {
		const work = larm.answer(question, freshSignal());
		await entered;
		jest.advanceTimersByTime(65);
		expect(larm.status().state).toBe("ready");
		complete();
		await work;
		expect(larm.status().state).toBe("ready");
		jest.advanceTimersByTime(60);
		expect(larm.status().state).toBe("idle");
	} finally {
		jest.useRealTimers();
		complete();
		await larm.close();
	}
});

test("only the explicit idle-released 409 can replay, and recovery is bounded at one replacement", async () => {
	for (const [status, body, calls] of [
		[409, { error: { code: "connection_idle_released" } }, 2],
		[409, { error: { code: "capacity_exceeded" } }, 1],
		[409, { error: { message: "conflict" } }, 1],
		[401, { error: { code: "connection_idle_released" } }, 1],
	] as const) {
		const fake = lifecycleFixture();
		let inferred = 0;
		const larm = makeLarm(async (input, init) => {
			if (String(input).endsWith("chat/completions")) {
				inferred++;
				return result(body, status);
			}
			return fake.fetcher(input, init);
		});
		try {
			await expect(larm.answer(question, freshSignal())).rejects.toThrow(
				`larm_inference_${status}`,
			);
			expect(inferred).toBe(calls);
			expect(fake.generation()).toBe(calls);
		} finally {
			await larm.close();
		}
	}
});

test("cancellation after the 409 diagnostic prevents replacement and replay", async () => {
	const fake = lifecycleFixture();
	const controller = new AbortController();
	const larm = makeLarm(async (input, init) =>
		String(input).endsWith("chat/completions")
			? idleReleased()
			: fake.fetcher(input, init),
	);
	try {
		await expect(
			larm.answer(question, controller.signal, {
				onExchange: async () => {
					controller.abort();
				},
			}),
		).rejects.toThrow();
		expect(fake.generation()).toBe(1);
	} finally {
		await larm.close();
	}
});

test("manual connection check follows released state even with unexpired credentials", async () => {
	const fake = lifecycleFixture();
	let released = false;
	const larm = makeLarm(async (input, init) => {
		if (
			released &&
			new URL(String(input)).pathname === "/v1/agent-connections/connection1" &&
			init?.method === "GET"
		)
			return result({
				id: "connection1",
				status: "released",
				releaseReason: "foreground_idle_timeout",
			});
		return fake.fetcher(input, init);
	});
	try {
		await larm.connect();
		released = true;
		await larm.connect();
		expect(fake.generation()).toBe(2);
		expect(larm.status().state).toBe("ready");
	} finally {
		await larm.close();
	}
});

test("renew rotates every claimed provider while leaving the idle deadline unchanged", async () => {
	jest.useFakeTimers();
	const fake = lifecycleFixture(60000);
	const tokens: string[] = [];
	const larm = makeLarm(async (input, init) => {
		if (/\/(llm|asr|tts)\/v1\//.test(String(input)))
			tokens.push(new Headers(init?.headers).get("Authorization")!);
		return fake.fetcher(input, init);
	}, 120);
	try {
		await larm.prepareVoice!(freshSignal());
		await larm.connect();
		await larm.answer(question, freshSignal());
		await larm.transcribe(new Uint8Array(44), freshSignal());
		await larm.speak("確認", freshSignal());
		expect(tokens).toEqual([
			"Bearer secret-llm-2",
			"Bearer secret-asr-2",
			"Bearer secret-tts-2",
		]);
		const before = fake.calls.length;
		jest.advanceTimersByTime(70);
		await larm.connect();
		jest.advanceTimersByTime(70);
		expect(larm.status().state).toBe("idle");
		expect(fake.calls.length).toBe(before + 1); // health check only; no idle keepalive
	} finally {
		jest.useRealTimers();
		await larm.close();
	}
});

test("published SSE prefix errors never reconnect or replay inference", async () => {
	const fake = lifecycleFixture();
	const larm = makeLarm(async (input, init) =>
		String(input).endsWith("chat/completions")
			? new Response('data: {"choices":[{"delta":{"content":"回答"}}]}\n\n', {
					headers: { "Content-Type": "text/event-stream" },
				})
			: fake.fetcher(input, init),
	);
	const deltas: string[] = [];
	try {
		await expect(
			larm.answerStream!(question, freshSignal(), (x) => deltas.push(x)),
		).rejects.toThrow();
		expect(deltas).toEqual(["回答"]);
		expect(fake.generation()).toBe(1);
	} finally {
		await larm.close();
	}
});

test("idle expiry during a health check cannot revive the released local lease", async () => {
	jest.useFakeTimers();
	const fake = lifecycleFixture();
	let checking = false;
	const larm = makeLarm(async (input, init) => {
		if (
			checking &&
			new URL(String(input)).pathname === "/v1/agent-connections/connection1" &&
			init?.method === "GET"
		)
			jest.advanceTimersByTime(65); // the check outlives the idle deadline
		return fake.fetcher(input, init);
	}, 40);
	try {
		await larm.connect();
		checking = true;
		await larm.connect();
		expect(larm.inspect?.().connectionId).toBe("connection2");
		expect(larm.status().state).toBe("ready");
	} finally {
		jest.useRealTimers();
		await larm.close();
	}
});

test("invalid reclaim after renew discards every old credential before another request", async () => {
	const fake = lifecycleFixture(60000);
	let claims = 0,
		inferred = 0;
	const larm = makeLarm(async (input, init) => {
		if (/\/(llm|asr|tts)\/v1\//.test(String(input))) inferred++;
		const response = await fake.fetcher(input, init);
		if (String(input).endsWith("/claim") && ++claims === 2) {
			const body = (await response.json()) as {
				providers: Array<{ name: string; model: string }>;
			};
			body.providers.find((p) => p.name === "tts")!.model = "wrong-model";
			return result(body);
		}
		return response;
	});
	try {
		await larm.prepareVoice!(freshSignal());
		await expect(larm.connect()).rejects.toThrow("larm_renew_claim_mismatch");
		expect(larm.inspect?.().providers).toEqual([]);
		expect(inferred).toBe(0);
		expect(await larm.transcribe(new Uint8Array(44), freshSignal())).toBe(
			"こんにちは",
		);
		expect(larm.inspect?.().connectionId).toBe("connection2");
	} finally {
		await larm.close();
	}
});

test("a ready connection waits for requested providers to become claimable before claim", async () => {
	jest.useFakeTimers();
	const fake = lifecycleFixture();
	let checks = 0;
	const larm = makeLarm(async (input, init) => {
		const response = await fake.fetcher(input, init);
		if (
			new URL(String(input)).pathname === "/v1/agent-connections" &&
			init?.method === "POST"
		) {
			const body = (await response.json()) as {
				providers: Array<{ readiness: string; claimable: boolean }>;
			};
			for (const p of body.providers) {
				p.readiness = "warming";
				p.claimable = false;
			}
			return result(body, 201);
		}
		if (
			new URL(String(input)).pathname === "/v1/agent-connections/connection1" &&
			init?.method === "GET"
		)
			checks++;
		return response;
	});
	try {
		await driveFakeTimers(larm.connect(), 1000);
		expect(checks).toBe(1);
		expect(larm.status().state).toBe("ready");
		expect(fake.calls.filter((c) => c.endsWith("/claim"))).toHaveLength(1);
	} finally {
		jest.useRealTimers();
		await larm.close();
	}
});

test("unauthorized can recover only when control confirms the old connection is released", async () => {
	for (const state of ["ready", "released"]) {
		const fake = lifecycleFixture();
		let inferred = 0,
			checks = 0;
		const larm = makeLarm(async (input, init) => {
			const path = new URL(String(input)).pathname;
			if (
				path === "/v1/agent-connections/connection1" &&
				init?.method === "GET"
			) {
				checks++;
				if (state === "released")
					return result({ id: "connection1", status: "released" });
			}
			if (String(input).endsWith("chat/completions") && ++inferred === 1)
				return result(
					{
						error: {
							code: "unauthorized",
							message: "provider bearer token is no longer valid",
						},
					},
					401,
				);
			return fake.fetcher(input, init);
		});
		try {
			if (state === "released") {
				expect(await larm.answer(question, freshSignal())).toBe("承知しました");
				expect(fake.generation()).toBe(2);
			} else {
				await expect(larm.answer(question, freshSignal())).rejects.toThrow(
					"larm_inference_401",
				);
				expect(fake.generation()).toBe(1);
			}
			expect(checks).toBe(1);
		} finally {
			await larm.close();
		}
	}
});

test("context trimming retains the current input after an unanswered prior turn", async () => {
	const fake = fixture();
	const latest = { role: "user" as const, content: "今回の質問" };
	let sent: unknown;
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		fetch: async (input, init) => {
			if (new URL(String(input)).pathname.endsWith("chat/completions"))
				sent = JSON.parse(String(init?.body)).messages;
			return fake.fetcher(input, init);
		},
	});
	try {
		await larm.answer(
			[
				{ role: "system", content: "system" },
				{ role: "user", content: "x".repeat(4000) },
				latest,
			],
			new AbortController().signal,
		);
		expect(sent).toEqual([{ role: "system", content: "system" }, latest]);
	} finally {
		await larm.close();
	}
});

test("native decision shares the voice lease, uses its own auth, and rotates credentials", async () => {
	const fake = fixture(false, "test-profile", 60000, "model-tts", true);
	const bodies: unknown[] = [],
		tokens: (string | null)[] = [];
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		fetch: async (input, init) => {
			if (new URL(String(input)).pathname === "/system-one/v1/systemone") {
				bodies.push(JSON.parse(String(init?.body)));
				const headers = new Headers(init?.headers);
				tokens.push(headers.get("Authorization"));
				expect(headers.get("Accept")).toBe("application/json");
				return result({
					answers: {
						motion: { type: "choice", choice: "greeting", confidence: 0.9 },
					},
				});
			}
			return fake.fetcher(input, init);
		},
	});
	try {
		await larm.prepareVoice!(freshSignal());
		const questions = {
			motion: {
				type: "choice" as const,
				instructions: "choose",
				criteria: { greeting: "hello" },
			},
		};
		await larm.judge!({ utterance: "こんにちは" }, questions, freshSignal());
		await larm.speak("こんにちは", freshSignal());
		expect(bodies).toEqual([
			{
				model: "model-system-one",
				state: { utterance: "こんにちは" },
				questions,
			},
		]);
		expect(tokens).toEqual(["Bearer secret-system-one-2"]);
		expect(fake.requests).toHaveLength(1);
		expect(larm.status().capabilities).toEqual(["llm", "asr", "tts"]);
		expect(fake.calls.filter((c) => c.endsWith("/renew"))).toHaveLength(1);
	} finally {
		await larm.close();
	}
});

test("absent or invalid optional decision never breaks ordinary voice providers", async () => {
	for (const present of [false, true]) {
		const fake = fixture(false, "test-profile", 900000, "model-tts", present);
		const larm = createLarm({
			baseUrl: "http://127.0.0.1:9810",
			profile: "test-profile",
			token: "control",
			fetch: async (input, init) => {
				const response = await fake.fetcher(input, init);
				if (present && String(input).endsWith("/claim")) {
					const body = (await response.json()) as {
						providers: Array<{
							name: string;
							configuration: { fields: Record<string, string> };
						}>;
					};
					body.providers.find(
						(p) => p.name === "system-one",
					)!.configuration.fields.daemonURL = "http://wrong.invalid";
					return result(body);
				}
				return response;
			},
		});
		try {
			await larm.prepareVoice!(freshSignal());
			await expect(
				larm.judge!({ utterance: "hello" }, {}, freshSignal()),
			).rejects.toThrow("larm_system_one_unavailable");
			expect(await larm.transcribe(new Uint8Array(44), freshSignal())).toBe(
				"こんにちは",
			);
			expect((await larm.speak("hello", freshSignal())).length).toBe(44);
			expect(fake.requests).toHaveLength(1);
		} finally {
			await larm.close();
		}
	}
});

test("inference timing and token usage are logged without prompt or answer text", async () => {
	const { configureLogging } = await import("../../../infrastructure/logger");
	const lines: string[] = [];
	configureLogging({
		level: "info",
		destination: {
			write: (line) => {
				lines.push(line);
			},
		},
	});
	const fake = fixture();
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		token: "control",
		profile: "test-profile",
		fetch: async (input, init) =>
			new URL(String(input)).pathname === "/llm/v1/chat/completions"
				? new Response(
						'data: {"choices":[{"delta":{"content":"secret-answer"}}]}\n\n' +
							'data: {"usage":{"prompt_tokens":120,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":100},"total_tokens":"n/a"}}\n\n' +
							"data: [DONE]\n\n",
						{ headers: { "content-type": "text/event-stream" } },
					)
				: fake.fetcher(input, init),
	});
	try {
		const deltas: string[] = [];
		await larm.answerStream!(
			[
				{ role: "system", content: "secret-policy" },
				{ role: "user", content: "secret-question" },
			],
			new AbortController().signal,
			(text) => deltas.push(text),
		);
		expect(deltas.join("")).toBe("secret-answer");
		const entries = lines
			.map((line) => JSON.parse(line))
			.filter((line) => line.event === "larm.llm_timing");
		const entry = entries.at(-1);
		expect(entry).toMatchObject({
			level: "info",
			profile: "main",
			droppedMessages: 0,
			promptTokens: 120,
			completionTokens: 7,
			cachedTokens: 100,
		});
		expect(entry.requestBytes).toBeGreaterThan(0);
		expect(entry.totalMs).toBeGreaterThanOrEqual(0);
		expect(entry.ttftMs).toBeGreaterThanOrEqual(0);
		expect(entry.totalMs).toBeGreaterThanOrEqual(entry.ttftMs);
		expect(entry.total_tokens).toBeUndefined();
		for (const text of ["secret-answer", "secret-policy", "secret-question"])
			expect(lines.join("\n")).not.toContain(text);
	} finally {
		await larm.close();
	}
});

test("the timing log reports the sent body size on success and outcome=error when the stream is cut", async () => {
	const { configureLogging } = await import("../../../infrastructure/logger");
	const lines: string[] = [];
	configureLogging({
		level: "info",
		destination: {
			write: (line) => {
				lines.push(line);
			},
		},
	});
	try {
		for (const complete of [true, false]) {
			const fake = fixture();
			let sent: { messages: unknown } | undefined;
			const larm = createLarm({
				baseUrl: "http://127.0.0.1:9810",
				token: "control",
				profile: "test-profile",
				fetch: async (input, init) => {
					if (new URL(String(input)).pathname !== "/llm/v1/chat/completions")
						return fake.fetcher(input, init);
					sent = JSON.parse(String(init?.body));
					return new Response(
						'data: {"choices":[{"delta":{"content":"secret-answer"}}]}\n\n' +
							(complete ? "data: [DONE]\n\n" : ""),
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			});
			try {
				lines.length = 0;
				const outcome = larm.answerStream!(
					[
						{ role: "system", content: "secret-policy" },
						{ role: "user", content: "secret-question" },
					],
					new AbortController().signal,
					() => {},
				).catch((error) => error);
				const value = await outcome;
				expect(value instanceof Error).toBe(!complete);
				const entry = lines
					.map((line) => JSON.parse(line))
					.filter((line) => line.event === "larm.llm_timing")
					.at(-1);
				expect(entry?.outcome).toBe(complete ? "ok" : "error");
				expect(entry?.level).toBe(complete ? "info" : "warn");
				expect(entry?.requestBytes).toBe(
					new TextEncoder().encode(JSON.stringify(sent?.messages)).length,
				);
				expect(entry?.totalMs).toBeGreaterThanOrEqual(0);
				for (const text of [
					"secret-answer",
					"secret-policy",
					"secret-question",
				])
					expect(lines.join("\n")).not.toContain(text);
			} finally {
				await larm.close();
			}
		}
	} finally {
		configureLogging({ level: "silent" });
	}
});

test("caller cancellation is logged separately from a provider network failure", async () => {
	const { configureLogging } = await import("../../../infrastructure/logger");
	const lines: string[] = [];
	configureLogging({
		level: "info",
		destination: {
			write: (line) => {
				lines.push(line);
			},
		},
	});
	try {
		for (const cancelled of [true, false]) {
			const fake = fixture();
			let began = () => {};
			const started = new Promise<void>((resolve) => {
				began = resolve;
			});
			const controller = new AbortController();
			const larm = createLarm({
				baseUrl: "http://127.0.0.1:9810",
				token: "control",
				profile: "test-profile",
				fetch: async (input, init) => {
					if (new URL(String(input)).pathname === "/llm/v1/chat/completions") {
						began();
						if (!cancelled) throw new TypeError("network down");
						return new Promise<Response>((_resolve, reject) => {
							init?.signal?.addEventListener(
								"abort",
								() => reject(init.signal?.reason),
								{ once: true },
							);
						});
					}
					return fake.fetcher(input, init);
				},
			});
			try {
				const outcome = larm
					.answer([{ role: "user", content: "test" }], controller.signal)
					.catch((error) => error);
				await started;
				if (cancelled) controller.abort(new Error("cancelled"));
				expect(await outcome).toBeInstanceOf(Error);
				const event = cancelled
					? "larm.inference_cancelled"
					: "larm.inference_unreachable";
				for (
					let i = 0;
					i < 20 && !lines.some((line) => JSON.parse(line).event === event);
					i++
				)
					await new Promise((resolve) => setImmediate(resolve));
				const entry = lines
					.map((line) => JSON.parse(line))
					.find((line) => line.event === event);
				expect(entry?.reason).toBe(
					cancelled ? "cancelled" : "network_unavailable",
				);
				expect(entry?.level).toBe(cancelled ? "info" : "warn");
				if (cancelled)
					expect(
						lines.some(
							(line) => JSON.parse(line).event === "larm.inference_unreachable",
						),
					).toBe(false);
			} finally {
				await larm.close();
			}
		}
	} finally {
		configureLogging({ level: "silent" });
	}
});

test("Ruri uses claimed model/token and current chunk only; rejects unsupported questions before provider request", async () => {
	const fake = fixture(false, "test-profile-large", 900000, "model-tts", true);
	const ruri = "ruri-v3-30m-speaking-attitude";
	let calls = 0;
	const bodies: Record<string, unknown>[] = [];
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile-large",
		token: "control",
		fetch: async (input, init) => {
			if (new URL(String(input)).pathname === "/system-one/v1/systemone") {
				calls++;
				bodies.push(JSON.parse(String(init?.body)));
				expect(new Headers(init?.headers).get("Authorization")).toBe(
					"Bearer secret-system-one-1",
				);
				return result({
					model: ruri,
					answers: {
						emotion: {
							type: "choice",
							choice: "none",
							confidence: 0.9,
							answer_confidence: 0.9,
						},
					},
				});
			}
			const response = await fake.fetcher(input, init);
			if (response.headers.get("content-type")?.includes("application/json")) {
				const body = await response.text();
				return new Response(body.replaceAll("model-system-one", ruri), {
					status: response.status,
					headers: response.headers,
				});
			}
			return response;
		},
	});
	try {
		await larm.prepareVoice!(freshSignal());
		expect(larm.decisionModel?.()).toBe(ruri);
		expect(larm.inspect?.().decisionModel).toBe(ruri);
		const q = {
			emotion: {
				type: "choice" as const,
				instructions: "現在の回答をアシスタント自身が話す表情と声色",
				criteria: { none: "通常", warmth: "親しみ" },
			},
		};
		await larm.judge!(
			{
				current_chunk: "現在",
				response: "旧互換",
				conversation: "送らない",
				user_utterance: "送らない",
			},
			q,
			freshSignal(),
		);
		await larm.judge!({ response: "旧互換" }, q, freshSignal());
		expect(bodies.map((b) => b.state)).toEqual([
			{ current_chunk: "現在" },
			{ current_chunk: "旧互換" },
		]);
		expect(bodies[0]!.model).toBe(ruri);
		for (const criteria of [
			{ refund: "返金", none: "通常" },
			{ warmth: "親しみ" },
		] as Array<Record<string, string>>)
			await expect(
				larm.judge!(
					{ current_chunk: "現在" },
					{ emotion: { ...q.emotion, criteria } },
					freshSignal(),
				),
			).rejects.toThrow("larm_invalid_ruri_question");
		expect(calls).toBe(2);
	} finally {
		await larm.close();
	}
});

// RT-11: control timeouts, idempotency, caller abort, close, renewal.
test("control POSTs keep the 15 s budget while status GETs with a caller signal use 3 s", async () => {
	const fake = fixture();
	const timeouts: number[] = [];
	const spy = spyOn(AbortSignal, "timeout");
	const seen: Array<[string, string, number | undefined]> = [];
	const larm = makeLarm(async (input, init) => {
		const timeout = spy.mock.calls.at(-1)?.[0];
		timeouts.push(Number(timeout));
		seen.push([
			init?.method ?? "GET",
			new URL(String(input)).pathname,
			timeout,
		]);
		return fake.fetcher(input, init);
	});
	try {
		await larm.probe!(freshSignal());
		const timeoutOf = (method: string, path: string) =>
			seen.find(([m, p]) => m === method && p === path)?.[2];
		expect(timeoutOf("POST", "/v1/agent-connections")).toBe(15_000);
		expect(timeoutOf("POST", "/v1/agent-connections/connection1/claim")).toBe(
			15_000,
		);
		expect(timeoutOf("GET", "/v3/agent-profiles")).toBe(3_000);
	} finally {
		spy.mockRestore();
		await larm.close();
	}
});

test("a timed-out connection POST is retried with the same Idempotency-Key", async () => {
	const fake = fixture();
	const keys: Array<string | null> = [];
	let failed = false;
	const larm = makeLarm(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/v1/agent-connections" && init?.method === "POST") {
			keys.push(new Headers(init.headers).get("Idempotency-Key"));
			if (!failed) {
				failed = true;
				throw new DOMException("timed out", "TimeoutError");
			}
		}
		return fake.fetcher(input, init);
	});
	try {
		await larm.connect();
		expect(keys).toHaveLength(2);
		expect(keys[0]).toBeTruthy();
		expect(keys[1]).toBe(keys[0]);
		expect(larm.status().state).toBe("ready");
	} finally {
		await larm.close();
	}
});

test("a caller abort during renewal neither fails the status nor releases the shared lease", async () => {
	const fake = fixture(false, "test-profile", 185_000);
	const controller = new AbortController();
	let skew = 0;
	const realNow = Date.now.bind(Date);
	const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew);
	const larm = makeLarm(async (input, init) => {
		if (new URL(String(input)).pathname.endsWith("/renew")) {
			controller.abort();
			throw controller.signal.reason;
		}
		return fake.fetcher(input, init);
	});
	try {
		await larm.probe!(freshSignal());
		// Move past the 180 s renewal margin without waiting; the renew timer is real.
		skew = 20_000;
		await expect(larm.probe!(controller.signal)).rejects.toThrow();
		expect(larm.status()).toEqual({ state: "ready", capabilities: ["llm"] });
		expect(larm.inspect?.().connectionId).toBe("connection1");
		expect(fake.calls.some((call) => call.startsWith("DELETE"))).toBe(false);
	} finally {
		clock.mockRestore();
		await larm.close();
	}
});

test("close waits for in-use leases before sending DELETE", async () => {
	jest.useFakeTimers();
	const fake = fixture();
	const order: string[] = [];
	let entered: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let complete: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		complete = resolve;
	});
	const larm = makeLarm(async (input, init) => {
		if (init?.method === "DELETE") order.push("delete");
		if (String(input).endsWith("audio/transcriptions")) {
			entered();
			await gate;
		}
		return fake.fetcher(input, init);
	});
	const work = larm
		.transcribe(new Uint8Array(44), freshSignal())
		.then((text) => {
			order.push("transcribed");
			return text;
		});
	await started;
	const closing = larm.close();
	for (let i = 0; i < 25; i++)
		await new Promise((resolve) => setImmediate(resolve));
	expect(order).toEqual([]);
	complete();
	try {
		expect(await work).toBe("こんにちは");
		await driveFakeTimers(closing, 100);
		expect(order).toEqual(["transcribed", "delete"]);
	} finally {
		jest.useRealTimers();
	}
});

test("a valid lease serves new inference while a renewal is still waiting", async () => {
	const fake = fixture(false, "test-profile", 120_000);
	let renewing: () => void = () => {};
	const renewStarted = new Promise<void>((resolve) => {
		renewing = resolve;
	});
	let finishRenewal: () => void = () => {};
	const renewGate = new Promise<void>((resolve) => {
		finishRenewal = resolve;
	});
	const larm = makeLarm(async (input, init) => {
		if (new URL(String(input)).pathname.endsWith("/renew")) {
			renewing();
			await renewGate;
		}
		return fake.fetcher(input, init);
	});
	try {
		await larm.probe!(freshSignal());
		await renewStarted;
		expect(larm.status().state).toBe("connecting");
		// a blocked answer hangs here and fails through the test timeout
		expect(await larm.answer(question, freshSignal())).toBe("承知しました");
	} finally {
		finishRenewal();
		await larm.close();
	}
});

// SEC-4: provider hosts are pinned to the LARM host or an explicit allow-list.
function claimAt(
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
test("a provider on the LARM host with another port is accepted", async () => {
	const fake = fixture();
	const larm = makeLarm(claimAt(fake.fetcher, "http://127.0.0.1:8080"));
	try {
		expect(await larm.answer(question, freshSignal())).toBe("承知しました");
		expect(larm.inspect?.().providers[0]?.baseUrl).toBe(
			"http://127.0.0.1:8080/llm/v1",
		);
	} finally {
		await larm.close();
	}
});
test("a provider on a different private host is rejected before any token is sent", async () => {
	const fake = fixture();
	const inferred: string[] = [];
	const larm = makeLarm(
		claimAt(async (input, init) => {
			if (new URL(String(input)).pathname.startsWith("/llm/"))
				inferred.push(String(input));
			return fake.fetcher(input, init);
		}, "http://10.9.9.9"),
	);
	try {
		for (const host of ["http://10.9.9.9", "http://other.local"]) {
			const mismatched = makeLarm(claimAt(fake.fetcher, host));
			await expect(mismatched.answer(question, freshSignal())).rejects.toThrow(
				"larm_provider_host_mismatch",
			);
			expect(mismatched.status()).toMatchObject({
				state: "failed",
				error: "larm_provider_host_mismatch",
			});
			await mismatched.close();
		}
		await expect(larm.answer(question, freshSignal())).rejects.toThrow(
			"larm_provider_host_mismatch",
		);
		expect(inferred).toEqual([]);
	} finally {
		await larm.close();
	}
});
test("the providerHosts config allows another host and the environment is not read", async () => {
	const fake = fixture();
	const configured = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		providerHosts: ["10.9.9.9", "Other.LOCAL"],
		fetch: claimAt(fake.fetcher, "http://10.9.9.9"),
	});
	const second = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		providerHosts: ["10.9.9.9", "Other.LOCAL"],
		fetch: claimAt(fake.fetcher, "http://other.local"),
	});
	const previous = process.env.EUMENES_LARM_PROVIDER_HOSTS;
	process.env.EUMENES_LARM_PROVIDER_HOSTS = "10.8.8.8";
	try {
		const ignoredEnv = createLarm({
			baseUrl: "http://127.0.0.1:9810",
			profile: "test-profile",
			token: "control",
			fetch: claimAt(fake.fetcher, "http://10.8.8.8"),
		});
		try {
			await expect(
				ignoredEnv.answer(question, freshSignal()),
			).rejects.toThrow();
		} finally {
			await ignoredEnv.close();
		}
		expect(await configured.answer(question, freshSignal())).toBe(
			"承知しました",
		);
		expect(await second.answer(question, freshSignal())).toBe("承知しました");
	} finally {
		if (previous === undefined) delete process.env.EUMENES_LARM_PROVIDER_HOSTS;
		else process.env.EUMENES_LARM_PROVIDER_HOSTS = previous;
		await configured.close();
		await second.close();
	}
});
test("a .local provider is accepted only when the LARM base itself is .local", async () => {
	const fake = fixture();
	const larm = createLarm({
		baseUrl: "http://larm.local:9810",
		profile: "test-profile",
		token: "control",
		fetch: claimAt(fake.fetcher, "http://larm.local:8080"),
	});
	try {
		expect(await larm.answer(question, freshSignal())).toBe("承知しました");
	} finally {
		await larm.close();
	}
});

test("a failed connect exposes only a machine-readable error code", async () => {
	for (const [failure, expected] of [
		[new Error("socket hang up at 192.168.0.9"), "larm_failed"],
		[
			Object.assign(new TypeError("x"), { code: "ConnectionRefused" }),
			"larm_connection_failed",
		],
	] as const) {
		const larm = createLarm({
			baseUrl: "http://127.0.0.1:9810",
			profile: "test-profile",
			token: "control",
			fetch: async () => {
				throw failure;
			},
		});
		await expect(larm.connect()).rejects.toBeDefined();
		expect(larm.status().error).toBe(expected);
		await larm.close();
	}
});

test.each(["model-tts-english", "voicevox-core"])(
	"language and English speech bind catalog models, dedicated credentials and renewed claims (%s)",
	async (englishModel) => {
		const fake = fixture(
			false,
			"test-profile",
			60_000,
			"model-tts",
			false,
			true,
			englishModel,
		);
		const exchanges: import("../contracts").LarmExchange[] = [];
		const headers: string[] = [];
		const larm = createLarm({
			baseUrl: "http://127.0.0.1:9810",
			profile: "test-profile",
			token: "control",
			voice: "fixture-voice",
			style: "ja-style",
			speed: 1.5,
			pitchScale: 0.1,
			intonationScale: 1.6,
			sentenceLanguageProvider: "language-fixture",
			fetch: async (input, init) => {
				const path = new URL(String(input)).pathname;
				if (path === "/v1/audio/voices") {
					const model = new URL(String(input)).searchParams.get("model");
					return result({
						model,
						default_voice: model === "model-tts" ? "fixture-voice" : "Rosie",
						voices:
							model === "model-tts"
								? [{ id: "fixture-voice", voice_presentation: "feminine" }]
								: [
										{ id: "Rosie", voice_presentation: "feminine" },
										{ id: "Jasper", voice_presentation: "masculine" },
									],
					});
				}
				if (path === "/language-fixture/v1/systemone") {
					headers.push(new Headers(init?.headers).get("Authorization")!);
					const body = JSON.parse(String(init?.body));
					expect(body.model).toBe("model-language-fixture");
					expect(body.state).toBe("A whole English answer.");
					expect(body.questions.language.criteria).toEqual({
						ja: "Japanese",
						en: "English",
					});
					return result({
						model: body.model,
						answers: { language: { type: "choice", choice: "en" } },
					});
				}
				if (path === "/tts-english/v1/audio/speech") {
					headers.push(new Headers(init?.headers).get("Authorization")!);
					expect(JSON.parse(String(init?.body))).toEqual({
						model: englishModel,
						input: "First clause.",
						voice: "Rosie",
						speed: 1,
						response_format: "wav",
					});
					const wav = new Uint8Array(44);
					wav.set(new TextEncoder().encode("RIFF"));
					wav.set(new TextEncoder().encode("WAVE"), 8);
					return new Response(wav);
				}
				return fake.fetcher(input, init);
			},
		});
		try {
			const signal = new AbortController().signal;
			expect(await larm.speechRouting!(signal)).toEqual({
				englishTts: true,
				languageProviders: [
					{ name: "language-fixture", model: "model-language-fixture" },
				],
			});
			expect(fake.requests).toHaveLength(0); // Discovery alone does not reserve.
			const decision = await larm.classifySentenceLanguage!(
				"A whole English answer.",
				signal,
				{
					onExchange: async (x) => {
						exchanges.push(x);
					},
				},
			);
			expect(decision.language).toBe("en");
			expect(decision.model).toBe("model-language-fixture");
			expect(
				(
					await larm.speak("First clause.", signal, {
						speechLanguage: decision.language,
						speed: 2,
						pitchScale: 0.2,
						intonationScale: 2,
						onExchange: async (x) => {
							exchanges.push(x);
						},
					})
				).length,
			).toBe(44);
			await larm.classifySentenceLanguage!("A whole English answer.", signal);
			expect(headers).toEqual([
				"Bearer secret-language-fixture-1",
				"Bearer secret-tts-english-2",
				"Bearer secret-language-fixture-2",
			]);
			expect(exchanges.map((x) => [x.operation, x.model])).toEqual([
				["systemone", "model-language-fixture"],
				["audio/speech", englishModel],
			]);
			expect(
				larm.inspect!().providers.find((p) => p.name === "tts-english")?.model,
			).toBe(englishModel);
		} finally {
			await larm.close();
		}
		expect(fake.calls.some((x) => x.endsWith("/renew"))).toBe(true);
		expect(fake.calls.some((x) => x.startsWith("DELETE"))).toBe(true);
	},
);

for (const body of [
	{
		state_tokens_dropped: -1,
		answers: { language: { type: "choice", choice: "en" } },
	},
	{
		usage: { truncated: "false" },
		answers: { language: { type: "choice", choice: "en" } },
	},
	{ answers: { language: { type: "choice", choice: "fr" } } },
	{ answers: { language: { type: "text", choice: "en" } } },
	{
		model: "attitude-model",
		answers: { language: { type: "choice", choice: "ja" } },
	},
	{ truncated: true, answers: { language: { type: "choice", choice: "ja" } } },
	{
		usage: { state_tokens_dropped: 1 },
		answers: { language: { type: "choice", choice: "en" } },
	},
])
	test("sentence language rejects invalid or shortened System One results", async () => {
		const fake = fixture(
			false,
			"test-profile",
			900_000,
			"model-tts",
			false,
			true,
		);
		const larm = createLarm({
			baseUrl: "http://127.0.0.1:9810",
			profile: "test-profile",
			token: "control",
			sentenceLanguageProvider: "language-fixture",
			fetch: (input, init) =>
				new URL(String(input)).pathname === "/language-fixture/v1/systemone"
					? Promise.resolve(result(body))
					: fake.fetcher(input, init),
		});
		try {
			await expect(
				larm.classifySentenceLanguage!("text", new AbortController().signal),
			).rejects.toThrow("speech_language_invalid");
		} finally {
			await larm.close();
		}
	});

test("missing classifier and English providers never reuse attitude or Japanese synthesis", async () => {
	const fake = fixture(false, "test-profile", 900_000, "model-tts", true);
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		sentenceLanguageProvider: "language-fixture",
		fetch: fake.fetcher,
	});
	try {
		const signal = new AbortController().signal;
		expect(await larm.speechRouting!(signal)).toEqual({
			englishTts: false,
			languageProviders: [],
		});
		await expect(
			larm.classifySentenceLanguage!("text", signal),
		).rejects.toThrow("speech_language_unavailable");
		await expect(
			larm.speak("text", signal, { speechLanguage: "en" }),
		).rejects.toThrow("speech_tts_target_unavailable");
		expect(
			fake.calls.some(
				(x) => x.includes("/systemone") || x.includes("/audio/speech"),
			),
		).toBe(false);
	} finally {
		await larm.close();
	}
});

test.each(["model", "host", "renew"])(
	"invalid optional speech bindings (%s) are discarded without breaking Japanese speech",
	async (fault) => {
		const fake = fixture(
			false,
			"test-profile",
			fault === "renew" ? 60_000 : 900_000,
			"model-tts",
			false,
			true,
		);
		let claims = 0;
		const larm = createLarm({
			baseUrl: "http://127.0.0.1:9810",
			profile: "test-profile",
			token: "control",
			sentenceLanguageProvider: "language-fixture",
			fetch: async (input, init) => {
				const response = await fake.fetcher(input, init);
				if (!new URL(String(input)).pathname.endsWith("/claim"))
					return response;
				claims++;
				if (fault === "renew" && claims === 1) return response;
				const body = await response.json();
				for (const p of body.providers)
					if (p.name === "tts-english" || p.name === "language-fixture") {
						if (fault !== "host") p.model = "wrong-model";
						else
							Object.assign(p.configuration.fields, {
								baseURL: "http://192.168.1.123/v1",
								daemonURL: "http://192.168.1.123/v1",
							});
					}
				return result(body);
			},
		});
		try {
			const signal = new AbortController().signal;
			expect((await larm.speak("日本語", signal)).length).toBe(44);
			await expect(
				larm.speak("English", signal, { speechLanguage: "en" }),
			).rejects.toThrow("speech_tts_target_unavailable");
			await expect(
				larm.classifySentenceLanguage!("English", signal),
			).rejects.toThrow("speech_language_unavailable");
			expect((await larm.speak("日本語", signal)).length).toBe(44);
			expect(
				fake.calls.some(
					(x) =>
						x.includes("/tts-english/") || x.includes("/language-fixture/"),
				),
			).toBe(false);
		} finally {
			await larm.close();
		}
	},
);

test("sentence capability discovery binds the shared voice profile without a fixed model selector", async () => {
	const fake = fixture(
		false,
		"test-profile",
		900_000,
		"model-tts",
		false,
		true,
	);
	let requests = 0;
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		fetch: async (input, init) => {
			if (
				new URL(String(input)).pathname === "/language-fixture/v1/systemone"
			) {
				requests++;
				expect(JSON.parse(String(init?.body)).state).toBe(
					"自然文のまま分類します。",
				);
				return result({
					model: "model-language-fixture",
					answers: { language: { type: "choice", choice: "ja" } },
				});
			}
			const response = await fake.fetcher(input, init);
			if (new URL(String(input)).pathname.endsWith("/claim")) {
				const body = await response.json();
				body.providers.find(
					(p: { name: string }) => p.name === "language-fixture",
				).capability = "decision.system-one";
				return result(body); // Claim transport capability is generic System One.
			}
			return response;
		},
	});
	try {
		const signal = new AbortController().signal;
		await larm.prepareVoice!(signal);
		expect(larm.decisionModel!()).toBe("model-system-one");
		for (let i = 0; i < 2; i++)
			expect(
				(
					await larm.classifySentenceLanguage!(
						"自然文のまま分類します。",
						signal,
					)
				).language,
			).toBe("ja");
		expect(requests).toBe(2);
		expect(fake.requests).toHaveLength(1);
		expect(fake.requests[0]?.providers).toBeUndefined();
	} finally {
		await larm.close();
	}
});

test.each(["missing", "foreign", "mismatched"])(
	"invalid claimed sentence endpoint (%s) never receives a credential",
	async (kind) => {
		const fake = fixture(
			false,
			"test-profile",
			900_000,
			"model-tts",
			false,
			true,
		);
		const larm = createLarm({
			baseUrl: "http://127.0.0.1:9810",
			profile: "test-profile",
			token: "control",
			fetch: async (input, init) => {
				const response = await fake.fetcher(input, init);
				if (!new URL(String(input)).pathname.endsWith("/claim"))
					return response;
				const body = await response.json();
				const p = body.providers.find(
					(x: { name: string }) => x.name === "language-fixture",
				);
				if (kind === "missing") delete p.endpoint;
				else
					p.endpoint =
						kind === "foreign"
							? "http://192.168.1.123/v1/systemone"
							: "http://127.0.0.1/language-fixture/v1/other";
				return result(body);
			},
		});
		try {
			await expect(
				larm.classifySentenceLanguage!("text", new AbortController().signal),
			).rejects.toThrow("speech_language_unavailable");
			expect(fake.calls.some((x) => x.includes("/systemone"))).toBe(false);
		} finally {
			await larm.close();
		}
	},
);

test("daemon epoch loss discards the old sentence credential and claims a new connection once", async () => {
	const fake = fixture(
		false,
		"test-profile",
		900_000,
		"model-tts",
		false,
		true,
	);
	let claims = 0;
	const tokens: string[] = [];
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		fetch: async (input, init) => {
			const path = new URL(String(input)).pathname;
			if (path === "/language-fixture/v1/systemone") {
				tokens.push(new Headers(init?.headers).get("Authorization")!);
				return tokens.length === 1
					? result({ error: { code: "unauthorized" } }, 401)
					: result({ answers: { language: { type: "choice", choice: "en" } } });
			}
			if (
				path === "/v1/agent-connections/connection1" &&
				init?.method === "GET"
			)
				return result({ error: "not_found" }, 404);
			const response = await fake.fetcher(input, init);
			if (path.endsWith("/claim")) {
				claims++;
				const body = await response.json();
				if (claims === 2)
					body.providers.find(
						(p: { name: string }) => p.name === "language-fixture",
					).credential.token = "replacement-sentence-token";
				return result(body);
			}
			return response;
		},
	});
	try {
		expect(
			(
				await larm.classifySentenceLanguage!(
					"English text.",
					new AbortController().signal,
				)
			).language,
		).toBe("en");
		expect(tokens).toEqual([
			"Bearer secret-language-fixture-1",
			"Bearer replacement-sentence-token",
		]);
		expect(claims).toBe(2);
		expect(fake.requests).toHaveLength(2);
	} finally {
		await larm.close();
	}
});

test("a cached pre-deployment voice lease reclaims the added sentence provider after epoch loss", async () => {
	const fake = fixture(
		false,
		"test-profile",
		900_000,
		"model-tts",
		false,
		true,
	);
	let legacy = true,
		lost = false;
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		fetch: async (input, init) => {
			const path = new URL(String(input)).pathname;
			if (
				lost &&
				path === "/v1/agent-connections/connection1" &&
				init?.method === "GET"
			)
				return result({ error: "not_found" }, 404);
			if (lost && path === "/v1/agent-connections" && init?.method === "POST")
				lost = false;
			if (path === "/language-fixture/v1/systemone")
				return result({
					answers: { language: { type: "choice", choice: "en" } },
				});
			const response = await fake.fetcher(input, init);
			if (
				legacy &&
				(path === "/v3/agent-profiles" ||
					path === "/v1/agent-connections" ||
					path.endsWith("/claim"))
			) {
				const body = await response.json();
				if (body.profiles)
					for (const p of body.profiles)
						p.providers = p.providers.filter(
							(x: { name: string }) => x.name !== "language-fixture",
						);
				if (body.providers)
					body.providers = body.providers.filter(
						(x: { name: string }) => x.name !== "language-fixture",
					);
				return result(body, response.status);
			}
			return response;
		},
	});
	try {
		const signal = new AbortController().signal;
		await larm.prepareVoice!(signal);
		legacy = false;
		lost = true;
		expect(
			(await larm.classifySentenceLanguage!("English.", signal)).language,
		).toBe("en");
		expect(fake.requests).toHaveLength(2);
	} finally {
		await larm.close();
	}
});

test("without a saved profile the port reports larm_profile_missing and never contacts LARM", async () => {
	let contacted = 0;
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		token: "control",
		fetch: async () => {
			contacted++;
			return result({});
		},
	});
	expect(larm.status()).toEqual({
		state: "unconfigured",
		capabilities: [],
		error: "larm_profile_missing",
	});
	await expect(larm.connect()).rejects.toThrow("larm_profile_missing");
	await expect(
		larm.answer([{ role: "user", content: "test" }], freshSignal()),
	).rejects.toThrow("larm_profile_missing");
	expect(contacted).toBe(0);
	await larm.close();
});

test("conversation profiles come from the unselected catalog and skip profiles without an llm provider", async () => {
	const urls: string[] = [];
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		token: "control",
		profile: "saved-profile",
		fetch: async (input) => {
			const url = new URL(String(input));
			urls.push(`${url.pathname}${url.search}`);
			return result({
				contractVersion: "agent-connection.v3",
				catalogRevision: "rev1",
				profiles: [
					{ id: "chat-a", providers: [{ name: "llm", model: "model-a" }] },
					{
						id: "chat-b",
						providers: [
							{ name: "llm", model: "model-b" },
							{ name: "asr", model: "model-asr" },
						],
					},
					{ id: "backchannel-only", providers: [{ name: "backchannel" }] },
					{ id: "image-only", providers: [], services: [{ name: "image" }] },
				],
			});
		},
	});
	expect(await larm.conversationProfiles!(freshSignal())).toEqual([
		{ profile: "chat-a", model: "model-a" },
		{ profile: "chat-b", model: "model-b" },
	]);
	expect(urls).toEqual(["/v3/agent-profiles"]);
	await larm.close();
});

test("conversation profiles fall back to the saved profile without a model when the catalog fails", async () => {
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		token: "control",
		profile: "saved-profile",
		fetch: async () => result({ error: "down" }, 503),
	});
	expect(await larm.conversationProfiles!(freshSignal())).toEqual([
		{ profile: "saved-profile", model: null },
	]);
	await larm.close();
});
