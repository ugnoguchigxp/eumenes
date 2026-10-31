import { createHash } from "node:crypto";
import { createLarm } from "..";
import { fixture } from "./larm.fixture";
import { imagePolicy } from "./chat-input.fixture";

export function capacityFixture(
	options: {
		role?: "main" | "sub";
		allocated?: number;
		advertised?: number;
		promptTokens?: number;
		mutateClaim?: (provider: Record<string, unknown>) => void;
	} = {},
) {
	const fake = fixture(false, "test-profile-large");
	let allocated = options.allocated ?? 131072;
	let generations = 0;
	const counts: {
		maxContextTokens: number;
		inputBudgetTokens: number;
		requestedOutputTokens: number;
	}[] = [];
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("/input-tokens")) {
			const body = String(init?.body);
			const parsed = JSON.parse(body);
			const budget = allocated - parsed.max_tokens - 1976;
			const capacity = {
				maxContextTokens: allocated,
				inputBudgetTokens: budget,
				requestedOutputTokens: parsed.max_tokens,
			};
			counts.push(capacity);
			return Response.json({
				...capacity,
				contractVersion: "larm-chat-input-token-count.v1",
				model: parsed.model,
				promptTokens: options.promptTokens ?? 100,
				textTokens: options.promptTokens ?? 100,
				imageTokens: 0,
				imageCount: 0,
				safetyMarginTokens: 1976,
				fits: (options.promptTokens ?? 100) <= budget,
				requestDigest: createHash("sha256").update(body).digest("hex"),
				runtime: "fixture",
				configRevision: "rev",
				bootEpoch: "epoch",
				engineBuild: "fixture",
			});
		}
		if (path === "/v1/agent-connections" && init?.method === "POST") {
			const requested = JSON.parse(String(init.body)).contextTokens;
			allocated = options.allocated ?? requested ?? 131072;
		}
		const response = await fake.fetcher(input, init);
		if (response.status === 204) return response;
		if (path.endsWith("/chat/completions")) {
			generations++;
			if (JSON.parse(String(init?.body)).stream)
				return new Response(
					'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			return response;
		}
		const body = await response.json();
		const providers: Record<string, unknown>[] =
			body.profiles?.[0]?.providers ?? body.providers ?? [];
		for (const provider of providers) {
			if (provider.name !== "llm") continue;
			provider.contextWindow = {
				maxTokens:
					path === "/v3/agent-profiles"
						? (options.advertised ?? 200000)
						: allocated,
				outputReserveTokens: 4096,
				outputLimit: "remaining-context",
				safetyMarginTokens: 1976,
			};
			provider.chatInput = imagePolicy;
			if (path.endsWith("/claim")) options.mutateClaim?.(provider);
		}
		return Response.json(body, { status: response.status });
	};
	const port = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile-large",
		token: "control",
		connectionRole: options.role,
		fetch: fetcher,
	});
	return { port, ...fake, counts, generations: () => generations };
}
