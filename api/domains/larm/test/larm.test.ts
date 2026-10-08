import { expect, test } from "bun:test";
import { createLarm } from "..";

const names = ["llm", "asr", "tts"] as const;
const protocols = {
	llm: "openai.chat-completions.v1",
	asr: "openai.audio-transcriptions.v1",
	tts: "openai.audio-speech.v1",
};
const paths = {
	llm: "/v1/chat/completions",
	asr: "/v1/audio/transcriptions",
	tts: "/v1/audio/speech",
};
const result = (value: unknown, status = 200) =>
	Response.json(value, { status });
function fixture(
	mismatch = false,
	selectedProfile = "SAAA",
	initialExpiryMs = 900_000,
) {
	const calls: string[] = [];
	const requests: Record<string, unknown>[] = [];
	const agentProfile =
		selectedProfile === "SAAA-gemma4-26b"
			? "saaa-conversation-gemma4-26b-voice"
			: "fixture-profile";
	const model = (name: string) =>
		selectedProfile === "SAAA-gemma4-26b" && name === "llm"
			? "gemma4-26b-a4b"
			: `model-${name}`;
	const contextWindow =
		selectedProfile === "SAAA-gemma4-26b"
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
				providers: names.map((name) => ({
					name,
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
			model: mismatch && name === "llm" ? "wrong-model" : model(name),
			credential: { token: `secret-${name}-${tokenVersion}` },
			secretFields: { apiKey: `providers.${name}.credential.token` },
			configuration: {
				fields: {
					baseURL: `http://127.0.0.1/${name}/v1`,
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
			requested = body.providers ?? [...names];
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
test("catalog, claim, ASR/LLM/TTS and release use public contract", async () => {
	const fake = fixture();
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "SAAA",
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
test("mismatched claim is rejected before inference and lease is released", async () => {
	const fake = fixture(true);
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "SAAA",
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
		profile: "SAAA",
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
	const fake = fixture();
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "SAAA",
		token: "control",
		fetch: fake.fetcher,
	});
	const signal = new AbortController().signal;
	await Promise.all([
		larm.answer([{ role: "user", content: "質問" }], signal),
		larm.speak("回答 1", signal),
		larm.speak("回答 2", signal),
	]);
	expect(
		fake.calls.filter((call) => call === "POST /v1/agent-connections"),
	).toHaveLength(2);
	await larm.close();
});
test("Gemma requests the live profile and renews by reclaiming the rotated token", async () => {
	const fake = fixture(false, "SAAA-gemma4-26b", 60_000);
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
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
		profile: "SAAA-gemma4-26b",
		audience: "saaa-desktop",
		client: "gemma-client",
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
test("voice requests every provider in the Gemma profile", async () => {
	const fake = fixture(false, "SAAA-gemma4-26b");
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
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
	const fake = fixture(false, "SAAA-gemma4-26b");
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
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

test("exported token alone connects to the documented default URL", async () => {
	const fake = fixture(false, "SAAA-gemma4-26b");
	const origins: string[] = [];
	const larm = createLarm({
		token: "control",
		profile: "",
		audience: "",
		fetch: async (input, init) => {
			origins.push(new URL(String(input)).origin);
			return fake.fetcher(input, init);
		},
	});
	expect(larm.status().state).toBe("idle");
	await larm.connect();
	expect(larm.status()).toEqual({ state: "ready", capabilities: ["llm"] });
	expect(
		origins.every((origin) => origin === "http://192.168.0.130:9810"),
	).toBe(true);
	await larm.close();
});

test("missing claim voice discovers and caches the advertised default with control auth", async () => {
	const fake = fixture();
	let discoveries = 0;
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "SAAA",
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
		profile: "SAAA",
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
		).rejects.toThrow("larm_tts_voice_unconfigured");
		expect(fake.calls.some((call) => call.includes("/audio/speech"))).toBe(
			false,
		);
	} finally {
		await larm.close();
	}
});

test("cancelling a caller returns promptly during allocation and close stops polling", async () => {
	const fake = fixture(false, "SAAA-gemma4-26b");
	let allocated = false;
	let observedSignal: AbortSignal | null | undefined;
	const larm = createLarm({
		token: "control",
		fetch: async (input, init) => {
			const response = await fake.fetcher(input, init);
			if (
				new URL(String(input)).pathname === "/v1/agent-connections" &&
				init?.method === "POST"
			) {
				allocated = true;
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
	for (let i = 0; i < 20 && !allocated; i++) await Bun.sleep(5);
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
			profile: "SAAA",
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
	const fake = fixture(false, "SAAA", initialExpiryMs);
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
		profile: "SAAA",
		token: "control",
		fetch: fetcher,
		idleTimeoutMs,
	});
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
	const fake = lifecycleFixture();
	const larm = makeLarm(fake.fetcher, 35);
	try {
		await larm.prepareVoice!(freshSignal());
		const count = fake.calls.length;
		await Bun.sleep(55);
		expect(larm.status()).toMatchObject({ state: "idle", capabilities: [] });
		expect(larm.inspect?.().connectionId).toBeUndefined();
		expect(fake.calls).toHaveLength(count);
		expect(await larm.transcribe(new Uint8Array(44), freshSignal())).toBe(
			"こんにちは",
		);
		expect(larm.inspect?.().connectionId).toBe("connection2");
		expect(fake.requests[1]).toMatchObject({
			profile: "SAAA",
		});
	} finally {
		await larm.close();
	}
});

test("an active inference pauses the local idle timer and completion starts a new idle interval", async () => {
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
		await Bun.sleep(65);
		expect(larm.status().state).toBe("ready");
		complete();
		await work;
		expect(larm.status().state).toBe("ready");
		await Bun.sleep(60);
		expect(larm.status().state).toBe("idle");
	} finally {
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

test("a late concurrent rejection cannot discard the replacement lease", async () => {
	const fake = lifecycleFixture();
	let calls = 0;
	let finishLate: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		finishLate = resolve;
	});
	const larm = makeLarm(async (input, init) => {
		if (String(input).endsWith("chat/completions")) {
			const n = ++calls;
			if (n === 1) {
				await gate;
				return idleReleased();
			}
			if (n === 2) return idleReleased();
		}
		return fake.fetcher(input, init);
	});
	try {
		await larm.connect();
		const late = larm.answer(question, freshSignal());
		await larm.answer(question, freshSignal());
		expect(larm.inspect?.().connectionId).toBe("connection2");
		finishLate();
		expect(await late).toBe("承知しました");
		expect(fake.generation()).toBe(2);
		expect(larm.inspect?.().connectionId).toBe("connection2");
	} finally {
		finishLate();
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
		await Bun.sleep(70);
		await larm.connect();
		await Bun.sleep(70);
		expect(larm.status().state).toBe("idle");
		expect(fake.calls.length).toBe(before + 1); // health check only; no idle keepalive
	} finally {
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
	const fake = lifecycleFixture();
	let checking = false;
	const larm = makeLarm(async (input, init) => {
		if (
			checking &&
			new URL(String(input)).pathname === "/v1/agent-connections/connection1" &&
			init?.method === "GET"
		)
			await Bun.sleep(65);
		return fake.fetcher(input, init);
	}, 40);
	try {
		await larm.connect();
		checking = true;
		await larm.connect();
		expect(larm.inspect?.().connectionId).toBe("connection2");
		expect(larm.status().state).toBe("ready");
	} finally {
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
		await larm.connect();
		expect(checks).toBe(1);
		expect(larm.status().state).toBe("ready");
		expect(fake.calls.filter((c) => c.endsWith("/claim"))).toHaveLength(1);
	} finally {
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
