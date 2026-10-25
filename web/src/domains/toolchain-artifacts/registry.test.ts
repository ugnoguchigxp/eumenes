import { afterEach, expect, test, vi } from "vitest";
import { createLiveScreen } from "./registry";

afterEach(() => vi.useRealTimers());

test("a live screen is reachable while attached and only the latest one detaches itself", () => {
	const live = createLiveScreen<{ name: string }>();
	expect(live.current()).toBeNull();
	const first = { name: "first" };
	const second = { name: "second" };
	const detachFirst = live.attach(first);
	const detachSecond = live.attach(second);
	detachFirst();
	expect(live.current()).toBe(second);
	detachSecond();
	expect(live.current()).toBeNull();
});

test("waitFor resolves once the screen mounts and its state is ready", async () => {
	vi.useFakeTimers();
	const live = createLiveScreen<{ ready: boolean }>();
	const handle = { ready: false };
	const result = live.waitFor((h) => h.ready && "ok");
	await vi.advanceTimersByTimeAsync(200);
	live.attach(handle);
	await vi.advanceTimersByTimeAsync(200);
	handle.ready = true;
	await vi.advanceTimersByTimeAsync(100);
	await expect(result).resolves.toBe("ok");
});

test("waitFor gives up with null after the timeout", async () => {
	vi.useFakeTimers();
	const live = createLiveScreen<object>();
	const result = live.waitFor(() => false, 1_000);
	await vi.advanceTimersByTimeAsync(1_100);
	await expect(result).resolves.toBeNull();
});
