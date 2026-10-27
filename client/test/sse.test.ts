import { describe, expect, it, vi } from "vitest";
import { readSse, sseParser } from "../sse";

const encoder = new TextEncoder();
function stream(chunks: string[], keepOpen = false) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			if (!keepOpen) controller.close();
		},
	});
}
const eventStream = (body: ReadableStream<Uint8Array>) =>
	new Response(body, { headers: { "Content-Type": "text/event-stream" } });

describe("sseParser", () => {
	it("collects events across chunks, with CRLF, multi-line data, ids and comments", () => {
		const parser = sseParser({});
		expect(
			parser.push("id: s:1\r\nevent: change\r\ndata: {}\r\n\r\n: heart"),
		).toEqual([{ event: "change", id: "s:1", data: "{}" }]);
		expect(parser.push("beat\n\nevent: output\ndata: a\ndata: b")).toEqual([]);
		expect(parser.push("\n\nevent: exit\n\n")).toEqual([
			{ event: "output", id: "", data: "a\nb" },
			{ event: "exit", id: "", data: undefined },
		]);
	});

	it("bounds the frame being read, not the complete frames of one chunk", () => {
		const parser = sseParser({ maxFrame: 20, tooLarge: "frame_too_large" });
		// Many complete small frames arrive together: nothing is held back.
		expect(parser.push("data: 1234567\n\n".repeat(10))).toHaveLength(10);
		expect(() => parser.push(`data: ${"x".repeat(30)}`)).toThrow(
			"frame_too_large",
		);
		// A frame that completes within one chunk is bounded as well.
		expect(() =>
			sseParser({ maxFrame: 20, tooLarge: "frame_too_large" }).push(
				`data: ${"y".repeat(30)}\n\n`,
			),
		).toThrow("frame_too_large");
	});
});

describe("readSse", () => {
	it("stops when the reader says so and reports the end of a stream otherwise", async () => {
		const seen: string[] = [];
		const stopped = await readSse(
			async () => eventStream(stream(["data: 1\n\ndata: 2\n\ndata: 3\n\n"])),
			{
				signal: new AbortController().signal,
				idleMs: 1000,
				onEvent: ({ data }) => {
					seen.push(data!);
					return data === "2";
				},
			},
		);
		expect(stopped).toBe("stopped");
		expect(seen).toEqual(["1", "2"]);
		expect(
			await readSse(async () => eventStream(stream(["data: 1\n\n"])), {
				signal: new AbortController().signal,
				idleMs: 1000,
				onEvent: () => {},
			}),
		).toBe("ended");
	});

	it("ends a silent stream after idleMs and bounds the wait for the response", async () => {
		let request: AbortSignal | undefined;
		expect(
			await readSse(
				async (signal) => {
					request = signal;
					return eventStream(stream([], true));
				},
				{
					signal: new AbortController().signal,
					idleMs: 20,
					onEvent: () => {},
				},
			),
		).toBe("ended");
		// Silence cancels the reading only; the request is not aborted (a drop, not a failure).
		expect(request?.aborted).toBe(false);
		await expect(
			readSse(
				(signal) =>
					new Promise<Response>((_, reject) =>
						signal.addEventListener("abort", () =>
							reject(new DOMException("aborted", "AbortError")),
						),
					),
				{
					signal: new AbortController().signal,
					connectMs: 20,
					idleMs: 1000,
					onEvent: () => {},
				},
			),
		).rejects.toThrow("aborted");
	});

	it("refuses a response that is not an event stream with the caller's code and releases its body", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		await expect(
			readSse(async () => new Response(body), {
				signal: new AbortController().signal,
				idleMs: 1000,
				errors: { invalid: "invalid_run_stream" },
				onEvent: () => {},
			}),
		).rejects.toThrow("invalid_run_stream");
		expect(cancel).toHaveBeenCalled();
		// Without the check, a response without a body simply ends.
		expect(
			await readSse(async () => new Response(null), {
				signal: new AbortController().signal,
				idleMs: 1000,
				onEvent: () => {},
			}),
		).toBe("ended");
	});

	it("reports the caller's abort and announces an opened stream", async () => {
		const abort = new AbortController();
		const opened = vi.fn();
		const done = readSse(async () => eventStream(stream([], true)), {
			signal: abort.signal,
			idleMs: 1000,
			onOpen: opened,
			onEvent: () => {},
		});
		await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
		abort.abort();
		expect(await done).toBe("aborted");
	});
});
