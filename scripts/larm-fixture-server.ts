export {};

const port = Number(process.env.LARM_FIXTURE_PORT ?? 9822);
const claimed = new Map<string, string[]>();
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
		if (path === "/v3/agent-profiles")
			return Response.json({
				contractVersion: "agent-connection.v3",
				catalogRevision: "fixture1",
				requestedProfile: profile,
				profiles: [
					{
						id: agentProfile,
						providers: names.map((name) => ({
							name,
							protocol: protocol[name],
							endpoint: endpoint[name],
							model: name === "llm" ? "gemma4-26b-a4b" : `model-${name}`,
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
						services: [],
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
					status: "ready",
					providers: requested.map((name) => ({
						name,
						protocol: protocol[name as keyof typeof protocol],
						endpoint: endpoint[name as keyof typeof endpoint],
						model: name === "llm" ? "gemma4-26b-a4b" : `model-${name}`,
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
						model: name === "llm" ? "gemma4-26b-a4b" : `model-${name}`,
						credential: { token: `fixture-${name}` },
						configuration: {
							fields: {
								baseURL: `${origin}/${name}/v1`,
								model: name === "llm" ? "gemma4-26b-a4b" : `model-${name}`,
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
		if (path === "/asr/v1/audio/transcriptions")
			return Response.json({ text: "こんにちは" });
		if (path === "/llm/v1/chat/completions")
			return Response.json({
				choices: [
					{ message: { content: "承知しました。先ほどの話を覚えています。" } },
				],
			});
		if (path === "/tts/v1/audio/speech")
			return new Response(wav(), { headers: { "Content-Type": "audio/wav" } });
		return Response.json({ error: "not_found" }, { status: 404 });
	},
});
console.log(`fixture listening ${server.port}`);
