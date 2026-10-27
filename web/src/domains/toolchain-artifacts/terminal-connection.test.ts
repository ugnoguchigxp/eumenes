import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createTerminalConnection } from "./terminal-connection";

const encoder = new TextEncoder();

/** An open event stream the test feeds by hand; it never ends on its own. */
function openStream() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		}),
	);
	return {
		response,
		send: (frame: string) => controller.enqueue(encoder.encode(frame)),
	};
}
const hooks = () => ({
	onEnded: vi.fn(),
	onResized: vi.fn(),
	onInputFailed: vi.fn(),
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("a half-open output stream with no heartbeat is closed after 45 s and opened again with a reset", async () => {
	const silent = openStream();
	const next = openStream();
	const terminalOutput = vi
		.fn()
		.mockResolvedValueOnce(silent.response)
		.mockResolvedValueOnce(next.response);
	const h = hooks();
	const connection = createTerminalConnection(
		{ terminalInput: vi.fn(), resizeTerminal: vi.fn(), terminalOutput },
		"s1",
		h,
	);
	const chunks: Array<string | Uint8Array> = [];
	const unsubscribe = connection.output.subscribe((chunk) =>
		chunks.push(chunk),
	);
	await vi.advanceTimersByTimeAsync(44_000);
	expect(terminalOutput).toHaveBeenCalledTimes(1);
	expect(h.onEnded).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1_000);
	expect(h.onEnded).toHaveBeenCalledOnce();
	// The reconnect waits its first backoff step, then replays from a clean screen.
	await vi.advanceTimersByTimeAsync(500);
	expect(terminalOutput).toHaveBeenCalledTimes(2);
	expect(chunks).toEqual(["\x1bc"]);
	unsubscribe();
});

test("heartbeats keep a quiet stream open past 45 s", async () => {
	const stream = openStream();
	const terminalOutput = vi.fn().mockResolvedValue(stream.response);
	const h = hooks();
	const connection = createTerminalConnection(
		{ terminalInput: vi.fn(), resizeTerminal: vi.fn(), terminalOutput },
		"s1",
		h,
	);
	const unsubscribe = connection.output.subscribe(() => {});
	for (let beat = 0; beat < 6; beat++) {
		await vi.advanceTimersByTimeAsync(15_000);
		stream.send(": heartbeat\n\n");
	}
	await vi.advanceTimersByTimeAsync(1_000);
	expect(terminalOutput).toHaveBeenCalledOnce();
	expect(h.onEnded).not.toHaveBeenCalled();
	unsubscribe();
});

test("unsubscribing stops the watchdog and does not reopen the stream", async () => {
	const stream = openStream();
	const terminalOutput = vi.fn().mockResolvedValue(stream.response);
	const h = hooks();
	const connection = createTerminalConnection(
		{ terminalInput: vi.fn(), resizeTerminal: vi.fn(), terminalOutput },
		"s1",
		h,
	);
	const unsubscribe = connection.output.subscribe(() => {});
	await vi.advanceTimersByTimeAsync(10_000);
	unsubscribe();
	await vi.advanceTimersByTimeAsync(120_000);
	expect(terminalOutput).toHaveBeenCalledOnce();
	expect(h.onEnded).not.toHaveBeenCalled();
});

test("a failed input send is reported once and the typed text is dropped", async () => {
	const terminalInput = vi
		.fn()
		.mockRejectedValueOnce(new Error("network"))
		.mockResolvedValue(undefined);
	const h = hooks();
	const connection = createTerminalConnection(
		{ terminalInput, resizeTerminal: vi.fn(), terminalOutput: vi.fn() },
		"s1",
		h,
	);
	connection.input("a");
	connection.input("b");
	await vi.advanceTimersByTimeAsync(0);
	expect(h.onInputFailed).toHaveBeenCalledOnce();
	expect(terminalInput).toHaveBeenCalledTimes(1);
	connection.input("c");
	await vi.advanceTimersByTimeAsync(0);
	expect(terminalInput).toHaveBeenLastCalledWith("s1", "c");
	expect(h.onInputFailed).toHaveBeenCalledOnce();
});
