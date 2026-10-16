import { expect, test, vi } from "vitest";
import { eventsClient } from "../../client/events";
import { ApiError } from "../../client/transport";
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

function eventStream() {
	return new Response(
		new ReadableStream({
			start(c) {
				c.enqueue(new TextEncoder().encode("event: reset\ndata: {}\n\n"));
			},
		}),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}
const refused = (status: number) => new ApiError(status, `HTTP ${status}`);
async function settle() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

test("a missing endpoint is retried when the window regains focus, online or visible", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		let missing = true;
		const call = vi.fn(async () => {
			if (missing) throw refused(404);
			return eventStream();
		});
		const client = eventsClient({ identity: "http://127.0.0.1", call });
		const stop = client.subscribeChanges(() => {});
		await settle();
		expect(client.changesState()).toBe("failed");
		expect(call).toHaveBeenCalledTimes(1);
		// Still failing: the next focus tries once more and stays failed.
		window.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(100);
		await settle();
		expect(call).toHaveBeenCalledTimes(2);
		expect(client.changesState()).toBe("failed");
		missing = false;
		window.dispatchEvent(new Event("online"));
		await vi.advanceTimersByTimeAsync(100);
		await settle();
		expect(call).toHaveBeenCalledTimes(3);
		expect(client.changesState()).toBe("connected");
		// A live stream is never restarted by focus.
		window.dispatchEvent(new Event("focus"));
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(200);
		expect(call).toHaveBeenCalledTimes(3);
		stop();
	} finally {
		vi.useRealTimers();
	}
});

test.each([401, 403])(
	"a %i refusal stays failed on focus until reconnectChanges is called",
	async (status) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const call = vi.fn(async () => {
				throw refused(status);
			});
			const client = eventsClient({ identity: "http://127.0.0.1", call });
			const stop = client.subscribeChanges(() => {});
			await settle();
			expect(client.changesState()).toBe("failed");
			window.dispatchEvent(new Event("focus"));
			window.dispatchEvent(new Event("online"));
			await vi.advanceTimersByTimeAsync(300);
			await settle();
			expect(call).toHaveBeenCalledTimes(1);
			client.reconnectChanges();
			await settle();
			expect(call).toHaveBeenCalledTimes(2);
			stop();
		} finally {
			vi.useRealTimers();
		}
	},
);

test("the resume listeners are removed with the last subscriber", async () => {
	const add = vi.spyOn(window, "addEventListener");
	const remove = vi.spyOn(window, "removeEventListener");
	try {
		const client = eventsClient({
			identity: "http://127.0.0.1",
			call: async () => eventStream(),
		});
		const stop = client.subscribeChanges(() => {});
		expect(add).toHaveBeenCalledWith("focus", expect.any(Function));
		stop();
		await settle();
		expect(remove).toHaveBeenCalledWith("focus", expect.any(Function));
	} finally {
		add.mockRestore();
		remove.mockRestore();
	}
});
