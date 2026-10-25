export type NativeTool = {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
};
export type NativeToolCall = { id: string; name: string; arguments: string };
export function nativeToolOptions(
	tools?: NativeTool[],
	choice: "auto" | "required" | "none" = "auto",
) {
	return tools?.length
		? { tools, tool_choice: choice, parallel_tool_calls: false }
		: {};
}
export function forwardToolCalls(
	result: { toolCalls?: NativeToolCall[] },
	tools?: NativeTool[],
	receive?: (calls: NativeToolCall[]) => void,
) {
	if (!result.toolCalls?.length) return;
	if (!tools?.length || !receive) throw new Error("chat_tool_calls_unexpected");
	receive(result.toolCalls);
}
export type TextDelta = (text: string) => void;

/** Allowlisted provider-reported counters, never the provider payload itself. */
export type ProviderTimings = Partial<
	Record<
		| "providerPromptMs"
		| "providerDecodeMs"
		| "providerPromptTokens"
		| "providerCachedTokens"
		| "providerOutputTokens",
		number
	>
>;
/** Safe read diagnostics, including failures. No output or provider-supplied free text. */
export type ChatDiagnostics = ProviderTimings & {
	finishReason?:
		| "stop"
		| "tool_calls"
		| "function_call"
		| "length"
		| "content_filter"
		| "unknown";
	streamDone: number;
	streamFailure?:
		| "output_limit"
		| "content_filter"
		| "missing_end"
		| "empty_output"
		| "invalid_tool_calls"
		| "aborted"
		| "invalid_response"
		| "read_error";
	promptTokens?: number;
	completionTokens?: number;
	cachedTokens?: number;
};
function usageCounts(usage: Record<string, unknown> | undefined) {
	const details = usage?.prompt_tokens_details;
	const source =
		details && typeof details === "object"
			? (details as Record<string, unknown>)
			: undefined;
	return Object.fromEntries(
		Object.entries({
			promptTokens: usage?.prompt_tokens,
			completionTokens: usage?.completion_tokens,
			cachedTokens: source?.cached_tokens,
		}).filter(([, n]) => typeof n === "number" && Number.isFinite(n) && n >= 0),
	);
}
function providerTimings(value: unknown): ProviderTimings | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const source = value as Record<string, unknown>;
	const result: ProviderTimings = {};
	for (const [key, field] of [
		["prompt_ms", "providerPromptMs"],
		["predicted_ms", "providerDecodeMs"],
		["prompt_n", "providerPromptTokens"],
		["cache_n", "providerCachedTokens"],
		["predicted_n", "providerOutputTokens"],
	] as const) {
		const n = source[key];
		if (typeof n === "number" && Number.isFinite(n) && n >= 0)
			result[field] = n;
	}
	return Object.keys(result).length ? result : undefined;
}

