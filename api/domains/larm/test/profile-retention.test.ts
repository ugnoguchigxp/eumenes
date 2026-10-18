import { expect, jest, test } from "bun:test";
import {
	fixture,
	freshSignal,
	makeLarm,
	question,
	result,
} from "./larm.fixture";

const flush = async () => {
	for (let i = 0; i < 15; i++)
		await new Promise((resolve) => setImmediate(resolve));
};

test("visible chat repeats the same Profile POST with fresh keys for six idle minutes and stops on leaving", async () => {
	jest.useFakeTimers();
	const fake = fixture();
	const bodies: unknown[] = [];
	const keys: string[] = [];
	const larm = makeLarm(async (input, init) => {
		if (
			new URL(String(input)).pathname === "/v1/agent-connections" &&
			init?.method === "POST"
		) {
			bodies.push(JSON.parse(String(init.body)));
			keys.push(new Headers(init.headers).get("Idempotency-Key")!);
		}
		return fake.fetcher(input, init);
	}, 300_000);
	try {
		larm.retain!(true);
		await flush();
		for (let i = 0; i < 12; i++) {
			jest.advanceTimersByTime(30_000);
			await flush();
		}
		expect(bodies).toHaveLength(13);
		expect(
			bodies.every(
				(body) => JSON.stringify(body) === JSON.stringify(bodies[0]),
			),
		).toBe(true);
		expect(new Set(keys).size).toBe(13);
		expect(larm.inspect!().connectionId).toBe("connection1");
		expect(larm.status().state).toBe("ready");
		expect(
			fake.calls.some(
				(call) =>
					call.includes("chat/completions") || call.includes("ownership"),
			),
		).toBe(false);
		expect(fake.calls.filter((call) => call.includes("/claim"))).toHaveLength(
			1,
		);
		larm.retain!(false);
		jest.advanceTimersByTime(1);
		await flush();
		expect(larm.status().state).toBe("idle");
		jest.advanceTimersByTime(90_000);
		await flush();
		expect(bodies).toHaveLength(13);
	} finally {
		await larm.close();
		jest.useRealTimers();
	}
});

test("voice Profile subset and initial catalog revision are preserved by repeated use", async () => {
	jest.useFakeTimers();
	const fake = fixture();
	const larm = makeLarm(fake.fetcher);
	try {
		await larm.prepareVoice!(freshSignal());
		larm.retain!(true);
		await flush();
		jest.advanceTimersByTime(30_000);
		await flush();
		expect(fake.requests).toHaveLength(3);
		expect(fake.requests[0]!.providers).toBeUndefined();
		expect(fake.requests[1]).toEqual(fake.requests[0]);
		expect(fake.requests[2]).toEqual(fake.requests[0]);
		expect(larm.status().capabilities).toEqual(["llm", "asr", "tts"]);
	} finally {
		await larm.close();
		jest.useRealTimers();
	}
});

test("a claimed Connection stays ready when the semantic probe cache expires between Profile requests", async () => {
	jest.useFakeTimers();
	const fake = fixture();
	let posts = 0;
	const larm = makeLarm(async (input, init) => {
		const response = await fake.fetcher(input, init);
		if (
			new URL(String(input)).pathname === "/v1/agent-connections" &&
			init?.method === "POST" &&
			posts++
		) {
			const value = await response.json();
			for (const provider of value.providers) provider.claimable = false;
			return result(value, response.status);
		}
		return response;
	}, 300_000);
	try {
		larm.retain!(true);
		await flush();
		jest.advanceTimersByTime(30_000);
		await flush();
		expect(larm.status().state).toBe("ready");
		expect(larm.inspect!().connectionId).toBe("connection1");
		expect(await larm.answer(question, freshSignal())).toBe("承知しました");
		expect(fake.calls.filter((call) => call.includes("/claim"))).toHaveLength(
			1,
		);
		expect(fake.calls.some((call) => call.includes("/health"))).toBe(false);
	} finally {
		await larm.close();
		jest.useRealTimers();
	}
});

test("fixed Control authentication and existing claimed providers keep working across the credential deadline", async () => {
	jest.useFakeTimers();
	const fake = fixture(false, "test-profile", 220_000);
	const larm = makeLarm(async (input, init) => {
		if (new URL(String(input)).pathname.startsWith("/v1/agent-connections"))
			expect(new Headers(init?.headers).get("Authorization")).toBe(
				"Bearer control",
			);
		return fake.fetcher(input, init);
	});
	try {
		larm.retain!(true);
		await flush();
		for (let i = 0; i < 3; i++) {
			jest.advanceTimersByTime(30_000);
			await flush();
		}
		expect(fake.calls.some((call) => call.includes("/renew"))).toBe(true);
		expect(await larm.answer(question, freshSignal())).toBe("承知しました");
		expect(
			fake.requests.every((value) => value.client === fake.requests[0]!.client),
		).toBe(true);
	} finally {
		await larm.close();
		jest.useRealTimers();
	}
});

