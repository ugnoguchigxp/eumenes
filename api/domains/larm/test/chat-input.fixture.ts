import { createHash } from "node:crypto";
import { createLarm, silentWav } from "..";
import type { ChatInput } from "../contracts/chat-input";

export const imagePolicy: ChatInput = {
	contractVersion: "larm-chat-input.v1",
	maxRequestBytes: 4194304,
	images: {
		mimeTypes: ["image/jpeg", "image/png", "image/bmp"],
		referenceTypes: ["data-url"],
		roles: ["user"],
		maxImages: 8,
		maxBytes: 3145728,
		maxWidth: 8192,
		maxHeight: 8192,
		maxPixels: 16777216,
		maxAspectRatio: 100,
		detail: "auto-only",
		orientation: "encoded-pixels",
		alpha: "discard",
	},
	tokenCounting: {
		protocol: "llama-chat-token-count.v1",
		endpoint: "/v1/chat/completions/input-tokens",
	},
	retention: {
		inferenceAudit: "full-required",
		requestPayloadStored: true,
		maxRetentionSeconds: 604800,
		encrypted: true,
		tokenCountPayloadStored: false,
		providerImageStore: false,
		historyResendRequired: true,
	},
};

export function imageLarmFixture(
	options: {
		fits?: boolean;
		vision?: boolean;
		maxBody?: number;
		countError?: boolean;
		gate?: "count" | "generate";
		renew?: boolean;
		response?: string;
		generationNetworkError?: boolean;
		generationGate?: Promise<void>;
	} = {},
) {
	const requests: { operation: string; body: string; token: string }[] = [];
	let revision = 1;
	const provider = () => ({
		name: "llm",
		protocol: "openai.chat-completions.v1",
		model: "fixture-vision-model",
		endpoint: "/v1/chat/completions",
		contextWindow: {
			maxTokens: 262144,
			outputReserveTokens: 4096,
			safetyMarginTokens: 1976,
		},
		supportedCapabilities:
			options.vision === false ? ["llm"] : ["llm", "llm.vision"],
		chatInput: {
			...imagePolicy,
			maxRequestBytes: options.maxBody ?? imagePolicy.maxRequestBytes,
		},
	});
	const connection = () => ({
		id: "vision-session",
		profile: "ornith1.5Strix",
		agentProfile: "ornith1.5Strix",
		status: "ready",
		expiresAt: new Date(
			Date.now() + (options.renew && revision === 1 ? 40000 : 900000),
		).toISOString(),
		providers: [{ ...provider(), readiness: "ready", claimable: true }],
	});
	const request = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const path = url.pathname;
		if (init?.method === "DELETE") return new Response(null, { status: 204 });
		if (path === "/v3/agent-profiles")
			return Response.json({
				contractVersion: "agent-connection.v3",
				catalogRevision: "rev",
				requestedProfile: "ornith1.5Strix",
				profiles: [{ id: "ornith1.5Strix", providers: [provider()] }],
			});
		if (path === "/v1/agent-connections")
			return Response.json(connection(), { status: 201 });
		if (path.endsWith("/renew")) {
			revision++;
			return Response.json(connection());
		}
		if (path.endsWith("/claim"))
			return Response.json({
				...connection(),
				providers: [
					{
						...provider(),
						endpoint: "http://127.0.0.1:9998/v1/chat/completions",
						baseUrl: "http://127.0.0.1:9998/v1",
						credential: { token: `claim-${revision}` },
						configuration: {
							fields: {
								baseURL: "http://127.0.0.1:9998/v1",
								model: provider().model,
							},
						},
					},
				],
			});
		if (path.startsWith("/v1/agent-connections/"))
			return Response.json(connection());
		const body = String(init?.body);
		const parsed = JSON.parse(body);
		const count = path.endsWith("/input-tokens");
		requests.push({
			operation: count ? "count" : "generate",
			body,
			token: new Headers(init?.headers).get("Authorization") ?? "",
		});
		if (options.gate === (count ? "count" : "generate"))
			await new Promise((_, reject) => {
				const stop = () => reject(init?.signal?.reason);
				init?.signal?.addEventListener("abort", stop, { once: true });
				if (init?.signal?.aborted) stop();
			});
		if (count) {
			if (options.countError)
				return Response.json(
					{ error: { code: "chat_token_count_unavailable" } },
					{ status: 503 },
				);
			const imageCount = parsed.messages.reduce(
				(n: number, m: { content: unknown }) =>
					n +
					(Array.isArray(m.content)
						? m.content.filter((p: { type: string }) => p.type === "image_url")
								.length
						: 0),
				0,
			);
			return Response.json({
				contractVersion: "larm-chat-input-token-count.v1",
				model: parsed.model,
				promptTokens: 100 + imageCount * 10,
				textTokens: 100,
				imageTokens: imageCount * 10,
				imageCount,
				requestedOutputTokens: parsed.max_tokens,
				safetyMarginTokens: 1976,
				inputBudgetTokens: 262144 - parsed.max_tokens - 1976,
				maxContextTokens: 262144,
				fits: options.fits !== false,
				requestDigest: createHash("sha256").update(body).digest("hex"),
				runtime: "fixture",
				configRevision: "rev",
				bootEpoch: "epoch",
				engineBuild: "fixture",
			});
		}
		if (options.generationGate) await options.generationGate;
		const text = options.response ?? "画像を確認しました。";
		if (options.generationNetworkError) throw new TypeError("fetch failed");
		if (parsed.stream)
			return new Response(
				`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		return Response.json({ choices: [{ message: { content: text } }] });
	};
	const p = createLarm({
		baseUrl: "http://127.0.0.1:9998",
		token: "control-fixture",
		fetch: request,
	});
	return {
		p: { ...p, judge: undefined, speak: async () => silentWav() },
		requests,
	};
}
