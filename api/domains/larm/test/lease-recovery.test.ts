import { expect, test } from "bun:test";
import {
	lifecycleFixture,
	makeLarm,
	question,
	freshSignal,
} from "./larm.fixture";
import { waitFor } from "../../../infrastructure/wait-for";

for (const cleanup of [
	"normal",
	"retry",
	"cancel-error",
	"cancel-pending",
] as const)
	test(`a terminal lease coalesces cleanup while draining: ${cleanup}`, async () => {
		const fake = lifecycleFixture();
		const gate = Promise.withResolvers<void>();
		const cancelGate = Promise.withResolvers<void>();
		const deleted: string[] = [];
		let gone = false,
			running = false;
		const port = makeLarm(async (url, init) => {
			if (init?.method === "DELETE") {
				deleted.push(new URL(String(url)).pathname);
				if (String(url).endsWith("/connection1")) {
					if (cleanup === "retry" && deleted.length === 1)
						return new Response(null, { status: 503 });
					if (cleanup === "cancel-error")
						return new Response(
							new ReadableStream({
								cancel() {
									throw new Error("body-cancel");
								},
							}),
						);
					if (cleanup === "cancel-pending")
						return new Response(
							new ReadableStream({ cancel: () => cancelGate.promise }),
						);
				}
			}
			if (
				gone &&
				init?.method === "GET" &&
				String(url).endsWith("/connection1")
			)
				return new Response(null, { status: 410 });
			if (String(url).endsWith("chat/completions") && !gone) {
				running = true;
				await gate.promise;
			}
			return fake.fetcher(url, init);
		});
		try {
			const active = port.answer(question, freshSignal());
			await waitFor(() => running);
			gone = true;
			const reconnect = port.connect();
			await waitFor(() => port.inspect?.().connectionId === undefined);
			expect(port.status().state).toBe("connecting");
			const waiter = port.connect();
			gate.resolve();
			await waitFor(() => fake.generation() === 2);
			await Promise.all([active, reconnect, waiter]);
			expect(fake.generation()).toBe(2);
			expect(port.inspect?.().connectionId).toBe("connection2");
			expect(
				deleted.filter((path) => path.endsWith("/connection1")),
			).toHaveLength(cleanup === "retry" ? 2 : 1);
		} finally {
			cancelGate.resolve();
			gate.resolve();
			await port.close();
		}
	});

for (const status of [401, 403, 500])
	test(`connection GET ${status} is not a terminal lease and does not create another connection`, async () => {
		const fake = lifecycleFixture();
		let reject = false;
		const port = makeLarm(async (url, init) =>
			reject && init?.method === "GET" && String(url).endsWith("/connection1")
				? new Response(null, { status })
				: fake.fetcher(url, init),
		);
		try {
			await port.connect();
			reject = true;
			await expect(port.connect()).rejects.toThrow(`larm_control_${status}`);
			expect(fake.generation()).toBe(1);
		} finally {
			await port.close();
		}
	});

test("failed replacement after GET 410 leaves no ready old lease and later recovers", async () => {
	const fake = lifecycleFixture();
	let gone = false,
		failCreation = true;
	const port = makeLarm(async (url, init) => {
		if (gone && init?.method === "GET" && String(url).endsWith("/connection1"))
			return new Response(null, { status: 410 });
		if (
			gone &&
			failCreation &&
			init?.method === "POST" &&
			String(url).endsWith("/agent-connections")
		)
			return new Response(null, { status: 503 });
		return fake.fetcher(url, init);
	});
	try {
		await port.connect();
		gone = true;
		await expect(port.connect()).rejects.toThrow("larm_control_503");
		expect(port.status().state).toBe("failed");
		expect(port.inspect?.().connectionId).toBeUndefined();
		failCreation = false;
		await port.connect();
		expect(port.inspect?.().connectionId).toBe("connection2");
		expect(await port.answer(question, freshSignal())).toBe("承知しました");
	} finally {
		await port.close();
	}
});

for (const end of ["cancel", "close"] as const)
	test(`a ${end} during voice acquisition leaves the primary scope independent`, async () => {
		const fake = lifecycleFixture();
		let gone = false;
		const entered = Promise.withResolvers<void>(),
			resume = Promise.withResolvers<void>();
		const deleted: string[] = [];
		const port = makeLarm(async (url, init) => {
			if (
				gone &&
				init?.method === "GET" &&
				String(url).endsWith("/connection1")
			)
				return new Response(null, { status: 410 });
			if (
				gone &&
				init?.method === "POST" &&
				String(url).endsWith("/agent-connections")
			) {
				entered.resolve();
				await resume.promise;
			}
			if (init?.method === "DELETE")
				deleted.push(new URL(String(url)).pathname);
			return fake.fetcher(url, init);
		});
		try {
			await port.connect();
			gone = true;
			const controller = new AbortController();
			const connecting = port.prepareVoice!(controller.signal);
			const rejection = connecting.catch((error: unknown) => error);
			await entered.promise;
			const closing = end === "close" ? port.close() : undefined;
			if (end === "cancel") controller.abort();
			resume.resolve();
			expect(await rejection).toBeInstanceOf(Error);
			await closing;
			if (end === "cancel") {
				expect(port.inspect?.().connectionId).toBe("connection1");
				expect(deleted).not.toContain("/v1/agent-connections/connection1");
				await port.close();
			} else expect(port.inspect?.().connectionId).toBeUndefined();
			expect(deleted).toContain("/v1/agent-connections/connection2");
		} finally {
			resume.resolve();
			await port.close();
		}
	});

test("a provider 410 is not replayed as a connection-state rejection", async () => {
	const fake = lifecycleFixture();
	let inferences = 0;
	const port = makeLarm(async (url, init) => {
		if (String(url).endsWith("chat/completions")) {
			inferences++;
			return new Response(null, { status: 410 });
		}
		return fake.fetcher(url, init);
	});
	try {
		await expect(port.answer(question, freshSignal())).rejects.toThrow();
		expect(inferences).toBe(1);
		expect(fake.generation()).toBe(1);
	} finally {
		await port.close();
	}
});