test("a different Connection returned by a repeated request is released and never adopted as retention", async () => {
	jest.useFakeTimers();
	const fake = fixture();
	let posts = 0;
	let releasedReplacement = false;
	const larm = makeLarm(async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (
			path === "/v1/agent-connections/unexpected" &&
			init?.method === "DELETE"
		) {
			releasedReplacement = true;
			return new Response(null, { status: 204 });
		}
		const response = await fake.fetcher(input, init);
		if (path === "/v1/agent-connections" && posts++)
			return result(
				{ ...(await response.json()), id: "unexpected" },
				response.status,
			);
		return response;
	});
	try {
		larm.retain!(true);
		await flush();
		jest.advanceTimersByTime(30_000);
		await flush();
		expect(releasedReplacement).toBe(true);
		expect(larm.inspect!().connectionId).toBe("connection1");
		expect(larm.status()).toMatchObject({
			state: "failed",
			error: "larm_retention_connection_changed",
		});
	} finally {
		await larm.close();
		jest.useRealTimers();
	}
});

test("a failed periodic request reports failure and retries the same Profile on the next interval", async () => {
	jest.useFakeTimers();
	const fake = fixture();
	let posts = 0;
	const larm = makeLarm(async (input, init) => {
		if (
			new URL(String(input)).pathname === "/v1/agent-connections" &&
			posts++ === 1
		)
			return result({ error: "unavailable" }, 503);
		return fake.fetcher(input, init);
	});
	try {
		larm.retain!(true);
		await flush();
		jest.advanceTimersByTime(30_000);
		await flush();
		expect(larm.status().state).toBe("failed");
		jest.advanceTimersByTime(30_000);
		await flush();
		expect(larm.status().state).toBe("ready");
		expect(larm.inspect!().connectionId).toBe("connection1");
	} finally {
		await larm.close();
		jest.useRealTimers();
	}
});

test("leaving during initial claim releases its late Connection and schedules no more Profile requests", async () => {
	const fake = fixture();
	let entered!: () => void;
	let deliver!: () => void;
	const claimed = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		deliver = resolve;
	});
	const larm = makeLarm(async (input, init) => {
		const response = await fake.fetcher(input, init);
		if (String(input).endsWith("/claim")) {
			entered();
			await gate;
		}
		return response;
	});
	try {
		larm.retain!(true);
		await claimed;
		larm.retain!(false);
		deliver();
		await flush();
		expect(larm.inspect!().connectionId).toBeUndefined();
		expect(
			fake.calls.filter((call) => call.startsWith("DELETE ")),
		).toHaveLength(1);
	} finally {
		deliver();
		await larm.close();
	}
});

test("inference proceeds on its valid claim while a periodic Profile POST waits", async () => {
	const fake = fixture();
	let entered!: () => void;
	let deliver!: () => void;
	const posted = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		deliver = resolve;
	});
	let posts = 0;
	const larm = makeLarm(async (input, init) => {
		const response = await fake.fetcher(input, init);
		if (
			new URL(String(input)).pathname === "/v1/agent-connections" &&
			posts++
		) {
			entered();
			await gate;
		}
		return response;
	});
	try {
		await larm.connect();
		larm.retain!(true);
		await posted;
		expect(larm.status().state).toBe("ready");
		expect(await larm.answer(question, freshSignal())).toBe("承知しました");
		larm.retain!(false);
		deliver();
		await flush();
		expect(larm.status().state).toBe("ready");
	} finally {
		deliver();
		await larm.close();
	}
});

test("closing immediately after an overdue screen leaves still releases the Connection", async () => {
	jest.useFakeTimers();
	const fake = fixture();
	const larm = makeLarm(fake.fetcher, 50);
	try {
		larm.retain!(true);
		await flush();
		jest.advanceTimersByTime(100);
		larm.retain!(false);
		const closing = larm.close();
		jest.advanceTimersByTime(1);
		await closing;
		expect(
			fake.calls.filter((call) => call.startsWith("DELETE ")),
		).toHaveLength(1);
	} finally {
		jest.useRealTimers();
	}
});
