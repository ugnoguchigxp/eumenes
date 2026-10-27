/** One server-sent event: its name and id (empty when absent) and its data (undefined without a data line). */
export type SseEvent = { event: string; id: string; data: string | undefined };

/**
 * Collects events from text as it arrives. Lines may end in CRLF; comments (`:`, such as the
 * heartbeat) and unknown fields are ignored; an event is emitted at its blank line. A frame may
 * hold at most `maxFrame` characters of data (no bound without it): checked when it completes and,
 * for one still being read, on what it holds so far, so `tooLarge` never waits for its end.
 */
export function sseParser(options: { maxFrame?: number; tooLarge?: string }) {
	let rest = "";
	let event = "";
	let id = "";
	let data: string[] | undefined;
	return {
		push(text: string): SseEvent[] {
			rest += text;
			const events: SseEvent[] = [];
			let end: number;
			while ((end = rest.indexOf("\n")) >= 0) {
				const line = rest.slice(0, end).replace(/\r$/, "");
				rest = rest.slice(end + 1);
				if (!line) {
					const joined = data?.join("\n");
					if (
						options.maxFrame !== undefined &&
						(joined?.length ?? 0) > options.maxFrame
					)
						throw new Error(options.tooLarge ?? "sse_frame_too_large");
					if (event || id || data) events.push({ event, id, data: joined });
					event = "";
					id = "";
					data = undefined;
				} else if (line.startsWith("data:"))
					(data ??= []).push(line.slice(5).trimStart());
				else if (line.startsWith("event:")) event = line.slice(6).trimStart();
				else if (line.startsWith("id:")) id = line.slice(3).trimStart();
			}
			const held = rest.length + (data?.join("\n").length ?? 0);
			if (options.maxFrame !== undefined && held > options.maxFrame)
				throw new Error(options.tooLarge ?? "sse_frame_too_large");
			return events;
		},
	};
}

/**
 * Opens one event stream and reads it until it ends, `onEvent` returns true (`stopped`), or the
 * caller aborts (`aborted`). Silence for `idleMs` (not even a heartbeat) cancels the reading and
 * ends it as `ended`, like a drop; the request itself is not aborted. `connectMs` bounds the wait
 * for the response; the request then fails as aborted.
 * With `errors.invalid`, a response that is not an event stream is refused with that code; without
 * it, a response without a body simply ends. A frame over `maxFrame` throws `errors.tooLarge`.
 */
export async function readSse(
	open: (signal: AbortSignal) => Promise<Response>,
	options: {
		signal: AbortSignal;
		idleMs: number;
		connectMs?: number;
		maxFrame?: number;
		errors?: { invalid?: string; tooLarge?: string };
		/** The stream opened and is about to be read. */
		onOpen?(): void;
		onEvent(event: SseEvent): boolean | void;
	},
): Promise<"ended" | "stopped" | "aborted"> {
	const attempt = new AbortController();
	const signal = AbortSignal.any([options.signal, attempt.signal]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let idle = false;
	const stop = () => {
		void reader?.cancel().catch(() => {});
	};
	const arm = (ms: number, expire: () => void) => {
		clearTimeout(timer);
		timer = setTimeout(expire, ms);
	};
	const silent = () => {
		idle = true;
		stop();
	};
	signal.addEventListener("abort", stop, { once: true });
	try {
		if (options.connectMs !== undefined)
			arm(options.connectMs, () => attempt.abort());
		const response = await open(signal);
		if (options.errors?.invalid) {
			const type = response.headers.get("content-type") ?? "";
			if (!type.startsWith("text/event-stream") || !response.body) {
				await response.body?.cancel().catch(() => {});
				throw new Error(options.errors?.invalid);
			}
		}
		if (!response.body) return "ended";
		reader = response.body.getReader();
		if (signal.aborted) stop();
		options.onOpen?.();
		const parser = sseParser({
			maxFrame: options.maxFrame,
			tooLarge: options.errors?.tooLarge,
		});
		const decoder = new TextDecoder();
		clearTimeout(timer);
		arm(options.idleMs, silent);
		for (;;) {
			let chunk: Awaited<ReturnType<typeof reader.read>>;
			try {
				chunk = await reader.read();
			} catch (error) {
				if (options.signal.aborted) return "aborted";
				if (idle) return "ended";
				throw error;
			}
			const { done, value } = chunk;
			if (done || options.signal.aborted) break;
			arm(options.idleMs, silent);
			for (const event of parser.push(decoder.decode(value, { stream: true })))
				if (options.onEvent(event) === true) return "stopped";
		}
		return options.signal.aborted ? "aborted" : "ended";
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", stop);
		await reader?.cancel().catch(() => {});
		reader?.releaseLock();
	}
}
