import { expect, test } from "bun:test";
import { createChanges } from "./events";
const text = (bytes?: Uint8Array) => new TextDecoder().decode(bytes);

test("SSE coalesces changes, resnapshots every connection and releases disconnected clients", async () => {
	const changes = createChanges({ debounceMs: 1, maxClients: 1 });
	const controller = new AbortController();
	const response = changes.open(controller.signal);
	const reader = response.body!.getReader();
	try {
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const reset = text((await reader.read()).value);
		expect(reset).toContain("event: reset\ndata: {}\n\n");
		expect(changes.open(new AbortController().signal).status).toBe(503);
		changes.publish();
		changes.publish();
		changes.publish();
		const update = text((await reader.read()).value);
		expect(update).toContain("event: change\ndata: {}\n\n");
		expect(update.split("\n")[0]).toBe(
			reset.split("\n")[0]?.replace(/:0$/, ":1"),
		);
		controller.abort();
		expect((await reader.read()).done).toBe(true);
		const reconnected = changes.open(new AbortController().signal);
		const next = reconnected.body!.getReader();
		expect(text((await next.read()).value)).toContain("event: reset");
		await next.cancel();
		expect(changes.open(new AbortController().signal).status).toBe(200);
	} finally {
		changes.close();
	}
});

test("heartbeat keeps SSE alive without a state invalidation and shutdown ends reads", async () => {
	const changes = createChanges({ heartbeatMs: 5 });
	const reader = changes.open(new AbortController().signal).body!.getReader();
	await reader.read();
	expect(text((await reader.read()).value)).toBe(": heartbeat\n\n");
	const waiting = reader.read();
	changes.close();
	expect((await waiting).done).toBe(true);
	expect(changes.open(new AbortController().signal).status).toBe(503);
});

test("a slow reader is disconnected with a bounded buffer", async () => {
	const changes = createChanges({ heartbeatMs: 1 });
	const reader = changes.open(new AbortController().signal).body!.getReader();
	try {
		await Bun.sleep(50);
		let frames = 0;
		while (!(await reader.read()).done) frames++;
		expect(frames).toBeLessThanOrEqual(16);
	} finally {
		changes.close();
	}
});

const firstFrame = async (response: Response) => {
	const reader = response.body!.getReader();
	const value = text((await reader.read()).value);
	await reader.cancel();
	return value;
};

test("Last-Event-ID of the latest revision resumes without a reset; stale or foreign ids reset", async () => {
	const changes = createChanges({ debounceMs: 1 });
	try {
		const first = await firstFrame(changes.open(new AbortController().signal));
		const id = first.split("\n")[0]!;
		const cursor = id.slice("id: ".length);
		const resumed = await firstFrame(
			changes.open(new AbortController().signal, cursor),
		);
		expect(resumed).toBe(`${id}\nevent: resumed\ndata: {}\n\n`);
		expect(resumed).not.toContain("event: reset");

		const live = changes.open(new AbortController().signal);
		const liveReader = live.body!.getReader();
		await liveReader.read();
		changes.publish();
		await liveReader.read();
		await liveReader.cancel();

		expect(
			await firstFrame(changes.open(new AbortController().signal, cursor)),
		).toContain("event: reset");
		expect(
			await firstFrame(changes.open(new AbortController().signal, "other:0")),
		).toContain("event: reset");
	} finally {
		changes.close();
	}
});
