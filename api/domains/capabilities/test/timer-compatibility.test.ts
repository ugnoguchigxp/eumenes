import { expect, test } from "bun:test";
import { hash, timerResultContext } from "../contracts";
import { zSchema } from "../service/schema";

test("timer UI pausing keeps the deployed version 1 input schemas and accepts paused result state", () => {
	// Captured from HEAD before the UI feature: stored capability revisions must still match.
	expect(hash(zSchema("timerList"))).toBe(
		"d06d3a1037587b1c3e12ccbe52592052cf542c1c54e5fc9846ddddda139f5943",
	);
	expect(hash(zSchema("timerCommand"))).toBe(
		"ccec84873264c48f26d6418630d82556bba9d46037f87e6d386b9226d31ce220",
	);
	const context = timerResultContext.parse({
		version: 1,
		kind: "timer_action",
		action: "listed",
		observedAt: "2026-10-13T00:00:00Z",
		items: [
			{
				id: crypto.randomUUID(),
				revision: 1,
				label: "タイマー",
				state: "paused",
				durationSeconds: 90,
				remainingSeconds: 70,
				dueAt: "2026-10-13T00:01:30Z",
			},
		],
		complete: true,
		errorCode: null,
	});
	expect(context.items[0]?.state).toBe("paused");
});
