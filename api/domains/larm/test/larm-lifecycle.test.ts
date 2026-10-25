import { expect, jest, spyOn, test } from "bun:test";
import {
	result,
	fixture,
	lifecycleFixture,
	idleMessage,
	idleReleased,
	question,
	freshSignal,
	makeLarm,
	driveFakeTimers,
} from "./larm.fixture";
test("idle-released JSON before SSE recreates and claims once; both exchanges survive", async () => {
	const fake = lifecycleFixture();
	let calls = 0;
	const larm = makeLarm(async (input, init) => {
		if (String(input).endsWith("chat/completions")) {
			if (!calls++) return idleReleased();
			return new Response(
				'data: {"choices":[{"delta":{"content":"承知"}}]}\n\ndata: {"choices":[{"delta":{"content":"しました"}}]}\n\ndata: [DONE]\n\n',
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		}
		return fake.fetcher(input, init);
	});
	const exchanges: import("..").LarmExchange[] = [];
	const deltas: string[] = [];
	try {
		expect(
			await larm.answerStream!(question, freshSignal(), (x) => deltas.push(x), {
				onExchange: async (x) => {
					exchanges.push(x);
				},
			}),
		).toBe("承知しました");
		expect(deltas).toEqual(["承知", "しました"]);
		expect(exchanges).toMatchObject([
			{
				connectionId: "connection1",
				httpStatus: 409,
				errorCode: "connection_idle_released",
				errorMessage: idleMessage,
			},
			{ connectionId: "connection2", httpStatus: 200 },
		]);
		expect(fake.generation()).toBe(2);
		expect(larm.inspect?.().connectionId).toBe("connection2");
	} finally {
		await larm.close();
	}
});
test("local idle expires a still-valid lease without requests; next voice use requests the profile again", async () => {
	jest.useFakeTimers();
	const fake = lifecycleFixture();
	const larm = makeLarm(fake.fetcher, 35);
	try {
		await larm.prepareVoice!(freshSignal());
		const count = fake.calls.length;
		jest.advanceTimersByTime(55);
		expect(larm.status()).toMatchObject({ state: "idle", capabilities: [] });
		expect(larm.inspect?.().connectionId).toBeUndefined();
		expect(fake.calls).toHaveLength(count);
		expect(await larm.transcribe(new Uint8Array(44), freshSignal())).toBe(
			"こんにちは",
		);
		expect(larm.inspect?.().connectionId).toBe("connection2");
		expect(fake.requests[1]).toMatchObject({
			profile: "test-profile",
		});
	} finally {
		jest.useRealTimers();
		await larm.close();
	}
});
test("an active inference pauses the local idle timer and completion starts a new idle interval", async () => {
	jest.useFakeTimers();
	const fake = lifecycleFixture();
	let ready: () => void = () => {};
	const entered = new Promise<void>((resolve) => {
		ready = resolve;
	});
	let complete: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		complete = resolve;
	});
	const larm = makeLarm(async (input, init) => {
		if (String(input).endsWith("chat/completions")) {
			ready();
			await gate;
		}
		return fake.fetcher(input, init);
	}, 40);
	try {
		const work = larm.answer(question, freshSignal());
		await entered;
		jest.advanceTimersByTime(65);
		expect(larm.status().state).toBe("ready");
		complete();
		await work;
		expect(larm.status().state).toBe("ready");
		jest.advanceTimersByTime(60);
		expect(larm.status().state).toBe("idle");
	} finally {
		jest.useRealTimers();
		complete();
		await larm.close();
	}
});
test("only the explicit idle-released 409 can replay, and recovery is bounded at one replacement", async () => {
	for (const [status, body, calls] of [
		[409, { error: { code: "connection_idle_released" } }, 2],
		[409, { error: { code: "capacity_exceeded" } }, 1],
		[409, { error: { message: "conflict" } }, 1],
		[401, { error: { code: "connection_idle_released" } }, 1],
	] as const) {
		const fake = lifecycleFixture();
		let inferred = 0;
		const larm = makeLarm(async (input, init) => {
			if (String(input).endsWith("chat/completions")) {
				inferred++;
				return result(body, status);
			}
			return fake.fetcher(input, init);
		});
		try {
			await expect(larm.answer(question, freshSignal())).rejects.toThrow(
				`larm_inference_${status}`,
			);
			expect(inferred).toBe(calls);
			expect(fake.generation()).toBe(calls);
		} finally {
			await larm.close();
		}
	}
});
test("cancellation after the 409 diagnostic prevents replacement and replay", async () => {
	const fake = lifecycleFixture();
	const controller = new AbortController();
	const larm = makeLarm(async (input, init) =>
		String(input).endsWith("chat/completions")
			? idleReleased()
			: fake.fetcher(input, init),
	);
	try {
		await expect(
			larm.answer(question, controller.signal, {
				onExchange: async () => {
					controller.abort();
				},
			}),
		).rejects.toThrow();
		expect(fake.generation()).toBe(1);
	} finally {
		await larm.close();
	}
});
test("manual connection check follows released state even with unexpired credentials", async () => {
	const fake = lifecycleFixture();
	let released = false;
	const larm = makeLarm(async (input, init) => {
		if (
			released &&
			new URL(String(input)).pathname === "/v1/agent-connections/connection1" &&
			init?.method === "GET"
		)
			return result({
				id: "connection1",
				status: "released",
				releaseReason: "foreground_idle_timeout",
			});
		return fake.fetcher(input, init);
	});
	try {
		await larm.connect();
		released = true;
		await larm.connect();
		expect(fake.generation()).toBe(2);
		expect(larm.status().state).toBe("ready");
	} finally {
		await larm.close();
	}
});
test("renew rotates the selected voice provider while leaving the idle deadline unchanged", async () => {
	jest.useFakeTimers();
	const fake = lifecycleFixture(60000);
	const tokens: string[] = [];
	const larm = makeLarm(async (input, init) => {
		if (/\/(llm|asr|tts)\/v1\//.test(String(input)))
			tokens.push(new Headers(init?.headers).get("Authorization")!);
		return fake.fetcher(input, init);
	}, 120);
	try {
		await larm.prepareVoice!(freshSignal());
		await larm.transcribe(new Uint8Array(44), freshSignal());
		await larm.speak("確認", freshSignal());
		expect(tokens).toEqual(["Bearer secret-asr-2", "Bearer secret-tts-2"]);
		const before = fake.calls.length;
		jest.advanceTimersByTime(70);
		await larm.prepareVoice!(freshSignal());
		jest.advanceTimersByTime(70);
		expect(larm.status().state).toBe("idle");
		expect(fake.calls.length).toBe(before); // valid ASR claim needs no renewal and does not extend idle time
	} finally {
		jest.useRealTimers();
		await larm.close();
	}
});
test("published SSE prefix errors never reconnect or replay inference", async () => {
	const fake = lifecycleFixture();
	const larm = makeLarm(async (input, init) =>
		String(input).endsWith("chat/completions")
			? new Response('data: {"choices":[{"delta":{"content":"回答"}}]}\n\n', {
					headers: { "Content-Type": "text/event-stream" },
				})
			: fake.fetcher(input, init),
	);
	const deltas: string[] = [];
	try {
		await expect(
			larm.answerStream!(question, freshSignal(), (x) => deltas.push(x)),
		).rejects.toThrow();
		expect(deltas).toEqual(["回答"]);
		expect(fake.generation()).toBe(1);
	} finally {
		await larm.close();
	}
});
test("idle expiry during a health check cannot revive the released local lease", async () => {
	jest.useFakeTimers();
	const fake = lifecycleFixture();
	let checking = false;
	const larm = makeLarm(async (input, init) => {
		if (
			checking &&
			new URL(String(input)).pathname === "/v1/agent-connections/connection1" &&
			init?.method === "GET"
		)
			jest.advanceTimersByTime(65); // the check outlives the idle deadline
		return fake.fetcher(input, init);
	}, 40);
	try {
		await larm.connect();
		checking = true;
		await larm.connect();
		expect(larm.inspect?.().connectionId).toBe("connection2");
		expect(larm.status().state).toBe("ready");
	} finally {
		jest.useRealTimers();
		await larm.close();
	}
});
test("invalid ASR reclaim after rotation is rejected and TTS can reclaim independently", async () => {
	const fake = lifecycleFixture(60000);
	let claims = 0,
		inferred = 0;
	const larm = makeLarm(async (input, init) => {
		if (/\/(llm|asr|tts)\/v1\//.test(String(input))) inferred++;
		const response = await fake.fetcher(input, init);
		if (String(input).endsWith("/claim") && ++claims === 2) {
			const body = (await response.json()) as {
				providers: Array<{ name: string; model: string }>;
			};
			body.providers.find((p) => p.name === "asr")!.model = "wrong-model";
			return result(body);
		}
		return response;
	});
	try {
		await larm.prepareVoice!(freshSignal());
		await expect(
			larm.transcribe(new Uint8Array(44), freshSignal()),
		).rejects.toThrow("larm_claim_mismatch");
		expect(larm.inspect?.().providers).toEqual([]);
		expect(inferred).toBe(0);
		expect(await larm.transcribe(new Uint8Array(44), freshSignal())).toBe(
			"こんにちは",
		);
		expect(larm.inspect?.().connectionId).toBe("connection1");
		expect((await larm.speak("確認", freshSignal())).length).toBe(44);
		expect(fake.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
	} finally {
		await larm.close();
	}
});
test("a ready connection waits for requested providers to become claimable before claim", async () => {
	jest.useFakeTimers();
	const fake = lifecycleFixture();
	let checks = 0;
	const larm = makeLarm(async (input, init) => {
		const response = await fake.fetcher(input, init);
		if (
			new URL(String(input)).pathname === "/v1/agent-connections" &&
			init?.method === "POST"
		) {
			const body = (await response.json()) as {
				providers: Array<{ readiness: string; claimable: boolean }>;
			};
			for (const p of body.providers) {
				p.readiness = "warming";
				p.claimable = false;
			}
			return result(body, 201);
		}
		if (
			new URL(String(input)).pathname === "/v1/agent-connections/connection1" &&
			init?.method === "GET"
		)
			checks++;
		return response;
	});
	try {
		await driveFakeTimers(larm.connect(), 1000);
		expect(checks).toBe(1);
		expect(larm.status().state).toBe("ready");
		expect(fake.calls.filter((c) => c.endsWith("/claim"))).toHaveLength(1);
	} finally {
		jest.useRealTimers();
		await larm.close();
	}
});
test("unauthorized can recover only when control confirms the old connection is released", async () => {
	for (const state of ["ready", "released"]) {
		const fake = lifecycleFixture();
		let inferred = 0,
			checks = 0;
		const larm = makeLarm(async (input, init) => {
			const path = new URL(String(input)).pathname;
			if (
				path === "/v1/agent-connections/connection1" &&
				init?.method === "GET"
			) {
				checks++;
				if (state === "released")
					return result({ id: "connection1", status: "released" });
			}
			if (String(input).endsWith("chat/completions") && ++inferred === 1)
				return result(
					{
						error: {
							code: "unauthorized",
							message: "provider bearer token is no longer valid",
						},
					},
					401,
				);
			return fake.fetcher(input, init);
		});
		try {
			if (state === "released") {
				expect(await larm.answer(question, freshSignal())).toBe("承知しました");
				expect(fake.generation()).toBe(2);
			} else {
				await expect(larm.answer(question, freshSignal())).rejects.toThrow(
					"larm_inference_401",
				);
				expect(fake.generation()).toBe(1);
			}
			expect(checks).toBe(1);
		} finally {
			await larm.close();
		}
	}
});
// RT-11: control timeouts, idempotency, caller abort, close, renewal.
test("control POSTs keep the 15 s budget while status GETs with a caller signal use 3 s", async () => {
	const fake = fixture();
	const timeouts: number[] = [];
	const spy = spyOn(AbortSignal, "timeout");
	const seen: Array<[string, string, number | undefined]> = [];
	const larm = makeLarm(async (input, init) => {
		const timeout = spy.mock.calls.at(-1)?.[0];
		timeouts.push(Number(timeout));
		seen.push([
			init?.method ?? "GET",
			new URL(String(input)).pathname,
			timeout,
		]);
		return fake.fetcher(input, init);
	});
	try {
		await larm.probe!(freshSignal());
		const timeoutOf = (method: string, path: string) =>
			seen.find(([m, p]) => m === method && p === path)?.[2];
		expect(timeoutOf("POST", "/v1/agent-connections")).toBe(15_000);
		expect(timeoutOf("POST", "/v1/agent-connections/connection1/claim")).toBe(
			15_000,
		);
		expect(timeoutOf("GET", "/v3/agent-profiles")).toBe(3_000);
	} finally {
		spy.mockRestore();
		await larm.close();
	}
});
test("a timed-out connection POST is retried with the same Idempotency-Key", async () => {
	const fake = fixture();
	const keys: Array<string | null> = [];
	let failed = false;
	const larm = makeLarm(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/v1/agent-connections" && init?.method === "POST") {
			keys.push(new Headers(init.headers).get("Idempotency-Key"));
			if (!failed) {
				failed = true;
				throw new DOMException("timed out", "TimeoutError");
			}
		}
		return fake.fetcher(input, init);
	});
	try {
		await larm.connect();
		expect(keys).toHaveLength(2);
		expect(keys[0]).toBeTruthy();
		expect(keys[1]).toBe(keys[0]);
		expect(larm.status().state).toBe("ready");
	} finally {
		await larm.close();
	}
});
test("a caller abort during renewal neither fails the status nor releases the shared lease", async () => {
	const fake = fixture(false, "test-profile", 185_000);
	const controller = new AbortController();
	let skew = 0;
	const realNow = Date.now.bind(Date);
	const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew);
	const larm = makeLarm(async (input, init) => {
		if (new URL(String(input)).pathname.endsWith("/renew")) {
			controller.abort();
			throw controller.signal.reason;
		}
		return fake.fetcher(input, init);
	});
	try {
		await larm.probe!(freshSignal());
		// Move past the 180 s renewal margin without waiting; the renew timer is real.
		skew = 20_000;
		await expect(larm.probe!(controller.signal)).rejects.toThrow();
		expect(larm.status()).toEqual({ state: "ready", capabilities: ["llm"] });
		expect(larm.inspect?.().connectionId).toBe("connection1");
		expect(fake.calls.some((call) => call.startsWith("DELETE"))).toBe(false);
	} finally {
		clock.mockRestore();
		await larm.close();
	}
});
test("close waits for in-use leases before sending DELETE", async () => {
	jest.useFakeTimers();
	const fake = fixture();
	const order: string[] = [];
	let entered: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let complete: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		complete = resolve;
	});
	const larm = makeLarm(async (input, init) => {
		if (init?.method === "DELETE") order.push("delete");
		if (String(input).endsWith("audio/transcriptions")) {
			entered();
			await gate;
		}
		return fake.fetcher(input, init);
	});
	const work = larm
		.transcribe(new Uint8Array(44), freshSignal())
		.then((text) => {
			order.push("transcribed");
			return text;
		});
	await started;
	const closing = larm.close();
	for (let i = 0; i < 25; i++)
		await new Promise((resolve) => setImmediate(resolve));
	expect(order).toEqual([]);
	complete();
	try {
		expect(await work).toBe("こんにちは");
		await driveFakeTimers(closing, 100);
		expect(order).toEqual(["transcribed", "delete"]);
	} finally {
		jest.useRealTimers();
	}
});
test("a valid lease serves new inference while a renewal is still waiting", async () => {
	const fake = fixture(false, "test-profile", 120_000);
	let renewing: () => void = () => {};
	const renewStarted = new Promise<void>((resolve) => {
		renewing = resolve;
	});
	let finishRenewal: () => void = () => {};
	const renewGate = new Promise<void>((resolve) => {
		finishRenewal = resolve;
	});
	const larm = makeLarm(async (input, init) => {
		if (new URL(String(input)).pathname.endsWith("/renew")) {
			renewing();
			await renewGate;
		}
		return fake.fetcher(input, init);
	});
	try {
		await larm.probe!(freshSignal());
		await renewStarted;
		expect(larm.status().state).toBe("connecting");
		// a blocked answer hangs here and fails through the test timeout
		expect(await larm.answer(question, freshSignal())).toBe("承知しました");
	} finally {
		finishRenewal();
		await larm.close();
	}
});
