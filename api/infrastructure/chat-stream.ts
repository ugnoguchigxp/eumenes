export type TextDelta = (text: string) => void;

/** Consume provider bytes as they arrive; only answer content is projected. */
export async function readChatResponse(
	response: Response,
	signal: AbortSignal,
	onDelta?: TextDelta,
): Promise<{ text: string; usage?: Record<string, unknown> }> {
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
			choices?: Array<{
				index?: number;
				delta?: { content?: unknown };
				message?: { content?: unknown };
			}>;
		};
		if (item.error) throw new Error("chat_stream_error");
		usage = item.usage ?? usage;
		const choice = item.choices?.find(
			(c) => c.index === 0 || c.index === undefined,
		);
		content(streaming ? choice?.delta?.content : choice?.message?.content);
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
		if (!done || !text.trim()) throw new Error("chat_stream_incomplete");
		return { text, usage };
	} finally {
		signal.removeEventListener("abort", cancel);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
