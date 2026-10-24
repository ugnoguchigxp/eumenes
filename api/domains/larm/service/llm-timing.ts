import {
	readChatResponse,
	type ChatDiagnostics,
} from "../../../infrastructure/chat-stream";
import { getLogger } from "../../../infrastructure/logger";
import type { LarmCallOptions, LarmPort } from "../contracts";
import { type Provider } from "./profiles";
import { fitContext } from "./context";

const log = getLogger("larm");

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
		: fitContext(
				messages,
				window,
				options?.contextPolicy === "exact",
				options?.history,
			);
	const selected = fitted.messages;
	let requestBytes = fitted.bytes;
	const started = performance.now();
	let sentAt: number | undefined;
	let firstDeltaAt: number | undefined;
	let logged = false;
	let diagnostics: ChatDiagnostics | undefined;
	function emit(outcome: "ok" | "error" | "aborted") {
		if (logged) return;
		logged = true;
		try {
			const fields = {
				profile:
					options?.sessionRole === "auxiliary" ||
					options?.sessionRole === "subagent"
						? "auxiliary"
						: "main",
				outcome,
				...(firstDeltaAt === undefined
					? {}
					: { ttftMs: firstDeltaAt - started }),
				totalMs: performance.now() - started,
				...(firstDeltaAt !== undefined && sentAt !== undefined
					? { providerTtftMs: firstDeltaAt - sentAt }
					: {}),
				requestBytes,
				droppedMessages: messages.length - selected.length,
				...diagnostics,
			};
			if (outcome === "error") log.warn("larm.llm_timing", fields);
			else log.info("larm.llm_timing", fields);
		} catch {
			// Diagnostics must never change the inference result or its error.
		}
	}
	return {
		selected,
		sent() {
			sentAt = performance.now();
		},
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
								if (text) firstDeltaAt ??= performance.now();
								onDelta(text);
							}
						: undefined,
					(value) => {
						diagnostics = value;
					},
				);
			} catch (error) {
				emit(signal.aborted ? "aborted" : "error");
				throw error;
			}
			emit("ok");
			return result;
		},
	};
}
