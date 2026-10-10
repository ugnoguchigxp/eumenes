import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { msUntilNextDeadline } from "./deadline";
import { useTimerArtifacts } from "./useTimerArtifacts";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

test("msUntilNextDeadline ignores deadlines the server already passed and adds a settle margin", () => {
	const serverNow = "2026-10-10T00:00:00.000Z";
	expect(msUntilNextDeadline([], serverNow, 1000, 1000)).toBeNull();
	expect(
		msUntilNextDeadline(["2026-10-09T23:59:59.000Z"], serverNow, 1000, 1000),
	).toBeNull();
	expect(
		msUntilNextDeadline(
			["2026-10-10T00:00:30.000Z", "2026-10-10T00:00:10.000Z"],
			serverNow,
			1000,
			3000,
		),
	).toBe(8_250);
});

test("active timers cause one fetch in 10 seconds and one more once they expire", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.setSystemTime(new Date("2026-10-10T00:00:00.000Z"));
	const timers = vi.fn(async () => ({
		serverNow: new Date().toISOString(),
		items: [
			{
				id: "t1",
				label: "x",
				state: "active",
				dueAt: "2026-10-10T00:00:30.000Z",
			},
		],
	}));
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	function Host() {
		useTimerArtifacts({ timers } as never, () => {});
		return null;
	}
	render(
		<QueryClientProvider client={cache}>
			<Host />
		</QueryClientProvider>,
	);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(10_000);
	});
	expect(timers).toHaveBeenCalledTimes(1);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(20_300);
	});
	expect(timers).toHaveBeenCalledTimes(2);
});

test("a timer the server still lists after its deadline is looked at again with growing gaps, then left to the change stream", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.setSystemTime(new Date("2026-10-10T00:00:00.000Z"));
	const timers = vi.fn(async () => ({
		serverNow: new Date().toISOString(),
		items: [
			{
				id: "t1",
				label: "x",
				state: "active",
				dueAt: "2026-10-10T00:00:05.000Z",
			},
		],
	}));
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	function Host() {
		useTimerArtifacts({ timers } as never, () => {});
		return null;
	}
	render(
		<QueryClientProvider client={cache}>
			<Host />
		</QueryClientProvider>,
	);
	const advance = (ms: number) =>
		act(async () => {
			await vi.advanceTimersByTimeAsync(ms);
		});
	await advance(5_300);
	expect(timers).toHaveBeenCalledTimes(2);
	await advance(1_000);
	expect(timers).toHaveBeenCalledTimes(3);
	await advance(2_000);
	expect(timers).toHaveBeenCalledTimes(4);
	await advance(4_000);
	await advance(8_000);
	expect(timers).toHaveBeenCalledTimes(6);
	await advance(60_000);
	expect(timers).toHaveBeenCalledTimes(6);
});
