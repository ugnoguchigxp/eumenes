import type { TerminalConnection } from "@eumenes/artifact-ui";
import { ApiError } from "../../../../client";

type Size = { cols: number; rows: number };
export type TerminalPort = {
	terminalInput(id: string, data: string): Promise<void>;
	resizeTerminal(id: string, size: Size): Promise<void>;
	terminalOutput(id: string, signal: AbortSignal): Promise<Response>;
};

/** Largest input request; a long paste is sent as several ordered requests. */
const INPUT_CHUNK = 16_384;
const RESIZE_DELAY_MS = 80;
const RECONNECT_MS = { first: 500, max: 10_000 };
/** Full terminal reset (RIS): the server replays the backlog on every connection. */
const RESET = "\x1bc";

const wait = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Splits server-sent events; returns the complete events and the unfinished rest. */
export function parseEvents(buffer: string): {
	events: Array<{ event: string; data: string }>;
	rest: string;
} {
	const blocks = buffer.split("\n\n");
	const rest = blocks.pop() ?? "";
	const events = blocks.flatMap((block) => {
		let event = "message";
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line.startsWith("event: ")) event = line.slice(7);
			else if (line.startsWith("data: ")) data.push(line.slice(6));
		}
		return data.length ? [{ event, data: data.join("\n") }] : [];
	});
	return { events, rest };
}

/** Cuts text at most `size` UTF-16 units long without splitting a surrogate pair. */
function cut(text: string, size: number) {
	if (text.length <= size) return text.length;
	const code = text.charCodeAt(size - 1);
	return code >= 0xd800 && code <= 0xdbff ? size - 1 : size;
}

/**
 * The live link of one session run: the output stream opens on subscribe, input is sent in
 * order (one request at a time, coalescing keystrokes typed meanwhile), and resizes are
 * debounced. `onEnded` fires whenever the stream stops (the run exited, or it dropped and is
 * reopened), so the host reads the session list again.
 */
export function createTerminalConnection(
	client: TerminalPort,
	sessionId: string,
	hooks: { onEnded(): void; onResized(size: Size): void },
): TerminalConnection {
	let pending = "";
	let sending = false;
	let resizeTimer: ReturnType<typeof setTimeout> | undefined;
	async function flush() {
		sending = true;
		while (pending) {
			const end = cut(pending, INPUT_CHUNK);
			const chunk = pending.slice(0, end);
			pending = pending.slice(end);
			try {
				await client.terminalInput(sessionId, chunk);
			} catch {
				// The run ended or the link dropped; typed input is not replayed later.
				pending = "";
			}
		}
		sending = false;
	}
	return {
		output: {
			subscribe(listener) {
				const abort = new AbortController();
				const { signal } = abort;
				// One connection at a time. A stream that stops without `exit` (dropped as slow, a
				// network break, the per-session stream limit) is opened again while the run lasts.
				void (async () => {
					let delay = RECONNECT_MS.first;
					for (let attempt = 0; !signal.aborted; attempt++) {
						let exited = false;
						try {
							const response = await client.terminalOutput(sessionId, signal);
							const reader = response.body
								?.pipeThrough(new TextDecoderStream())
								.getReader();
							if (reader && attempt > 0) listener(RESET);
							let buffer = "";
							while (reader) {
								const { value, done } = await reader.read();
								if (done) break;
								const parsed = parseEvents(buffer + value);
								buffer = parsed.rest;
								for (const { event, data } of parsed.events) {
									if (event === "exit") exited = true;
									else if (event === "output") {
										listener(decodeBase64(data));
										delay = RECONNECT_MS.first;
									}
								}
							}
						} catch (error) {
							if (signal.aborted) return;
							if (error instanceof ApiError && error.status === 404)
								exited = true;
						}
						if (signal.aborted) return;
						// The list is read again either way: a new run replaces this connection.
						hooks.onEnded();
						if (exited) return;
						await wait(delay, signal);
						delay = Math.min(delay * 2, RECONNECT_MS.max);
					}
				})();
				return () => abort.abort();
			},
		},
		input(data) {
			pending += data;
			if (!sending) void flush();
		},
		resize(size) {
			hooks.onResized(size);
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => {
				void client.resizeTerminal(sessionId, size).catch(() => {});
			}, RESIZE_DELAY_MS);
		},
	};
}
