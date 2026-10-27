import { expect, test } from "bun:test";
import { sseFrame, sseStream, type SseSink } from "./sse";

const decoder = new TextDecoder();
async function readAll(stream: ReadableStream<Uint8Array>) {
	let text = "";
	for await (const chunk of stream) text += decoder.decode(chunk);
	return text;
}

test("frames name only the fields they are given", () => {
	expect(sseFrame({ data: "{}" })).toBe("data: {}\n\n");
	expect(sseFrame({ id: "s:1", event: "change", data: "{}" })).toBe(
		"id: s:1\nevent: change\ndata: {}\n\n",
	);
});

test("disconnect: a client that cannot keep up loses its stream, but a last frame is still queued", async () => {
	let sink!: SseSink;
	let unsubscribed = 0;
	const stream = sseStream({
		signal: new AbortController().signal,
		highWaterMark: 2,
		lagging: "disconnect",
		open(s) {
			sink = s;
			return () => unsubscribed++;
		},
	});
	sink.send("data: 1\n\n");
	sink.send("data: 2\n\n");
	// The queue is full and nobody reads: the next frame ends the stream instead of growing it.
	sink.send("data: 3\n\n");
	expect(unsubscribed).toBe(1);
	expect(await readAll(stream)).toBe("data: 1\n\ndata: 2\n\n");

	const ended = sseStream({
		signal: new AbortController().signal,
		highWaterMark: 1,
		lagging: "disconnect",
		open(s) {
			s.send("data: a\n\n");
			s.end("event: exit\ndata: {}\n\n");
		},
	});
	expect(await readAll(ended)).toBe("data: a\n\nevent: exit\ndata: {}\n\n");
});

test("latest: only the newest frame waits for the reader, and the last one ends the stream", async () => {
	let sink!: SseSink;
	const stream = sseStream({
		signal: new AbortController().signal,
		highWaterMark: 1,
		lagging: "latest",
		open(s) {
			sink = s;
		},
	});
	sink.send("data: 1\n\n");
	sink.send("data: 2\n\n");
	sink.send("data: 3\n\n");
	sink.end("data: done\n\n");
	expect(await readAll(stream)).toBe("data: 1\n\ndata: done\n\n");
});

test("abort ends the stream and unsubscribes once; a failing subscription errors it", async () => {
	const abort = new AbortController();
	let unsubscribed = 0;
	const stream = sseStream({
		signal: abort.signal,
		highWaterMark: 4,
		lagging: "disconnect",
		open: () => () => unsubscribed++,
	});
	abort.abort();
	abort.abort();
	expect(await readAll(stream)).toBe("");
	expect(unsubscribed).toBe(1);

	const failing = sseStream({
		signal: new AbortController().signal,
		highWaterMark: 4,
		lagging: "latest",
		open() {
			throw new Error("subscribe_failed");
		},
	});
	await expect(readAll(failing)).rejects.toThrow("subscribe_failed");
});

test("a subscription that ends the stream while subscribing is still released", async () => {
	let unsubscribed = 0;
	const stream = sseStream({
		signal: new AbortController().signal,
		highWaterMark: 4,
		lagging: "latest",
		open(s) {
			s.end("data: final\n\n");
			return () => unsubscribed++;
		},
	});
	expect(await readAll(stream)).toBe("data: final\n\n");
	expect(unsubscribed).toBe(1);
});

test("heartbeats keep a quiet stream alive", async () => {
	const abort = new AbortController();
	const stream = sseStream({
		signal: abort.signal,
		highWaterMark: 8,
		lagging: "disconnect",
		heartbeatMs: 5,
		open: () => {},
	});
	const reader = stream.getReader();
	const { value } = await reader.read();
	expect(decoder.decode(value)).toBe(": heartbeat\n\n");
	abort.abort();
	reader.releaseLock();
});
