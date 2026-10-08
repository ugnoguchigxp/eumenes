import { expect, test, vi } from "vitest";
import { eventsClient } from "../../client/events";
test("a synchronous remount shares the existing stream and final unsubscribe releases it", async () => {
	let cancelled = 0;
	const call = vi.fn(
		async () =>
			new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(new TextEncoder().encode("event: reset\ndata: {}\n\n"));
					},
					cancel() {
						cancelled++;
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			),
	);
	const client = eventsClient({ identity: "http://127.0.0.1", call });
	const first = client.subscribeChanges(() => {});
	first();
	const second = client.subscribeChanges(() => {});
	await Promise.resolve();
	await Promise.resolve();
	expect(call).toHaveBeenCalledTimes(1);
	second();
	for (let i = 0; i < 5; i++) await Promise.resolve();
	expect(cancelled).toBe(1);
});
