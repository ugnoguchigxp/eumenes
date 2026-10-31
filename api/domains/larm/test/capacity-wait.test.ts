import { expect, test } from "bun:test";
import type { CapacityWait } from "../contracts/capacity";
import { settleCapacityWait } from "../service/capacity-wait";

const settle = (
	over: Partial<Parameters<typeof settleCapacityWait>[0]> = {},
) => {
	const seen = { expired: 0, scheduled: [] as CapacityWait[] };
	const plan = settleCapacityWait({
		domain: "image",
		subjectId: "s1",
		now: 1_000,
		previous: null,
		retryAfterMs: null,
		budgetMs: 300_000,
		expire: () => seen.expired++,
		schedule: (p) => {
			seen.scheduled.push(p);
			return "job-2";
		},
		...over,
	});
	return { plan, ...seen };
};

test("a refusal schedules the next try 30 s later with the whole budget after it", () => {
	const { plan, expired, scheduled } = settle();
	expect(plan).toEqual({
		startedAt: 1_000,
		count: 1,
		at: 31_000,
		deadline: 331_000,
	});
	expect(scheduled).toEqual([plan!]);
	expect(expired).toBe(0);
});

test("the run is extended to the planned deadline, and a run that cannot be extended ends the wait", () => {
	const asked: number[] = [];
	expect(settle({ extend: (d) => (asked.push(d), d) }).scheduled).toHaveLength(
		1,
	);
	expect(asked).toEqual([331_000]);
	for (const extend of [() => 331_000 - 1, () => null]) {
		const r = settle({ extend });
		expect(r.plan).toBeNull();
		expect(r.expired).toBe(1);
		expect(r.scheduled).toHaveLength(0);
	}
});

test("the 30-minute limit and a fixed deadline end the wait without scheduling", () => {
	const late = settle({
		now: 30 * 60_000,
		previous: { startedAt: 0, count: 59 },
	});
	expect(late.plan).toBeNull();
	expect(late.expired).toBe(1);
	const fixed = settle({ limitAt: 331_000 - 1 });
	expect(fixed.plan).toBeNull();
	expect(fixed.expired).toBe(1);
});
