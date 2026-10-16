import { expect, test } from "bun:test";
import { createLarm } from "..";
import { waitFor } from "../../../infrastructure/wait-for";

test("foreground answers serialize without allowing a cancelled queued call to overtake an active call", async () => {
	let finish!: () => void;
	const held = new Promise<void>((r) => {
		finish = r;
	});
	const inputs: string[] = [];
	const provider = {
		name: "llm",
		model: "fixture-llm",
		protocol: "openai.chat-completions.v1",
		endpoint: "/v1/chat/completions",
		contextWindow: {
			maxTokens: 262144,
			outputReserveTokens: 4096,
			safetyMarginTokens: 1976,
		},
	};
	const connection = {
		id: "main",
		profile: "test-profile",
		agentProfile: "test-profile",
		status: "ready",
		expiresAt: new Date(Date.now() + 900000).toISOString(),
		providers: [{ ...provider, readiness: "ready", claimable: true }],
	};
	const p = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		fetch: async (input, init) => {
			const path = new URL(String(input)).pathname;
			if (init?.method === "DELETE") return new Response(null, { status: 204 });
			if (path === "/v3/agent-profiles")
				return Response.json({
					contractVersion: "agent-connection.v3",
					catalogRevision: "revision",
					requestedProfile: "test-profile",
					profiles: [{ id: "test-profile", providers: [provider] }],
				});
			if (path === "/v1/agent-connections")
				return Response.json(connection, { status: 201 });
			if (path.endsWith("/claim"))
				return Response.json({
					...connection,
					providers: [
						{
							...provider,
							endpoint: "http://127.0.0.1/v1/chat/completions",
							baseUrl: "http://127.0.0.1/v1",
							credential: { token: "main-llm" },
							configuration: {
								fields: {
									baseURL: "http://127.0.0.1/v1",
									model: provider.model,
								},
							},
						},
					],
				});
			const content = JSON.parse(String(init?.body)).messages[0].content;
			inputs.push(content);
			if (inputs.length === 1) await held;
			return Response.json({ choices: [{ message: { content } }] });
		},
	});
	const messages = (content: string) => [{ role: "user" as const, content }];
	const signal = AbortSignal.timeout(5000),
		abort = new AbortController();
	const first = p.answer(messages("first"), signal);
	try {
		await waitFor(() => inputs.length > 0);
		const cancelled = p.answer(messages("cancelled"), abort.signal);
		const rejected = Promise.allSettled([cancelled]);
		const third = p.answer(messages("third"), signal);
		abort.abort();
		expect((await rejected)[0]!.status).toBe("rejected");
		expect(inputs).toEqual(["first"]);
		finish();
		expect(await Promise.all([first, third])).toEqual(["first", "third"]);
		expect(inputs).toEqual(["first", "third"]);
	} finally {
		finish();
		await p.close();
	}
});
