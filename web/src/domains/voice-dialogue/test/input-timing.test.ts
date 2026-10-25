import { afterEach, expect, it, vi } from "vitest";
import { createInputLedger } from "../hooks/input-timing";

afterEach(() => vi.restoreAllMocks());

it("reports an input's timing once, when its transcript is shown, and keeps only recent inputs", () => {
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const timings = createInputLedger();
	const durations = {
		audioMs: 2800,
		preRollMs: 1000,
		trailMs: 1500,
		endToSegmentMs: 1500,
		encodeMs: 5,
	};
	const segment = { ...durations, handedAt: 10 };
	now = 40;
	timings.uploaded("a", segment);
	now = 2040;
	// The hand-over clock is not a duration and never leaves the browser.
	expect(timings.shown("a")).toEqual({
		...durations,
		uploadMs: 30,
		uploadToShownMs: 2000,
	});
	expect(timings.shown("a")).toBeUndefined();
	timings.uploaded("b", undefined);
	expect(timings.shown("b")).toBeUndefined();
	for (let i = 0; i < 20; i++) timings.uploaded(`n${i}`, segment);
	expect(timings.shown("n0")).toBeUndefined();
	expect(timings.shown("n19")).toBeDefined();
});
