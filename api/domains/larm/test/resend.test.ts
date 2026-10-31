import { expect, test } from "bun:test";
import {
	LARM_CAPACITY_WAIT_LIMIT_MS,
	planCapacityWait,
} from "../contracts/capacity";
import {
	checkRefusal,
	claimWhenReady,
	isCapacityBusy,
	LarmCapacityBusy,
	sendAgainIfLost,
} from "../service/resend";

const refusal = (status: number, body: unknown, headers: HeadersInit = {}) =>
	Response.json(body, { status, headers });
const memory = { code: "resource_exhausted", resource: "memory" };

test("the capacity refusal is 503 resource_exhausted for memory, in either body shape", async () => {
	for (const body of [{ error: memory }, memory]) {
		const error = await checkRefusal(refusal(503, body), "/x", true).catch(
			(e: unknown) => e,
		);
		expect(isCapacityBusy(error)).toBe(true);
	}
	for (const [status, body] of [
		[429, { error: memory }],
		[409, { error: memory }],
		[503, { error: { ...memory, resource: "gpu" } }],
		[503, { error: "resource_exhausted" }],
		[503, { error: { code: "image_model_unavailable" } }],
	] as const)
		await expect(checkRefusal(refusal(status, body), "/x", true)).resolves.toBe(
			undefined,
		);
	await expect(
		checkRefusal(new Response("not json", { status: 503 }), "/x", true),
	).resolves.toBe(undefined);
});

test("a read, renewal or release refused for memory is not a wait", async () => {
	await expect(
		checkRefusal(refusal(503, { error: memory }), "/x", false),
	).resolves.toBe(undefined);
});

test("Retry-After in seconds or as a date is kept up to five minutes", async () => {
	const after = async (value: string) =>
		(
			(await checkRefusal(
				refusal(503, { error: memory }, { "Retry-After": value }),
				"/x",
				true,
			).catch((e: unknown) => e)) as LarmCapacityBusy
		).retryAfterMs;
	expect(await after("90")).toBe(90_000);
	expect(await after("3600")).toBe(300_000);
	expect(await after("0")).toBeNull();
	expect(await after("soon")).toBeNull();
	const date = await after(new Date(Date.now() + 60_000).toUTCString());
	expect(date).toBeGreaterThan(55_000);
	expect(date).toBeLessThanOrEqual(60_000);
});

test("the next try is 30 s later, or LARM's longer Retry-After up to 5 min", () => {
	const plan = (retryAfterMs: number | null) =>
		planCapacityWait({
			now: 1_000,
			previous: null,
			retryAfterMs,
			budgetMs: 300_000,
		});
	expect(plan(null)).toEqual({
		startedAt: 1_000,
		count: 1,
		at: 31_000,
		deadline: 331_000,
	});
	expect(plan(10_000)!.at).toBe(31_000);
	expect(plan(90_000)!.at).toBe(91_000);
	expect(plan(900_000)!.at).toBe(301_000);
});

test("the wait stops at 30 minutes from the first refusal or at a fixed deadline", () => {
	const startedAt = 0;
	const next = (now: number, limitAt?: number) =>
		planCapacityWait({
			now,
			previous: { startedAt, count: 5 },
			retryAfterMs: null,
			budgetMs: 300_000,
			limitAt,
		});
	expect(next(LARM_CAPACITY_WAIT_LIMIT_MS - 30_000)).toMatchObject({
		startedAt,
		count: 6,
		at: LARM_CAPACITY_WAIT_LIMIT_MS,
	});
	expect(next(LARM_CAPACITY_WAIT_LIMIT_MS - 29_999)).toBeNull();
	expect(next(60_000, 60_000 + 30_000 + 300_000)).not.toBeNull();
	expect(next(60_000, 60_000 + 30_000 + 299_999)).toBeNull();
});

test("a lost response is sent once more; any other failure is not", async () => {
	let sent = 0;
	const lost = (error: Error) => async () => {
		sent++;
		if (sent === 1) throw error;
		return "accepted";
	};
	expect(await sendAgainIfLost(lost(new TypeError("fetch failed")))).toBe(
		"accepted",
	);
	expect(sent).toBe(2);
	sent = 0;
	expect(
		await sendAgainIfLost(lost(new DOMException("t", "TimeoutError"))),
	).toBe("accepted");
	expect(sent).toBe(2);
	// A resend refused for memory leaves the first send's fate unknown: the loss is reported.
	sent = 0;
	const loss = new TypeError("fetch failed");
	await expect(
		sendAgainIfLost(async () => {
			sent++;
			if (sent === 1) throw loss;
			throw new LarmCapacityBusy(null);
		}),
	).rejects.toBe(loss);
	expect(sent).toBe(2);
	for (const error of [
		new DOMException("a", "AbortError"),
		new Error("larm_http_500"),
	]) {
		sent = 0;
		await expect(sendAgainIfLost(lost(error))).rejects.toBe(error);
		expect(sent).toBe(1);
	}
	sent = 0;
	await expect(
		sendAgainIfLost(async () => {
			sent++;
			throw new TypeError("fetch failed");
		}),
	).rejects.toThrow("fetch failed");
	expect(sent).toBe(2);
});

test("a not-ready claim is repeated after each wait until it is ready", async () => {
	const answers = [null, null, "claimed"];
	let waits = 0;
	expect(
		await claimWhenReady(
			async () => answers.shift() ?? null,
			async () => {
				waits++;
			},
		),
	).toBe("claimed");
	expect(waits).toBe(2);
});
