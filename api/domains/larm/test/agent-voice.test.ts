import { expect, test } from "bun:test";
import { createAgentLarm } from "..";
import { capacityFixture, messages, owner } from "./agent-capacity.fixture";
import { fixture } from "./larm.fixture";
import { embeddingProvider } from "./embedding.fixture";

function combinedFixture() {
	const llm = capacityFixture();
	const audio = fixture(
		false,
		llm.config.profile,
		900000,
		"model-tts",
		true,
		true,
	);
	const nativeCalls: string[] = [];
	const wav = new Uint8Array(44);
	wav.set(new TextEncoder().encode("RIFF"));
	wav.set(new TextEncoder().encode("WAVE"), 8);
	const fetcher: typeof llm.config.fetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path === "/v3/agent-profiles") {
			const catalog = await (await audio.fetcher(input, init)).json();
			const llmCatalog = await (await llm.config.fetch(input, init)).json();
			catalog.profiles[0].id = llmCatalog.profiles[0].id;
			catalog.profiles[0].providers = [
				llmCatalog.profiles[0].providers[0],
				...catalog.profiles[0].providers.filter(
					(p: { name: string }) => p.name !== "llm",
				),
				embeddingProvider,
			];
			return Response.json(catalog);
		}
		if (path === "/v1/agent-connections") {
			const body = JSON.parse(String(init?.body));
			if (body.providers?.includes("llm")) return llm.config.fetch(input, init);
		}
		if (path.includes("server-issued-") || path === "/v1/chat/completions")
			return llm.config.fetch(input, init);
		if (path.endsWith("/audio/voices")) {
			const english =
				new URL(String(input)).searchParams.get("model") ===
				"model-tts-english";
			return Response.json({
				default_voice: english ? "Rosie" : "fixture-voice",
				voices: [
					{
						id: english ? "Rosie" : "fixture-voice",
						voice_presentation: "feminine",
					},
				],
			});
		}
		if (path === "/shared-provider/v1/embed") {
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bearer shared-embedding-token",
			);
			const { type } = JSON.parse(String(init?.body));
			nativeCalls.push("embedding");
			return Response.json({
				type,
				count: 1,
				dimension: 512,
				embeddings: [[1, ...Array(511).fill(0)]],
			});
		}
		if (
			path.startsWith("/system-one/") ||
			path === "/tts-english/v1/audio/speech"
		) {
			const name = path.split("/")[1];
			expect(new Headers(init?.headers).get("authorization")).toBe(
				`Bearer secret-${name}-1`,
			);
			nativeCalls.push(name!);
			if (name === "tts-english") {
				expect(JSON.parse(String(init?.body)).voice).toBe("Rosie");
				return new Response(wav);
			}
			return Response.json({ decisions: { attitude: "none" } });
		}
		if (path.startsWith("/asr/") || path.startsWith("/tts/")) {
			const name = path.split("/")[1];
			expect(new Headers(init?.headers).get("authorization")).toBe(
				`Bearer secret-${name}-1`,
			);
			nativeCalls.push(name!);
		}
		const response = await audio.fetcher(input, init);
		if (path.startsWith("/v1/agent-connections") && response.status !== 204) {
			const body = await response.json();
			body.agentProfile = "fixture-agent-profile";
			const claim = path.endsWith("/claim") && JSON.parse(String(init?.body));
			if (claim && claim.format === "larm-embedding-provider-v1") {
				expect(claim.providers).toEqual(["embedding"]);
				expect(new Headers(init?.headers).has("idempotency-key")).toBe(false);
				body.providers = [
					{
						...embeddingProvider,
						endpoint: "/shared-provider/v1/embed",
						credential: {
							type: "bearer",
							token: "shared-embedding-token",
							expiresAt: body.expiresAt,
						},
					},
				];
			} else if (body.providers) {
				body.providers = body.providers.map((provider: { name: string }) =>
					provider.name === "embedding"
						? { ...provider, ...embeddingProvider }
						: provider,
				);
			}
			return Response.json(body, { status: response.status });
		}
		return response;
	};
	return {
		llm,
		audio,
		nativeCalls,
		wav,
		config: { ...llm.config, fetch: fetcher },
	};
}

test("managed LLMs coexist with ASR, TTS, attitude and embedding in the shared non-LLM scope", async () => {
	const f = combinedFixture(),
		p = createAgentLarm(f.config);
	const signal = AbortSignal.timeout(5000);
	try {
		await p.connect();
		await p.answer(messages, signal, owner("main"));
		await p.answerStream!(messages, signal, () => {}, owner("subagent"));
		await p.prepareVoice!(signal);
		expect((await p.embed!(["検索"], "query", signal)).space.dimension).toBe(
			512,
		);
		expect(await p.transcribe(f.wav, signal)).toBe("こんにちは");
		expect(await p.speak("確認", signal)).toHaveLength(44);
		expect(
			await p.speak("Check", signal, { speechLanguage: "en" }),
		).toHaveLength(44);
		await p.judge!(
			{ current_chunk: "確認" },
			{
				attitude: {
					type: "choice",
					instructions: "Choose",
					criteria: { none: "Neutral" },
				},
			},
			signal,
		);
		await p.answer(messages, signal, owner("main"));
		expect(f.audio.requests).toHaveLength(1);
		expect(f.audio.requests[0]!.providers).toEqual([
			"asr",
			"tts",
			"system-one",
			"tts-english",
			"language-fixture",
			"embedding",
		]);
		expect(f.audio.requests[0]).not.toHaveProperty("contextTokens");
		expect(f.nativeCalls).toEqual([
			"embedding",
			"asr",
			"tts",
			"tts-english",
			"system-one",
		]);
		expect(f.llm.creates).toHaveLength(2);
		expect(f.llm.creates[0]!.body.contextTokens).toBe(200000);
		expect(f.llm.creates[1]!.body).not.toHaveProperty("contextTokens");
		expect(f.llm.generations[0]!.id).toBe(f.llm.generations[2]!.id);
		expect([...f.llm.bindings.values()].map((b) => b.capacity)).toEqual([
			200000, 131072,
		]);
	} finally {
		await p.close();
	}
});
