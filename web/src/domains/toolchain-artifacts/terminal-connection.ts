import type { TerminalConnection } from "@eumenes/artifact-ui";
import { ApiError, readSse } from "../../../../client";

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
/** The server sends a heartbeat every 15 s; a connection silent for three of them is half-open. */
const IDLE_MS = 45_000;
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

/** Cuts text at most `size` UTF-16 units long without splitting a surrogate pair. */
function cut(text: string, size: number) {
	if (text.length <= size) return text.length;
	const code = text.charCodeAt(size - 1);
	return code >= 0xd800 && code <= 0xdbff ? size - 1 : size;
}

/**
 * Reads one output connection until it ends and returns whether the run exited. Any chunk (output
 * or heartbeat) proves the link alive; silence for IDLE_MS (connecting included) closes it, so the
 * caller reopens it.
 */
async function readConnection(
	client: TerminalPort,
	sessionId: string,
	signal: AbortSignal,
	reopened: boolean,
	onOutput: (data: Uint8Array | string) => void,
): Promise<boolean> {
	let exited = false;
	await readSse((attempt) => client.terminalOutput(sessionId, attempt), {
		signal,
		connectMs: IDLE_MS,
		idleMs: IDLE_MS,
		onOpen() {
			if (reopened) onOutput(RESET);
		},
		onEvent({ event, data }) {
			if (data === undefined) return;
			if (event === "exit") exited = true;
			else if (event === "output") onOutput(decodeBase64(data));
		},
	});
	return exited;
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
	hooks: {
		onEnded(): void;
		onResized(size: Size): void;
		/** Typed input could not be sent; it is dropped, not replayed later. */
		onInputFailed(): void;
	},
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
				hooks.onInputFailed();
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
				// network break, silence past the heartbeat, the per-session stream limit) is opened
				// again while the run lasts.
				void (async () => {
					let delay = RECONNECT_MS.first;
					for (let attempt = 0; !signal.aborted; attempt++) {
						let exited = false;
						try {
							exited = await readConnection(
								client,
								sessionId,
								signal,
								attempt > 0,
								(data) => {
									listener(data);
									if (typeof data !== "string") delay = RECONNECT_MS.first;
								},
							);
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
