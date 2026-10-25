import { expect, jest, test } from "bun:test";
import { createLarm } from "..";
import {
	result,
	fixture,
	question,
	freshSignal,
	makeLarm,
	driveFakeTimers,
	claimAt,
} from "./larm.fixture";
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
	expect(fake.calls.filter((x) => x.includes("/claim"))).toHaveLength(3);
	expect(fake.calls.filter((x) => x.startsWith("DELETE"))).toHaveLength(2);
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
test("conversation profiles come from the unselected catalog and keep only default, current profiles with an llm provider", async () => {
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
					{
						id: "chat-a",
						selectionPolicy: "default",
						providers: [{ name: "llm", model: "model-a" }],
					},
					{
						id: "chat-b",
						selectionPolicy: "default",
						providers: [
							{ name: "llm", model: "model-b" },
							{ name: "asr", model: "model-asr" },
						],
					},
					{
						id: "background-only",
						selectionPolicy: "explicit-only",
						providers: [{ name: "llm", model: "model-background" }],
					},
					{
						id: "retired",
						selectionPolicy: "default",
						deprecated: true,
						providers: [{ name: "llm", model: "model-old" }],
					},
					{
						id: "backchannel-only",
						selectionPolicy: "default",
						providers: [{ name: "backchannel" }],
					},
					{
						id: "image-only",
						selectionPolicy: "default",
						providers: [],
						services: [{ name: "image" }],
					},
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
