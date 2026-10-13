import { readChatResponse } from "../../../infrastructure/chat-stream";
import { getLogger } from "../../../infrastructure/logger";
import type { LarmCallOptions, LarmPort } from "../contracts";
import { auxiliaryProfile, type Provider } from "./profiles";
import { fitContext } from "./context";

const log = getLogger("larm");

/** Token counts reported by the provider; non-numeric fields are ignored. */
function usageCounts(usage: Record<string, unknown> | undefined) {
	const count = (value: unknown) =>
		typeof value === "number" && Number.isFinite(value) ? value : undefined;
	const details = usage?.prompt_tokens_details;
	const fields = {
		promptTokens: count(usage?.prompt_tokens),
		completionTokens: count(usage?.completion_tokens),
		cachedTokens: count(
			details && typeof details === "object"
				? (details as Record<string, unknown>).cached_tokens
				: undefined,
		),
	};
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	);
}

/**
 * Fits the request to the model window and times the exchange. Only durations,
 * sizes and counts are logged: no prompt, answer or provider payload.
 */
export function startLlmTiming(
	profile: string,
	messages: Parameters<LarmPort["answer"]>[0],
	window: NonNullable<Provider["contextWindow"]>,
	options: LarmCallOptions | undefined,
	onDelta: ((text: string) => void) | undefined,
) {
	const selected = fitContext(
		messages,
		window,
		options?.contextPolicy === "exact",
	);
	const requestBytes = new TextEncoder().encode(
		JSON.stringify(selected),
	).length;
	const started = Date.now();
	let firstDeltaAt: number | undefined;
	return {
		selected,
		/** Reads the response; call after the request is sent. */
		async read(response: Response, signal: AbortSignal) {
			const result = await readChatResponse(
				response,
				signal,
				onDelta
					? (text) => {
							firstDeltaAt ??= Date.now();
							onDelta(text);
						}
					: undefined,
			);
			log.info("larm.llm_timing", {
				profile: profile === auxiliaryProfile ? "auxiliary" : "main",
				...(firstDeltaAt === undefined
					? {}
					: { ttftMs: firstDeltaAt - started }),
				totalMs: Date.now() - started,
				requestBytes,
				droppedMessages: messages.length - selected.length,
				...usageCounts(result.usage),
			});
			return result;
		},
	};
}
