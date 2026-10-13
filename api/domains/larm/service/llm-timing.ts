import { readChatResponse } from "../../../infrastructure/chat-stream";
import { getLogger } from "../../../infrastructure/logger";
import type { LarmCallOptions, LarmPort } from "../contracts";
import { type Provider } from "./profiles";
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
 * Exactly one `larm.llm_timing` is emitted per exchange, success or failure.
 */
export function startLlmTiming(
	_profile: string,
	messages: Parameters<LarmPort["answer"]>[0],
	window: NonNullable<Provider["contextWindow"]>,
	options: LarmCallOptions | undefined,
	onDelta: ((text: string) => void) | undefined,
	formalCount = false,
) {
	// The fit check already measured the final messages; no extra serialization.
	const fitted = formalCount
		? { messages, bytes: 0 }
		: fitContext(messages, window, options?.contextPolicy === "exact");
	const selected = fitted.messages;
	let requestBytes = fitted.bytes;
	const started = Date.now();
	let firstDeltaAt: number | undefined;
	let logged = false;
	function emit(
		outcome: "ok" | "error" | "aborted",
		usage?: Record<string, unknown>,
	) {
		if (logged) return;
		logged = true;
		try {
			const fields = {
				profile: options?.sessionRole === "auxiliary" ? "auxiliary" : "main",
				outcome,
				...(firstDeltaAt === undefined
					? {}
					: { ttftMs: firstDeltaAt - started }),
				totalMs: Date.now() - started,
				requestBytes,
				droppedMessages: messages.length - selected.length,
				...usageCounts(usage),
			};
			if (outcome === "error") log.warn("larm.llm_timing", fields);
			else log.info("larm.llm_timing", fields);
		} catch {
			// Diagnostics must never change the inference result or its error.
		}
	}
	return {
		selected,
		setRequestBytes(value: number) {
			requestBytes = value;
		},
		/** Records a failure before the response could be read (send, status or exchange hook). Idempotent. */
		failed(signal: AbortSignal) {
			emit(signal.aborted ? "aborted" : "error");
		},
		/** Reads the response; call after the request is sent. */
		async read(response: Response, signal: AbortSignal) {
			let result: Awaited<ReturnType<typeof readChatResponse>>;
			try {
				result = await readChatResponse(
					response,
					signal,
					onDelta
						? (text) => {
								firstDeltaAt ??= Date.now();
								onDelta(text);
							}
						: undefined,
				);
			} catch (error) {
				emit(signal.aborted ? "aborted" : "error");
				throw error;
			}
			emit("ok", result.usage);
			return result;
		},
	};
}