/** Consume provider bytes as they arrive; only answer content is projected. */
export async function readChatResponse(
	response: Response,
	signal: AbortSignal,
	onDelta?: TextDelta,
	onDiagnostics?: (value: ChatDiagnostics) => void,
): Promise<{
	text: string;
	usage?: Record<string, unknown>;
	providerTimings?: ProviderTimings;
	toolCalls?: NativeToolCall[];
}> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("chat_stream_missing");
	const decoder = new TextDecoder();
	const streaming = response.headers
		.get("content-type")
		?.includes("text/event-stream");
	let buffer = "",
		data: string[] = [],
		text = "",
		bytes = 0,
		done = false;
	let usage: Record<string, unknown> | undefined;
	let observedUsage: Pick<
		ChatDiagnostics,
		"promptTokens" | "completionTokens" | "cachedTokens"
	> = {};
	let measured: ProviderTimings | undefined;
	const calls = new Map<number, NativeToolCall>();
	let truncated: "output_limit" | "content_filter" | undefined;
	let finishReason: ChatDiagnostics["finishReason"];
	let streamFailure: ChatDiagnostics["streamFailure"];
	function toolCalls(value: unknown) {
		if (!Array.isArray(value)) return;
		for (const [ordinal, call] of value.entries()) {
			if (
				!call ||
				typeof call !== "object" ||
				(call.type !== undefined && call.type !== "function")
			)
				throw new Error("chat_tool_calls_invalid");
			const index = call.index ?? ordinal;
			for (const field of [
				call.id,
				call.function?.name,
				call.function?.arguments,
			])
				if (field !== undefined && typeof field !== "string")
					throw new Error("chat_tool_calls_invalid");
			if (!Number.isInteger(index) || index < 0 || index >= 8)
				throw new Error("chat_tool_calls_invalid");
			const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
			if (call.id) current.id += call.id;
			if (call.function?.name) current.name += call.function.name;
			if (call.function?.arguments)
				current.arguments += call.function.arguments;
			if (
				current.arguments.length > 16384 ||
				current.name.length > 128 ||
				current.id.length > 256
			)
				throw new Error("chat_tool_calls_invalid");
			calls.set(index, current);
		}
	}
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	function content(value: unknown) {
		if (typeof value !== "string" || !value) return;
		if (text.length + value.length > 65536)
			throw new Error("chat_output_too_large");
		signal.throwIfAborted();
		text += value;
		onDelta?.(value);
	}
	function frame(raw: string) {
		if (raw === "[DONE]") {
			done = true;
			return;
		}
		if (done) throw new Error("chat_stream_after_done");
		const item = JSON.parse(raw) as {
			error?: unknown;
			usage?: Record<string, unknown>;
			timings?: unknown;
			choices?: Array<{
				index?: number;
				delta?: { content?: unknown; tool_calls?: unknown };
				message?: { content?: unknown; tool_calls?: unknown };
				finish_reason?: string;
			}>;
		};
		if (item.error) throw new Error("chat_stream_error");
		usage = item.usage ?? usage;
		observedUsage = { ...observedUsage, ...usageCounts(item.usage) };
		const counters = providerTimings(item.timings);
		if (counters) measured = { ...measured, ...counters };
		const choice = item.choices?.find(
			(c) => c.index === 0 || c.index === undefined,
		);
		if (choice?.finish_reason != null) {
			finishReason = [
				"stop",
				"tool_calls",
				"function_call",
				"length",
				"content_filter",
			].includes(choice.finish_reason)
				? (choice.finish_reason as NonNullable<ChatDiagnostics["finishReason"]>)
				: "unknown";
		}
		content(streaming ? choice?.delta?.content : choice?.message?.content);
		toolCalls(
			streaming ? choice?.delta?.tool_calls : choice?.message?.tool_calls,
		);
		if (choice?.finish_reason === "length") truncated ??= "output_limit";
		if (choice?.finish_reason === "content_filter")
			truncated ??= "content_filter";
	}
	try {
		for (;;) {
			signal.throwIfAborted();
			const next = await reader.read();
			signal.throwIfAborted();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > 1000000) throw new Error("chat_stream_too_large");
			buffer += decoder.decode(next.value, { stream: true });
			if (!streaming) continue;
			let end: number;
			while ((end = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, end).replace(/\r$/, "");
				buffer = buffer.slice(end + 1);
				if (!line) {
					if (data.length) frame(data.join("\n"));
					data = [];
				} else if (line.startsWith("data:"))
					data.push(line.slice(5).trimStart());
			}
			if (buffer.length + data.join("\n").length > 65536)
				throw new Error("chat_frame_too_large");
			if (done) break;
		}
		if (!streaming) {
			frame(buffer + decoder.decode());
			done = true;
		}
		if (!done || truncated || (!text.trim() && !calls.size)) {
			streamFailure = truncated ?? (!done ? "missing_end" : "empty_output");
			throw new Error("chat_stream_incomplete");
		}
		const native = [...calls.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, call]) => call);
		if (native.some((call) => !call.id || !call.name || !call.arguments))
			throw new Error("chat_tool_calls_invalid");
		return {
			text,
			usage,
			...(measured ? { providerTimings: measured } : {}),
			...(native.length ? { toolCalls: native } : {}),
		};
	} catch (error) {
		streamFailure = signal.aborted
			? "aborted"
			: (streamFailure ??
				(error instanceof Error && error.message === "chat_tool_calls_invalid"
					? "invalid_tool_calls"
					: error instanceof SyntaxError ||
						  (error instanceof Error &&
								[
									"chat_stream_error",
									"chat_stream_after_done",
									"chat_output_too_large",
									"chat_stream_too_large",
									"chat_frame_too_large",
								].includes(error.message))
						? "invalid_response"
						: "read_error"));
		throw error;
	} finally {
		try {
			onDiagnostics?.({
				...observedUsage,
				...measured,
				...(finishReason ? { finishReason } : {}),
				streamDone: done ? 1 : 0,
				...(streamFailure ? { streamFailure } : {}),
			});
		} catch {
			// Observation must never replace the result, cancellation or original error.
		}
		signal.removeEventListener("abort", cancel);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
