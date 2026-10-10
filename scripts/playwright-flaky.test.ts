import { expect, test } from "bun:test";
import { flakyTests } from "./playwright-flaky";

test("flakyTests lists tests that passed only after a retry", () => {
	expect(
		flakyTests({
			stats: { flaky: 1 },
			suites: [
				{
					title: "timers.spec.ts",
					suites: [
						{
							title: "timers",
							specs: [
								{ title: "stable", tests: [{ status: "expected" }] },
								{ title: "unstable", tests: [{ status: "flaky" }] },
							],
						},
					],
				},
			],
		}),
	).toEqual(["timers.spec.ts > timers > unstable"]);
});

test("flakyTests is empty when no test is flaky", () => {
	expect(
		flakyTests({
			stats: { flaky: 0 },
			suites: [
				{
					title: "a.spec.ts",
					specs: [{ title: "ok", tests: [{ status: "expected" }] }],
				},
			],
		}),
	).toEqual([]);
});
