import { afterEach, expect, spyOn, test } from "bun:test";
import { configureLogging, getLogger } from "../../../infrastructure/logger";
import { fitContext } from "../service/context";
import { startLlmTiming } from "../service/llm-timing";

const window = {
	maxTokens: 4000,
	outputReserveTokens: 100,
	safetyMarginTokens: 100,
};
const messages = [
	{ role: "system" as const, content: "secret-policy" },
	{ role: "user" as const, content: "secret-question" },
];
const encoded = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).length;

function capture() {
	const lines: Array<Record<string, unknown>> = [];
	configureLogging({
		level: "info",
		destination: { write: (line) => void lines.push(JSON.parse(line)) },
	});
	return lines;
}
const timings = (lines: Array<Record<string, unknown>>) =>
	lines.filter((line) => line.event === "larm.llm_timing");
const sse = (...frames: string[]) =>
	new Response(frames.map((frame) => `data: ${frame}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});

afterEach(() => configureLogging({ level: "silent" }));

test("the fit check reports the byte size of the returned messages without extra serialization", () => {
	const stringify = spyOn(JSON, "stringify");
	let fitted: ReturnType<typeof fitContext>;
	let serialized: number;
	try {
		fitted = fitContext(messages, window);
		serialized = stringify.mock.calls.filter(([value]) =>
			Array.isArray(value),
		).length;
	} finally {
		stringify.mockRestore();
	}
	// Nothing was dropped: the messages are serialized exactly once.
	expect(serialized).toBe(1);
	expect(fitted.bytes).toBe(encoded(fitted.messages));
	const long = [
		messages[0]!,
		...Array.from({ length: 8 }, (_, i) => ({
			role: i % 2 ? ("assistant" as const) : ("user" as const),
			content: `turn${i}-${"x".repeat(2000)}`,
		})),
		messages[1]!,
	];
	const trimmed = fitContext(long, window);
	expect(trimmed.messages.length).toBeLessThan(long.length);
	expect(trimmed.bytes).toBe(encoded(trimmed.messages));
});

test("the timing log reuses the fit estimate instead of serializing the messages again", async () => {
	const lines = capture();
	const stringify = spyOn(JSON, "stringify");
	let timing: ReturnType<typeof startLlmTiming>;
	try {
		timing = startLlmTiming("SAAA", messages, window, undefined, undefined);
		expect(
			stringify.mock.calls.filter(([value]) => Array.isArray(value)),
		).toHaveLength(1);
	} finally {
		stringify.mockRestore();
	}
	await timing.read(
		sse('{"choices":[{"delta":{"content":"ok"}}]}', "[DONE]"),
		new AbortController().signal,
	);
	const [entry] = timings(lines);
	expect(entry?.requestBytes).toBe(encoded(timing.selected));
	expect(entry?.outcome).toBe("ok");
});

test("a failed read logs outcome=error with known timings, usage only when present, and no text", async () => {
	const lines = capture();
	const timing = startLlmTiming("SAAA", messages, window, undefined, () => {});
	const failure = await timing
		.read(
			sse(
				'{"choices":[{"delta":{"content":"secret-answer"}}]}',
				'{"usage":{"prompt_tokens":9}}',
			),
			new AbortController().signal,
		)
		.catch((error) => error);
	expect((failure as Error).message).toBe("chat_stream_incomplete");
	const entries = timings(lines);
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({
		level: "warn",
		outcome: "error",
		profile: "main",
		droppedMessages: 0,
		requestBytes: encoded(timing.selected),
	});
	expect(entries[0]?.totalMs).toBeGreaterThanOrEqual(0);
	expect(entries[0]?.ttftMs).toBeGreaterThanOrEqual(0);
	expect(entries[0]?.completionTokens).toBeUndefined();
	timing.failed(new AbortController().signal);
	expect(timings(lines)).toHaveLength(1);
	for (const text of ["secret-answer", "secret-policy", "secret-question"])
		expect(JSON.stringify(lines)).not.toContain(text);
});

test("a failure before any response is logged once; abort is distinguished from error", async () => {
	const lines = capture();
	const failed = startLlmTiming("SAAA", messages, window, undefined, undefined);
	failed.failed(new AbortController().signal);
	const controller = new AbortController();
	controller.abort(new Error("cancelled"));
	const aborted = startLlmTiming(
		"SAAA",
		messages,
		window,
		undefined,
		undefined,
	);
	aborted.failed(controller.signal);
	aborted.failed(controller.signal);
	const entries = timings(lines);
	expect(entries.map((entry) => entry.outcome)).toEqual(["error", "aborted"]);
	for (const entry of entries) {
		expect(entry.totalMs).toBeGreaterThanOrEqual(0);
		expect(entry.requestBytes).toBeGreaterThan(0);
		expect(entry.ttftMs).toBeUndefined();
	}
	expect(entries[1]?.level).toBe("info");
});

test("an abort while streaming logs outcome=aborted and rethrows the original error", async () => {
	const lines = capture();
	const controller = new AbortController();
	const reason = new Error("cancelled");
	const timing = startLlmTiming("SAAA", messages, window, undefined, () => {});
	const body = new ReadableStream<Uint8Array>({
		start(stream) {
			stream.enqueue(
				new TextEncoder().encode(
					'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
				),
			);
			queueMicrotask(() => controller.abort(reason));
		},
	});
	const thrown = await timing
		.read(
			new Response(body, { headers: { "content-type": "text/event-stream" } }),
			controller.signal,
		)
		.catch((error) => error);
	expect(thrown).toBe(reason);
	expect(timings(lines)[0]).toMatchObject({ outcome: "aborted" });
});

test("a logging failure never replaces the inference result or error", async () => {
	capture();
	const logger = getLogger("larm");
	const warn = spyOn(logger, "warn").mockImplementation(() => {
		throw new Error("log_broken");
	});
	const info = spyOn(logger, "info").mockImplementation(() => {
		throw new Error("log_broken");
	});
	try {
		const ok = startLlmTiming("SAAA", messages, window, undefined, undefined);
		expect(
			(
				await ok.read(
					sse('{"choices":[{"delta":{"content":"fine"}}]}', "[DONE]"),
					new AbortController().signal,
				)
			).text,
		).toBe("fine");
		const bad = startLlmTiming("SAAA", messages, window, undefined, undefined);
		const error = await bad
			.read(sse("[DONE]"), new AbortController().signal)
			.catch((e) => e);
		expect((error as Error).message).toBe("chat_stream_incomplete");
	} finally {
		warn.mockRestore();
		info.mockRestore();
	}
});
