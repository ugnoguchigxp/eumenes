import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { useTimerArtifacts } from "./useTimerArtifacts";
import { queryRoots } from "../../queryKeys";
afterEach(cleanup);
function fixture(items: Array<{ id: string; label: string }> = []) {
	const api = {
		timers: vi.fn(async (query: { state?: string }) => ({
			items: query.state === "paused" ? [] : items,
		})),
		timerReceiptByRun: vi.fn(async (id: string) => ({
			receipt: {
				action: "started",
				timer: { label: "音声のタイマー" },
				artifact: { kind: "timer", version: 1, timerId: id },
			},
		})),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const open = vi.fn();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const hook = renderHook(
		({ runs }: { runs?: Array<{ id: string; status: string }> }) =>
			useTimerArtifacts(api as never, open, runs),
		{ wrapper, initialProps: {} },
	);
	return { api, cache, open, hook };
}
test("timers saved before reload stay closed and polling does not open them", async () => {
	const h = fixture([{ id: "restored", label: "保存したタイマー" }]);
	await waitFor(() => expect(h.api.timers).toHaveBeenCalledTimes(2));
	await act(async () => {
		await h.cache.invalidateQueries({
			queryKey: [queryRoots.timers, "workspace"],
		});
	});
	expect(h.api.timers).toHaveBeenCalledTimes(4);
	expect(h.open).not.toHaveBeenCalled();
});
test("a new conversation result discovers a timer without a local run callback or change event", async () => {
	const h = fixture();
	await waitFor(() => expect(h.api.timers).toHaveBeenCalledTimes(2));
	expect(h.open).not.toHaveBeenCalled();
	h.api.timers.mockImplementation(async (query) => ({
		items:
			query.state === "paused"
				? []
				: [{ id: "voice-timer", label: "音声のタイマー" }],
	}));
	h.hook.rerender({ runs: [{ id: "voice-run", status: "completed" }] });
	await waitFor(() =>
		expect(h.open).toHaveBeenCalledWith(
			{ kind: "timer", version: 1, timerId: "voice-timer" },
			"音声のタイマー",
		),
	);
});
test("voice and rapid successive runs open their own saved artifacts", async () => {
	const h = fixture();
	act(() => {
		h.hook.result.current("voice-run");
		h.hook.result.current("manual-run");
	});
	await waitFor(() => expect(h.open).toHaveBeenCalledTimes(2));
	expect(h.open.mock.calls.map(([ref]) => ref.timerId)).toEqual([
		"voice-run",
		"manual-run",
	]);
	expect(h.api.timerReceiptByRun).toHaveBeenCalledWith(
		"voice-run",
		expect.any(AbortSignal),
	);
});
