import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { useTimerArtifacts } from "./useTimerArtifacts";
import { queryRoots } from "../../queryKeys";
afterEach(cleanup);
function fixture(items: Array<{ id: string; label: string }> = []) {
	const api = {
		timers: vi.fn(async () => ({ items })),
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
test("saved active timers reopen after reload and polling does not reopen closed tabs", async () => {
	const h = fixture([{ id: "restored", label: "保存したタイマー" }]);
	await waitFor(() => expect(h.open).toHaveBeenCalledOnce());
	expect(h.open).toHaveBeenCalledWith(
		{ kind: "timer", version: 1, timerId: "restored" },
		"保存したタイマー",
	);
	await act(async () => {
		await h.cache.invalidateQueries({
			queryKey: [queryRoots.timers, "workspace"],
		});
	});
	expect(h.open).toHaveBeenCalledOnce();
});
test("a new conversation result discovers a timer without a local run callback or change event", async () => {
	const h = fixture();
	await waitFor(() => expect(h.api.timers).toHaveBeenCalledOnce());
	expect(h.open).not.toHaveBeenCalled();
	h.api.timers.mockResolvedValue({
		items: [{ id: "voice-timer", label: "音声のタイマー" }],
	});
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
