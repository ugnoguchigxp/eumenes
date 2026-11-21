import type { Analyze } from "eumenes_router";
import { getLogger } from "../../../infrastructure/logger";
import type { SettingsService } from "../../settings";

type Prompt = Parameters<Analyze>[0];
type ResponseUsage = {
	input_tokens?: unknown;
	input_tokens_details?: { cached_tokens?: unknown } | null;
	output_tokens?: unknown;
};
const log = getLogger("inference");
const tokenCount = (value: unknown) =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;

export function createRouterSelection(
	settings: Pick<SettingsService, "get" | "credential">,
	request: (
		input: URL | RequestInfo,
		init?: RequestInit,
	) => Promise<Response> = fetch,
	env = process.env,
) {
	function connection() {
		const saved = settings.get();
		if (!saved.routes.llm.cloudAllowed || saved.routes.llm.mode === "larm-only")
			return null;
		const id = saved.router.structureResourceId ?? saved.routes.llm.fallbackId;
		const resource = saved.resources.find(
			(item) => item.id === id && item.purpose === "llm",
		);
		const provider = saved.connections.find(
			(item) => item.id === resource?.connectionId && item.enabled,
		);
		if (
			!resource ||
			!provider ||
			new URL(provider.baseUrl).origin !== "https://api.openai.com"
		)
			return null;
		return { model: resource.model, provider };
	}
	function resolve() {
		const chosen = connection();
		if (!chosen) return null;
		const key =
			env.OPEN_AI_API_KEY?.trim() ||
			env.OPENAI_API_KEY?.trim() ||
			settings.credential(chosen.provider);
		return key ? { model: chosen.model, key } : null;
	}
	return {
		routerSelectionAvailable: () => !!resolve(),
		async selectRouter(prompt: Prompt, signal: AbortSignal): Promise<string> {
			const chosen = resolve();
			if (!chosen) throw new Error("router_selection_unavailable");
			const started = performance.now();
			let usage: ResponseUsage | null | undefined;
			let outcome = "error";
			try {
				const response = await request("https://api.openai.com/v1/responses", {
					method: "POST",
					signal,
					redirect: "error",
					headers: {
						Authorization: `Bearer ${chosen.key}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: chosen.model,
						instructions: prompt.system,
						input: prompt.user,
						store: false,
						max_output_tokens: 2048,
						reasoning: { effort: "none" },
						text: {
							format: {
								type: "json_schema",
								name: prompt.version,
								strict: true,
								schema: prompt.outputSchema,
							},
						},
					}),
				});
				if (!response.ok) {
					await response.body?.cancel();
					throw new Error(`router_selection_http_${response.status}`);
				}
				const payload = (await response.json()) as {
					status?: string;
					usage?: ResponseUsage | null;
					output?: Array<{
						type?: string;
						role?: string;
						status?: string;
						content?: Array<{ type?: string; text?: string }>;
					}>;
				} | null;
				usage = payload?.usage;
				signal.throwIfAborted();
				if (payload?.status !== "completed" || !Array.isArray(payload.output))
					throw new Error("router_selection_incomplete");
				const messages = payload.output.filter(
					(item) => item?.type !== "reasoning",
				);
				const message = messages[0];
				const content = message?.content;
				if (
					messages.length !== 1 ||
					message?.type !== "message" ||
					message.role !== "assistant" ||
					message.status !== "completed" ||
					!Array.isArray(content) ||
					content.length !== 1 ||
					content[0]?.type !== "output_text" ||
					typeof content[0].text !== "string"
				)
					throw new Error("router_selection_invalid_response");
				outcome = "ok";
				return content[0].text;
			} finally {
				try {
					const promptTokens = tokenCount(usage?.input_tokens);
					const cached = tokenCount(usage?.input_tokens_details?.cached_tokens);
					log.info("inference.router_usage", {
						outcome,
						durationMs: performance.now() - started,
						promptTokens,
						cachedTokens:
							cached !== undefined &&
							promptTokens !== undefined &&
							cached <= promptTokens
								? cached
								: undefined,
						completionTokens: tokenCount(usage?.output_tokens),
					});
				} catch {
					// Logging cannot change the selection or its failure.
				}
			}
		},
	};
}
