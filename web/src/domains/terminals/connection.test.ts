import { expect, test, vi } from "vitest";
import {
	createTerminalConnection,
	parseEvents,
} from "../toolchain-artifacts/terminal-connection";

const sse = (...frames: string[]) =>
	new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const frame of frames)
					controller.enqueue(new TextEncoder().encode(frame));
				controller.close();
			},
		}),
	);
const b64 = (text: string) => btoa(text);

test("parses complete events and keeps the unfinished rest", () => {
	expect(
		parseEvents(
			"event: output\ndata: YQ==\n\n: heartbeat\n\nevent: exit\ndata",
		),
	).toEqual({
		events: [{ event: "output", data: "YQ==" }],
		rest: "event: exit\ndata",
	});
});

test("writes decoded output, including frames split across reads, then reports the end", async () => {
	const ended = vi.fn();
	const client = {
		terminalInput: vi.fn(),
		resizeTerminal: vi.fn(),
		terminalOutput: vi.fn(async () =>
			sse(
				`event: output\ndata: ${b64("hel")}\n\nevent: out`,
				`put\ndata: ${b64("lo")}\n\n`,
				"event: exit\ndata: {}\n\n",
			),
		),
	};
	const connection = createTerminalConnection(client, "s1", {
		onEnded: ended,
		onResized: () => {},
		onInputFailed: () => {},
	});
	const chunks: string[] = [];
	connection.output.subscribe((chunk) =>
		chunks.push(
			typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
		),
	);
	await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce());
	expect(chunks.join("")).toBe("hello");
	expect(client.terminalOutput).toHaveBeenCalledWith(
		"s1",
		expect.any(AbortSignal),
	);
});

test("sends input in order, one request at a time, coalescing keys typed meanwhile", async () => {
	const sent: string[] = [];
	let release!: () => void;
	const client = {
		terminalInput: vi.fn(async (_id: string, data: string) => {
			sent.push(data);
			if (sent.length === 1)
				await new Promise<void>((resolve) => {
					release = resolve;
				});
		}),
		resizeTerminal: vi.fn(async () => {}),
		terminalOutput: vi.fn(),
	};
	const connection = createTerminalConnection(client, "s1", {
		onEnded: () => {},
		onResized: () => {},
		onInputFailed: () => {},
	});
	connection.input("a");
	connection.input("b");
	connection.input("c");
	expect(sent).toEqual(["a"]);
	release();
	await vi.waitFor(() => expect(sent).toEqual(["a", "bc"]));
});

test("debounces resizes and remembers the latest size", async () => {
	vi.useFakeTimers();
	const resized = vi.fn();
	const client = {
		terminalInput: vi.fn(),
		resizeTerminal: vi.fn(async () => {}),
		terminalOutput: vi.fn(),
	};
	const connection = createTerminalConnection(client, "s1", {
		onEnded: () => {},
		onResized: resized,
		onInputFailed: () => {},
	});
	connection.resize({ cols: 80, rows: 24 });
	connection.resize({ cols: 100, rows: 30 });
	await vi.advanceTimersByTimeAsync(100);
	expect(client.resizeTerminal).toHaveBeenCalledOnce();
	expect(client.resizeTerminal).toHaveBeenCalledWith("s1", {
		cols: 100,
		rows: 30,
	});
	expect(resized).toHaveBeenLastCalledWith({ cols: 100, rows: 30 });
	vi.useRealTimers();
});

test("reopens a dropped stream with a reset while the run lasts", async () => {
	const ended = vi.fn();
	const terminalOutput = vi
		.fn()
		.mockResolvedValueOnce(sse(`event: output\ndata: ${b64("one")}\n\n`))
		.mockResolvedValueOnce(
			sse(
				`event: output\ndata: ${b64("one two")}\n\n`,
				"event: exit\ndata: {}\n\n",
			),
		);
	const connection = createTerminalConnection(
		{ terminalInput: vi.fn(), resizeTerminal: vi.fn(), terminalOutput },
		"s1",
		{ onEnded: ended, onResized: () => {}, onInputFailed: () => {} },
	);
	const chunks: string[] = [];
	connection.output.subscribe((chunk) =>
		chunks.push(
			typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
		),
	);
	await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(2), {
		timeout: 3000,
	});
	expect(chunks).toEqual(["one", "\x1bc", "one two"]);
	expect(terminalOutput).toHaveBeenCalledTimes(2);
});
