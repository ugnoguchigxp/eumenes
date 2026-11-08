import { expect, test } from "bun:test";
import { createAgencyActivity } from "./always-on-activity";

test("activity leases respect revisions, hidden playback, independent screens and expiration", () => {
	let now = Date.now(),
		changed = 0;
	const timers = new Map<object, () => void>();
	const leases = createAgencyActivity({
		now: () => now,
		changed: () => {
			changed++;
		},
		setTimer(fn) {
			const id = {};
			timers.set(id, fn);
			return id;
		},
		clearTimer(id) {
			timers.delete(id as object);
		},
	});
	const report = {
		screenId: crypto.randomUUID(),
		revision: 1,
		sentAt: now,
		visible: true,
		typing: true,
		playing: false,
	};
	expect(leases.update("a", report)).toBe(true);
	expect(leases.update("a", { ...report, typing: false })).toBe(false);
	expect(leases.busy("a")).toBe(true);
	expect(leases.busy("b")).toBe(false);
	expect(leases.update("a", { ...report, revision: 2, visible: false })).toBe(
		true,
	);
	expect(leases.busy("a")).toBe(false);
	leases.update("a", { ...report, revision: 3, visible: false, playing: true });
	leases.update("a", { ...report, screenId: crypto.randomUUID() });
	leases.update("a", { ...report, revision: 4, leaving: true });
	expect(leases.busy("a")).toBe(true);
	now += 45_000;
	const expiryCallbacks = Array.from(timers.values());
	for (const fn of expiryCallbacks) fn();
	expect(leases.busy("a")).toBe(false);
	expect(changed).toBeGreaterThan(4);
	leases.close();
	expect(timers.size).toBe(0);
});
