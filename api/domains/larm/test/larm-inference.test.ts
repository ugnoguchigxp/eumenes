import { expect, test } from "bun:test";
import { createLarm } from "..";
import { result, fixture, freshSignal } from "./larm.fixture";
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
test("the system-one classifier uses claimed model/token and current chunk only; rejects unsupported questions before provider request", async () => {
	const fake = fixture(false, "test-profile-large", 900000, "model-tts", true);
	const attitude = "attitude-test-model";
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
					model: attitude,
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
				return new Response(body.replaceAll("model-system-one", attitude), {
					status: response.status,
					headers: response.headers,
				});
			}
			return response;
		},
	});
	try {
		await larm.prepareVoice!(freshSignal());
		expect(larm.decisionModel?.()).toBe(attitude);
		expect(larm.inspect?.().decisionModel).toBe(attitude);
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
		expect(bodies[0]!.model).toBe(attitude);
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
			).rejects.toThrow("larm_invalid_attitude_question");
		expect(calls).toBe(2);
	} finally {
		await larm.close();
	}
});
