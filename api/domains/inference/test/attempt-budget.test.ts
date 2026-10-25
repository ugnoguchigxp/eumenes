import { expect, spyOn, test } from "bun:test";
import { attemptDuration } from "../service/attempt-work";
import type { Request } from "../service/execute-types";

function request(remaining: number, fallback = true): Request {
	return {
		env: { options: {} },
		row: {
			purpose: "tts",
			snapshot: {
				routes: { tts: { mode: "larm-preferred", cloudAllowed: true } },
			},
		},
		selected: fallback ? { connection: { enabled: true } } : null,
		deadline: Date.now() + remaining,
	} as Request;
}

test("speech preparation and synthesis share 30 seconds while fallback keeps its 30 seconds", () => {
	const clock = spyOn(Date, "now").mockReturnValue(1000);
	try {
		const r = request(60_000);
		expect(attemptDuration(r, "larm")).toBe(30_000);
		expect(attemptDuration(r, "cloud")).toBe(30_000);
		clock.mockReturnValue(16_000);
		// After 15 seconds of connection preparation, synthesis still has time;
		// the original 60-second request deadline and fallback reservation hold.
		expect(attemptDuration(r, "larm")).toBe(15_000);
		clock.mockReturnValue(46_000);
		expect(attemptDuration(r, "cloud")).toBe(15_000);
	} finally {
		clock.mockRestore();
	}
});

test("speech preserves explicit attempt limits and an almost exhausted overall deadline", () => {
	const r = request(60_000, false);
	r.env.options.localMs = 200;
	expect(attemptDuration(r, "larm")).toBe(200);
	r.row.attemptMs = 100;
	expect(attemptDuration(r, "larm")).toBe(100);
	r.deadline = Date.now() - 1;
	expect(attemptDuration(r, "larm")).toBe(1);
});

test("ASR keeps its own 15-second local attempt and cloud reservation", () => {
	const r = request(60_000);
	r.row.purpose = "asr";
	r.row.snapshot.routes.asr = {
		mode: "larm-preferred",
		cloudAllowed: true,
	} as typeof r.row.snapshot.routes.asr;
	expect(attemptDuration(r, "larm")).toBe(15_000);
	expect(attemptDuration(r, "cloud")).toBe(30_000);
});
