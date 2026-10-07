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
function fixture(mismatch = false) {
	const calls: string[] = [];
	const catalog = {
		contractVersion: "agent-connection.v3",
		catalogRevision: "rev1",
		requestedProfile: "SAAA",
		profiles: [
			{
				id: "fixture-profile",
				providers: names.map((name) => ({
					name,
					protocol: protocols[name],
					endpoint: paths[name],
					model: `model-${name}`,
				})),
				services: [],
			},
		],
	};
	const created = (requested: string[]) => ({
		id: "connection1",
		profile: "SAAA",
		agentProfile: "fixture-profile",
		status: "ready",
		expiresAt: new Date(Date.now() + 900_000).toISOString(),
		providers: requested.map((name) => ({
			name,
			protocol: protocols[name as keyof typeof protocols],
			endpoint: paths[name as keyof typeof paths],
			model: `model-${name}`,
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
			model: mismatch && name === "llm" ? "wrong-model" : `model-${name}`,
			credential: { token: `secret-${name}` },
			configuration: {
				fields: {
					baseURL: `http://127.0.0.1/${name}/v1`,
					model: mismatch && name === "llm" ? "wrong-model" : `model-${name}`,
					...(name === "tts" ? { voice: "fixture-voice" } : {}),
				},
			},
			contextWindow:
				name === "llm"
					? {
							maxTokens: 4096,
							outputReserveTokens: 512,
							safetyMarginTokens: 128,
						}
					: undefined,
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
			requested = body.providers;
			expect(body.expectedCatalogRevision).toBe("rev1");
			return result(created(requested), 201);
		}
		if (url.pathname === "/v1/agent-connections/connection1/claim")
			return result(claim(requested));
		if (
			url.pathname === "/v1/agent-connections/connection1" &&
			init?.method === "DELETE"
		)
			return new Response(null, { status: 204 });
		if (url.pathname === "/llm/v1/chat/completions") {
			expect(new Headers(init?.headers).get("Authorization")).toBe(
				"Bearer secret-llm",
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
	return { fetcher, calls };
}
test("catalog, claim, ASR/LLM/TTS and release use public contract", async () => {
	const fake = fixture();
	const larm = createLarm({
		baseUrl: "http://127.0.0.1:9810",
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
