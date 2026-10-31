import { afterEach, expect, jest, test } from "bun:test";
import { createScreenPresence } from "../service/screen-presence";
import { cleanup, setup } from "./inference.fixture";

afterEach(async () => {
	jest.useRealTimers();
	for (const close of cleanup.splice(0)) await close();
});

test("multiple screens share the main port; only the final departure or timeout stops retention", () => {
	jest.useFakeTimers();
	const seen: boolean[] = [];
	const port = { retain: (active: boolean) => seen.push(active) };
	const screen = createScreenPresence(
		() => port,
		() => () => {},
	);
	try {
		screen.update("one", 1, true, Date.now());
		screen.update("two", 1, true, Date.now());
		screen.update("one", 3, false, Date.now());
		screen.update("one", 2, true, Date.now());
		expect(seen).toEqual([true]);
		jest.advanceTimersByTime(60_000);
		screen.update("two", 2, true, Date.now());
		jest.advanceTimersByTime(30_000);
		expect(seen).toEqual([true]);
		jest.advanceTimersByTime(60_000);
		expect(seen).toEqual([true, false]);
	} finally {
		screen.close();
	}
});

test("delayed notifications cannot reacquire ownership after the departure tombstone expires", () => {
	jest.useFakeTimers();
	const seen: boolean[] = [];
	const port = { retain: (active: boolean) => seen.push(active) };
	const screen = createScreenPresence(
		() => port,
		() => () => {},
	);
	const sentAt = Date.now();
	try {
		screen.update("one", 1, true, sentAt);
		screen.update("one", 3, false, sentAt);
		jest.advanceTimersByTime(90_001);
		expect(() => screen.update("one", 2, true, sentAt)).toThrow(
			"screen_presence_expired",
		);
		expect(() => screen.update("one", 4, true, Date.now() + 6000)).toThrow(
			"screen_presence_expired",
		);
		expect(seen).toEqual([true, false]);
	} finally {
		screen.close();
	}
});

test("duplicate requests do not extend expiry; the bounded tab capacity recovers after expiry", () => {
	jest.useFakeTimers();
	const seen: boolean[] = [];
	const port = { retain: (active: boolean) => seen.push(active) };
	const screen = createScreenPresence(
		() => port,
		() => () => {},
	);
	try {
		for (let i = 0; i < 64; i++) screen.update(String(i), 1, true, Date.now());
		expect(() => screen.update("overflow", 1, true, Date.now())).toThrow(
			"screen_presence_capacity",
		);
		jest.advanceTimersByTime(60_000);
		screen.update("0", 1, true, Date.now());
		jest.advanceTimersByTime(30_000);
		expect(seen).toEqual([true, false]);
		expect(() => screen.update("overflow", 1, true, Date.now())).not.toThrow();
	} finally {
		screen.close();
	}
});

test("settings changes stop the old port even if other work retains it; close unsubscribes and rejects updates", () => {
	const seen: string[] = [];
	let current = { retain: (active: boolean) => seen.push(`old:${active}`) };
	let changed: (() => void) | undefined;
	const screen = createScreenPresence(
		() => current,
		(listener) => {
			changed = listener;
			return () => {
				changed = undefined;
			};
		},
	);
	screen.update("one", 1, true, Date.now());
	current = { retain: (active: boolean) => seen.push(`new:${active}`) };
	changed!();
	expect(seen).toEqual(["old:true", "old:false", "new:true"]);
	screen.close();
	expect(seen).toEqual(["old:true", "old:false", "new:true", "new:false"]);
	expect(changed).toBeUndefined();
	expect(() => screen.update("one", 2, true, Date.now())).toThrow(
		"inference_closed",
	);
});

test("inference exposes screen ownership on its existing saved-settings port and stops it on close", async () => {
	const h = await setup();
	const seen: boolean[] = [];
	h.port.retain = (active) => seen.push(active);
	h.inference.screenPresence("one", 1, true, Date.now());
	h.inference.screenPresence("one", 2, false, Date.now());
	h.inference.screenPresence("one", 3, true, Date.now());
	await h.inference.close();
	expect(seen).toEqual([true, false, true, false]);
});

test("one screen plays sound: the voice session first, then the latest touch, then the latest registered; leaving hands it on", () => {
	jest.useFakeTimers();
	const changes: Array<string | null> = [];
	const player = () =>
		["one", "two"].find((id) => screen.isPlaybackScreen(id)) ?? null;
	const screen = createScreenPresence(
		() => ({ retain: () => {} }),
		() => () => {},
		() => changes.push(player()),
	);
	try {
		expect(screen.update("one", 1, true, Date.now())).toBe(true);
		jest.advanceTimersByTime(10);
		// The newer screen takes it until someone touches a screen.
		expect(screen.update("two", 1, false, Date.now())).toBe(true);
		expect(screen.update("one", 2, true, Date.now(), { gestureAgeMs: 0 })).toBe(
			true,
		);
		jest.advanceTimersByTime(10);
		// The microphone's session wins over a later touch elsewhere.
		expect(
			screen.update("two", 2, false, Date.now(), { voiceSession: true }),
		).toBe(true);
		expect(screen.update("one", 3, true, Date.now(), { gestureAgeMs: 0 })).toBe(
			false,
		);
		// A hidden screen keeps it; leaving hands it to the other screen.
		expect(screen.update("two", 3, false, Date.now(), { leaving: true })).toBe(
			false,
		);
		expect(screen.isPlaybackScreen("one")).toBe(true);
		expect(changes).toEqual(["one", "two", "one", "two", "one"]);
		// An older report never undoes a newer one.
		expect(screen.update("two", 2, true, Date.now())).toBe(false);
		jest.advanceTimersByTime(90_001);
		expect(screen.isPlaybackScreen("one")).toBe(false);
		expect(changes.at(-1)).toBeNull();
	} finally {
		screen.close();
	}
});
