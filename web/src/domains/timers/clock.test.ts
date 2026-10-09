import { describe, expect, it } from "vitest";
import { bindServerClock, displayRemainingSeconds } from "./clock";

const due = "2026-10-09T00:03:00.000Z";
const serverNow = "2026-10-09T00:00:00.000Z";

describe("displayRemainingSeconds", () => {
	it("follows the deadline instead of subtracting one each tick", () => {
		const clock = bindServerClock(serverNow, 0, 0);
		const snapshot = {
			dueAt: due,
			serverNow,
			state: "active" as const,
			cancelledAt: null,
		};
		expect(displayRemainingSeconds(snapshot, clock.baseServer + 0)).toBe(180);
		expect(displayRemainingSeconds(snapshot, clock.baseServer + 1000)).toBe(
			179,
		);
		expect(displayRemainingSeconds(snapshot, clock.baseServer + 179_999)).toBe(
			1,
		);
		expect(displayRemainingSeconds(snapshot, clock.baseServer + 180_000)).toBe(
			0,
		);
		expect(
			displayRemainingSeconds(
				{
					...snapshot,
					state: "cancelled",
					cancelledAt: "2026-10-09T00:01:00.000Z",
				},
				clock.baseServer + 120_000,
			),
		).toBe(120);
	});
});
