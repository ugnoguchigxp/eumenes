import { afterEach, expect, it, vi } from "vitest";
import { createSegmentClock } from "../controller/segment-timing";

afterEach(() => vi.restoreAllMocks());

it("splits a segment into pre-roll, speech and trailing silence and times its encoding", () => {
	let now = 1000;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const clock = createSegmentClock();
	clock.confirmed(16000); // 1 s of pre-roll at 16 kHz
	now = 1300;
	clock.heard(20800); // last voiced 0.3 s later
	now = 2800; // 1.5 s of silence waited
	const { wav, timing } = clock.take(44800, 16000, () => {
		now = 2805;
		return new Uint8Array(4);
	});
	expect(wav).toHaveLength(4);
	expect(timing).toEqual({
		audioMs: 2800,
		preRollMs: 1000,
		trailMs: 1500,
		endToSegmentMs: 1500,
		encodeMs: 5,
		handedAt: 2805,
	});
});
