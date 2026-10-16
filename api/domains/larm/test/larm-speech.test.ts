import { expect, test } from "bun:test";
import { createLarm } from "..";
import { result, fixture } from "./larm.fixture";
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
test("catalog labels, style, inclusive numeric bounds and decoded credits reach phrase synthesis", async () => {
	for (const [speed, pitchScale, intonationScale] of [
		[0.5, -0.15, 0],
		[2, 0.15, 2],
	]) {
		const fake = fixture(false, "test-profile", 900000, "model-tts-rich");
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
					expect(url.searchParams.get("model")).toBe("model-tts-rich");
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
			model: "model-tts-rich",
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
test("a refused voice catalog does not block synthesis of a chosen voice", async () => {
	const fake = fixture(false, "test-profile", 900000, "model-tts-rich");
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
test("a provider without a described voice omits per-voice fields and busy responses never replay or replace the connection", async () => {
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
test.each(["model-tts-english", "model-tts-rich"])(
	"English speech binds the catalog model, a dedicated credential and renewed claims; the sentence classifier is never claimed (%s)",
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
				if (path.endsWith("/v1/systemone") && path.includes("language"))
					throw new Error("classifier_must_not_be_called");
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
			const speak = () =>
				larm.speak("First clause.", signal, {
					speechLanguage: "en",
					speed: 2,
					pitchScale: 0.2,
					intonationScale: 2,
					onExchange: async (x) => {
						exchanges.push(x);
					},
				});
			// English speech on a lease that must renew does not wait on its own use.
			expect((await speak()).length).toBe(44);
			expect((await speak()).length).toBe(44);
			// The second clause uses the credential re-claimed after renewal.
			expect(headers).toEqual([
				"Bearer secret-tts-english-1",
				"Bearer secret-tts-english-2",
			]);
			expect(fake.calls.some((x) => x.endsWith("/renew"))).toBe(true);
			expect(exchanges.map((x) => [x.operation, x.model])).toEqual([
				["audio/speech", englishModel],
				["audio/speech", englishModel],
			]);
			expect(larm.inspect!().providers.map((p) => p.name)).not.toContain(
				"sentence-language",
			);
			expect(
				larm.inspect!().providers.find((p) => p.name === "tts-english")?.model,
			).toBe(englishModel);
		} finally {
			await larm.close();
		}
		expect(fake.calls.some((x) => x.startsWith("DELETE"))).toBe(true);
	},
);
test("a missing English provider never reuses Japanese synthesis and is rechecked once per lease", async () => {
	const fake = fixture(false, "test-profile", 900_000, "model-tts", true);
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		fetch: fake.fetcher,
	});
	try {
		const signal = new AbortController().signal;
		for (let i = 0; i < 3; i++)
			await expect(
				larm.speak("text", signal, { speechLanguage: "en" }),
			).rejects.toThrow("speech_tts_target_unavailable");
		expect(
			fake.calls.filter((x) => x === "GET /v1/agent-connections/connection1"),
		).toHaveLength(1);
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
			fetch: async (input, init) => {
				const response = await fake.fetcher(input, init);
				if (!new URL(String(input)).pathname.endsWith("/claim"))
					return response;
				claims++;
				if (fault === "renew" && claims === 1) return response;
				const body = await response.json();
				for (const p of body.providers)
					if (p.name === "tts-english") {
						if (fault !== "host") p.model = "wrong-model";
						else
							Object.assign(p.configuration.fields, {
								baseURL: "http://192.168.1.123/v1",
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
			expect((await larm.speak("日本語", signal)).length).toBe(44);
			expect(fake.calls.some((x) => x.includes("/tts-english/"))).toBe(false);
		} finally {
			await larm.close();
		}
	},
);
test("a cached pre-deployment voice lease reclaims the added English provider after epoch loss", async () => {
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
		voice: "fixture-voice",
		fetch: async (input, init) => {
			const url = new URL(String(input));
			const path = url.pathname;
			if (
				lost &&
				path === "/v1/agent-connections/connection1" &&
				init?.method === "GET"
			)
				return result({ error: "not_found" }, 404);
			if (lost && path === "/v1/agent-connections" && init?.method === "POST")
				lost = false;
			if (path === "/v1/audio/voices") {
				const model = url.searchParams.get("model");
				return result({
					model,
					default_voice: model === "model-tts" ? "fixture-voice" : "Rosie",
					voices:
						model === "model-tts"
							? [{ id: "fixture-voice", voice_presentation: "feminine" }]
							: [{ id: "Rosie", voice_presentation: "feminine" }],
				});
			}
			if (path === "/tts-english/v1/audio/speech") {
				const wav = new Uint8Array(44);
				wav.set(new TextEncoder().encode("RIFF"));
				wav.set(new TextEncoder().encode("WAVE"), 8);
				return new Response(wav);
			}
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
							(x: { name: string }) => x.name !== "tts-english",
						);
				if (body.providers)
					body.providers = body.providers.filter(
						(x: { name: string }) => x.name !== "tts-english",
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
			(await larm.speak("English.", signal, { speechLanguage: "en" })).length,
		).toBe(44);
		expect(fake.requests).toHaveLength(2);
	} finally {
		await larm.close();
	}
});
