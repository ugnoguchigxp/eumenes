import { expect, test } from "bun:test";
import { eventsClient } from "../../client/events";
import { ApiError, type Transport } from "../../client/transport";

async function until(predicate: () => boolean) {
	for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(1);
	expect(predicate()).toBe(true);
}
function fixture() {
	const requests: RequestInit[] = [];
	const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
	let cancelled = 0;
	const transport: Transport = {
		identity: "http://127.0.0.1",
		async call(_path, init = {}) {
			requests.push(init);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						streams.push(controller);
					},
					cancel() {
						cancelled++;
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	};
	return {
		transport,
		requests,
		streams,
		cancelled: () => cancelled,
		send(index: number, value: string) {
			streams[index]!.enqueue(new TextEncoder().encode(value));
		},
	};
}

test("two listeners share one authenticated transport, fragmented frames and last unsubscribe cleans up", async () => {
	const f = fixture();
	const client = eventsClient(f.transport, { retryMs: 5 });
	let a = 0,
		b = 0;
	const stopA = client.subscribeChanges(() => {
		a++;
	});
	const stopB = client.subscribeChanges(() => {
		b++;
	});
	try {
		await until(() => f.requests.length === 1);
		expect(new Headers(f.requests[0]!.headers).get("accept")).toBe(
			"text/event-stream",
		);
		f.send(0, ": heartbeat\r\n\r\nid: session:0\r\nevent: re");
		f.send(0, "set\r\ndata: {}\r\n\r");
		f.send(0, "\n");
		await until(() => a === 1 && b === 1);
		stopA();
		f.send(0, "id: session:1\nevent: change\ndata: {}\n\n");
		await until(() => b === 2);
		expect(a).toBe(1);
		expect(f.cancelled()).toBe(0);
	} finally {
		stopA();
		stopB();
	}
	await until(() => f.cancelled() === 1);
	await Bun.sleep(20);
	expect(f.requests).toHaveLength(1);
});

test("reconnect carries a cursor and reset refreshes changes missed while disconnected", async () => {
	const f = fixture();
	const client = eventsClient(f.transport, { retryMs: 5 });
	let persisted = "before",
		observed = "";
	const stop = client.subscribeChanges(() => {
		observed = persisted;
	});
	try {
		f.send(0, "id: old:1\nevent: reset\ndata: {}\n\n");
		await until(() => observed === "before");
		f.streams[0]!.close();
		await until(() => f.requests.length === 2);
		expect(new Headers(f.requests[1]!.headers).get("last-event-id")).toBe(
			"old:1",
		);
		persisted = "changed offline";
		f.send(1, "id: new:0\nevent: reset\ndata: {}\n\n");
		await until(() => observed === "changed offline");
	} finally {
		stop();
	}
});

test("a half-open stream reconnects; heartbeat comments do not invalidate snapshots", async () => {
	const f = fixture();
	const client = eventsClient(f.transport, { retryMs: 5, idleMs: 10 });
	let notifications = 0;
	const stop = client.subscribeChanges(() => {
		notifications++;
	});
	try {
		f.send(0, ": heartbeat\n\n");
		await Bun.sleep(2);
		expect(notifications).toBe(0);
		await until(() => f.requests.length === 2);
		expect(f.cancelled()).toBe(1);
		f.send(1, "event: reset\ndata: {}\n\n");
		await until(() => notifications === 2);
	} finally {
		stop();
	}
});

test("401, 403 and 404 stop automatic reconnect", async () => {
	for (const status of [401, 403, 404]) {
		let calls = 0;
		const client = eventsClient(
			{
				identity: "http://127.0.0.1",
				call: async () => {
					calls++;
					throw new ApiError(status, "unavailable");
				},
			},
			{ retryMs: 1 },
		);
		const stop = client.subscribeChanges(() => {});
		await Bun.sleep(15);
		stop();
		expect(calls).toBe(1);
	}
});

test("explicit reconnect repairs a stopped stream without changing mounted listeners", async () => {
	const f = fixture();
	let unavailable = true;
	let calls = 0;
	const client = eventsClient(
		{
			...f.transport,
			call: async (path, init) => {
				calls++;
				if (unavailable) throw new ApiError(401, "unauthorized");
				return f.transport.call(path, init);
			},
		},
		{ retryMs: 1 },
	);
	let updates = 0;
	const stop = client.subscribeChanges(() => {
		updates++;
	});
	try {
		await Bun.sleep(15);
		expect(calls).toBe(1);
		unavailable = false;
		client.reconnectChanges();
		await until(() => f.streams.length === 1);
		f.send(0, "event: reset\ndata: {}\n\n");
		await until(() => updates === 1);
		expect(calls).toBe(2);
	} finally {
		stop();
	}
});

test("update transport failure is observable even when other API reads still succeed", async () => {
	const f = fixture();
	let failed = true;
	const client = eventsClient({
		...f.transport,
		call: async (path, init) => {
			if (failed) throw new ApiError(404, "not_found");
			return f.transport.call(path, init);
		},
	});
	const states: string[] = [];
	const stopState = client.subscribeChangesState(() =>
		states.push(client.changesState()),
	);
	const stop = client.subscribeChanges(() => {});
	try {
		await until(() => client.changesState() === "failed");
		expect(states).toEqual(["connecting", "failed"]);
		failed = false;
		client.reconnectChanges();
		f.send(0, "event: reset\ndata: {}\n\n");
		await until(() => client.changesState() === "connected");
		expect(states.at(-1)).toBe("connected");
	} finally {
		stop();
		stopState();
	}
});

test("reconnectChanges is a no-op while connected unless forced", async () => {
	const f = fixture();
	const client = eventsClient(f.transport, { retryMs: 5 });
	const stop = client.subscribeChanges(() => {});
	try {
		f.send(0, "id: s:1\nevent: reset\ndata: {}\n\n");
		await until(() => client.changesState() === "connected");
		client.reconnectChanges();
		await Bun.sleep(10);
		expect(f.requests.length).toBe(1);
		client.reconnectChanges({ force: true });
		await until(() => f.requests.length === 2);
	} finally {
		stop();
	}
});

test("a resumed frame establishes the connection without invalidating and keeps the cursor", async () => {
	const f = fixture();
	const client = eventsClient(f.transport, { retryMs: 5 });
	let notified = 0;
	const stop = client.subscribeChanges(() => {
		notified++;
	});
	try {
		f.send(0, "id: s:3\nevent: resumed\ndata: {}\n\n");
		await until(() => client.changesState() === "connected");
		expect(notified).toBe(0);
		client.reconnectChanges({ force: true });
		await until(() => f.requests.length === 2);
		expect(new Headers(f.requests[1]!.headers).get("last-event-id")).toBe(
			"s:3",
		);
		expect(notified).toBe(0);
	} finally {
		stop();
	}
});
