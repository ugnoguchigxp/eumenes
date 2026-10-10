export {};

const port = Number(process.env.LARM_FIXTURE_PORT ?? 9822);
const claimed = new Map<string, string[]>();
let holdNext = false;
const releaseStreams = new Set<() => void>();
const ttsInputs: string[] = [];
const ttsParameters: Array<Record<string, unknown>> = [];
const asrInputs: Array<{ rate: number; bytes: number }> = [];
const profile = "SAAA-gemma4-26b";
const agentProfile = "saaa-conversation-gemma4-26b-voice";
const names = ["llm", "asr", "tts"] as const;
const protocol = {
	llm: "openai.chat-completions.v1",
	asr: "openai.audio-transcriptions.v1",
	tts: "openai.audio-speech.v1",
};
const endpoint = {
	llm: "/v1/chat/completions",
	asr: "/v1/audio/transcriptions",
	tts: "/v1/audio/speech",
};
const origin = `http://127.0.0.1:${port}`;
const model = (name: string) =>
	name === "llm"
		? "gemma4-26b-a4b"
		: name === "tts"
			? "voicevox-core"
			: `model-${name}`;
const voiceCatalog = {
	default_voice: "fixture-voice",
	voices: ["fixture-voice", "fixture-voice-soft"].map((id, i) => ({
		id,
		display_name: i ? "テスト話者B" : "テスト話者A",
		default_style: i ? "sweet" : "normal",
		styles: i
			? [{ id: "sweet", display_name: "あまあま", style_id: 2 }]
			: [
					{ id: "normal", display_name: "ノーマル", style_id: 0 },
					{ id: "whisper", display_name: "ささやき", style_id: 1 },
				],
		capabilities: {
			speed: { minimum: 0.5, maximum: 2, default: 1 },
			pitch_scale: { minimum: -0.15, maximum: 0.15, default: 0 },
			intonation_scale: { minimum: 0, maximum: 2, default: 1 },
		},
		credit: `VOICEVOX:テスト話者${i ? "B" : "A"}`,
	})),
};
function wav() {
	const count = 22050 * 2;
	const bytes = new Uint8Array(44 + count * 2);
	const view = new DataView(bytes.buffer);
	const tag = (n: number, s: string) => {
		for (let i = 0; i < s.length; i++) view.setUint8(n + i, s.charCodeAt(i));
	};
	tag(0, "RIFF");
	view.setUint32(4, bytes.length - 8, true);
	tag(8, "WAVE");
	tag(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 22050, true);
	view.setUint32(28, 44100, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	tag(36, "data");
	view.setUint32(40, count * 2, true);
	for (let i = 0; i < count; i++)
		view.setInt16(
			44 + i * 2,
			Math.sin((i * 2 * Math.PI * 440) / 22050) * 5000,
			true,
		);
	return bytes;
}
const server = Bun.serve({
	hostname: "127.0.0.1",
	port,
	async fetch(request) {
		const url = new URL(request.url);
		const path = url.pathname;
		if (
			request.headers.get("authorization") !== "Bearer fixture-control" &&
			!path.startsWith("/llm/") &&
			!path.startsWith("/asr/") &&
			!path.startsWith("/tts/")
		)
			return Response.json({ error: "unauthorized" }, { status: 401 });
		if (path === "/health") return Response.json({ status: "ok" });
		const healthMatch = path.match(
			/^\/v1\/agent-connections\/([\w-]+)\/providers\/([\w-]+)\/health$/,
		);
		if (healthMatch)
			return Response.json({
				name: healthMatch[2],
				capability: healthMatch[2],
				ready: true,
				acceptingRequests: true,
			});
		if (path === "/v1/images/generations")
			return Response.json({
				status: "succeeded",
				artifact: {
					id: "fixture-image",
					model: "fixture-image",
					contentUrl: "/v1/image-artifacts/fixture-image/content",
					mimeType: "image/png",
				},
			});
		if (path === "/v1/image-artifacts/fixture-image/content")
			return new Response(
				Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=",
					"base64",
				),
				{ headers: { "Content-Type": "image/png" } },
			);
		if (path === "/v1/music/generations")
			return Response.json(
				{ jobId: "fixture-music", status: "queued" },
				{ status: 202 },
			);
		if (path === "/v1/music/generations/fixture-music")
			return Response.json({
				jobId: "fixture-music",
				status: request.method === "DELETE" ? "cancelled" : "completed",
				result: {
					id: "fixture-music",
					model: "fixture-music",
					audioUrl: "/v1/music/generations/fixture-music/audio",
					metadataUrl: "/v1/music/generations/fixture-music/metadata",
					format: "wav",
				},
			});
		if (path === "/v1/music/generations/fixture-music/metadata")
			return Response.json({ id: "fixture-music" });
		if (path === "/v1/music/generations/fixture-music/audio")
			return new Response(wav(), { headers: { "Content-Type": "audio/wav" } });
		if (path === "/fixture/hold-next") {
			holdNext = true;
			ttsInputs.length = 0;
			ttsParameters.length = 0;
			asrInputs.length = 0;
			return Response.json({ ok: true });
		}
		if (path === "/fixture/release") {
			for (const release of releaseStreams) release();
			releaseStreams.clear();
			return Response.json({ ok: true });
		}
		if (path === "/fixture/observations")
			return Response.json({ ttsInputs, asrInputs, ttsParameters });
		if (path === "/v1/audio/voices") {
			if (request.headers.get("authorization") !== "Bearer fixture-control")
				return Response.json({ error: "unauthorized" }, { status: 401 });
			return Response.json(voiceCatalog);
		}
		if (path === "/v3/agent-profiles")
			return Response.json({
				contractVersion: "agent-connection.v3",
				catalogRevision: "fixture1",
				requestedProfile: url.searchParams.get("profile") ?? undefined,
				profiles: [
					{
						id: agentProfile,
						providers: names.map((name) => ({
							name,
							capability: name,
							protocol: protocol[name],
							endpoint: endpoint[name],
							model: model(name),
							...(name === "llm"
								? {
										contextWindow: {
											maxTokens: 262144,
											outputReserveTokens: 4096,
											safetyMarginTokens: 1976,
										},
									}
								: {}),
						})),
						services: /SAAA-w-(Image|music)/.test(
							url.searchParams.get("profile") ?? "",
						)
							? [
									{
										name:
											url.searchParams.get("profile") === "SAAA-w-Image"
												? "image"
												: "music",
										capability:
											url.searchParams.get("profile") === "SAAA-w-Image"
												? "media.image.generate"
												: "media.music.generate",
										protocol:
											url.searchParams.get("profile") === "SAAA-w-Image"
												? "larm.image-generation.v1"
												: "larm.music-generation.v1",
										endpoint:
											url.searchParams.get("profile") === "SAAA-w-Image"
												? "/v1/images/generations"
												: "/v1/music/generations",
										model:
											url.searchParams.get("profile") === "SAAA-w-Image"
												? "fixture-image"
												: "fixture-music",
										startupPolicy: { minWarmInstances: 0, idleTtlSeconds: 0 },
									},
								]
							: [],
					},
				],
			});
		if (path === "/v1/agent-connections" && request.method === "POST") {
			const body = (await request.json()) as { providers?: string[] };
			const id = crypto.randomUUID();
			const requested = body.providers ?? [...names];
			claimed.set(id, requested);
			return Response.json(
				{
					id,
					profile,
					agentProfile,
					catalogRevision: "fixture1",
					status: "ready",
					providers: requested.map((name) => ({
						name,
						protocol: protocol[name as keyof typeof protocol],
						endpoint: endpoint[name as keyof typeof endpoint],
						model: model(name),
						readiness: "ready",
						claimable: true,
					})),
					expiresAt: new Date(Date.now() + 900000).toISOString(),
				},
				{ status: 201 },
			);
		}
		const match = path.match(/^\/v1\/agent-connections\/([\w-]+)(?:\/claim)?$/);
		if (match) {
			const id = match[1];
			if (!id) return Response.json({ error: "invalid_id" }, { status: 400 });
			const requested = claimed.get(id);
			if (!requested)
				return Response.json({ error: "missing" }, { status: 404 });
			if (request.method === "DELETE") {
				claimed.delete(id);
				return new Response(null, { status: 204 });
			}
			if (request.method === "GET")
				return Response.json({
					id,
					profile,
					agentProfile,
					status: "ready",
					expiresAt: new Date(Date.now() + 900000).toISOString(),
				});
			if (path.endsWith("/claim"))
				return Response.json({
					id,
					status: "ready",
					allocationId: "fixture-allocation",
					expiresAt: new Date(Date.now() + 900000).toISOString(),
					providers: requested.map((name) => ({
						name,
						protocol: protocol[name as keyof typeof protocol],
						baseUrl: `${origin}/${name}/v1`,
						model: model(name),
						credential: {
							type: "bearer",
							token: `fixture-${name}`,
							expiresAt: new Date(Date.now() + 900000).toISOString(),
						},
						endpoint: `${origin}/${name}${endpoint[name as keyof typeof endpoint]}`,
						configuration: {
							fields: {
								baseURL: `${origin}/${name}/v1`,
								model: model(name),
								...(name === "tts" ? { voice: "fixture-voice" } : {}),
							},
						},
						contextWindow:
							name === "llm"
								? {
										maxTokens: 262144,
										outputReserveTokens: 4096,
										safetyMarginTokens: 1976,
									}
								: undefined,
					})),
				});
		}

		if (path === "/asr/v1/audio/transcriptions") {
			const form = await request.formData();
			const file = form.get("file") as File;
			const bytes = await file.arrayBuffer();
			asrInputs.push({
				rate: new DataView(bytes).getUint32(24, true),
				bytes: bytes.byteLength,
			});
			return Response.json({ text: "こんにちは" });
		}
		if (path === "/llm/v1/chat/completions") {
			const body = (await request.json()) as {
				stream?: boolean;
				messages?: Array<{ role: string; content: string }>;
			};
			// Synthetic language-control response; fixture data, not production classification.
			if (body.messages?.[0]?.content.includes("転記された発話の主要な言語"))
				return Response.json({
					choices: [
						{
							message: {
								content: JSON.stringify({
									status: "identified",
									languages: ["ja"],
									confidence: 0.99,
								}),
							},
						},
					],
				});
			const text = "承知しました。先ほどの話を覚えています。";
			if (!body.stream)
				return Response.json({ choices: [{ message: { content: text } }] });
			let hold = holdNext;
			holdNext = false;
			const encoder = new TextEncoder();
			return new Response(
				new ReadableStream<Uint8Array>({
					async start(controller) {
						try {
							for (const char of text) {
								if (request.signal.aborted) break;
								controller.enqueue(
									encoder.encode(
										`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: char } }] })}\n\n`,
									),
								);
								if (hold && char === "。") {
									hold = false;
									await new Promise<void>((resolve) => {
										const release = () => {
											request.signal.removeEventListener("abort", release);
											releaseStreams.delete(release);
											resolve();
										};
										releaseStreams.add(release);
										request.signal.addEventListener("abort", release, {
											once: true,
										});
									});
								}
								await Bun.sleep(20);
							}
							if (!request.signal.aborted)
								controller.enqueue(encoder.encode("data: [DONE]\n\n"));
							controller.close();
						} catch {
							/* consumer canceled */
						}
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		}
		if (path === "/tts/v1/audio/speech") {
			const body = (await request.json()) as { input: string; voice: string };
			ttsInputs.push(body.input);
			ttsParameters.push(body);
			const credit = voiceCatalog.voices.find(
				(v) => v.id === body.voice,
			)?.credit;
			return new Response(wav(), {
				headers: {
					"Content-Type": "audio/wav",
					...(credit
						? { "X-VOICEVOX-Credit": `UTF-8''${encodeURIComponent(credit)}` }
						: {}),
				},
			});
		}

		return Response.json({ error: "not_found" }, { status: 404 });
	},
});
console.log(`fixture listening ${server.port}`);
