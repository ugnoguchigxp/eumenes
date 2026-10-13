import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useStopwatch } from "./useStopwatch";
import { useClockWorkspace, withClockControls } from "./clock-runtime";
import type { ArtifactRuntime } from "@eumenes/artifact-ui";

let mono = 0;
beforeEach(() => {
	mono = 0;
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	vi.spyOn(performance, "now").mockImplementation(() => mono);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("delayed display samples measure elapsed time and stopping excludes the pause", () => {
	const hook = renderHook(() => useStopwatch(true));
	act(() => hook.result.current.start());
	mono = 12345;
	act(() => vi.advanceTimersByTime(50));
	expect(hook.result.current.elapsedMs).toBe(12345);
	mono = 13000;
	act(() => hook.result.current.stop());
	expect(hook.result.current.elapsedMs).toBe(13000);
	mono = 99000;
	act(() => vi.advanceTimersByTime(500));
	expect(hook.result.current.elapsedMs).toBe(13000);
	act(() => hook.result.current.start());
	mono = 101500;
	act(() => vi.advanceTimersByTime(50));
	expect(hook.result.current.elapsedMs).toBe(15500);
	act(() => hook.result.current.reset());
	expect(hook.result.current.elapsedMs).toBe(0);
	expect(hook.result.current.running).toBe(false);
});

test("hiding a pane suspends painting but not measurement, and unmount clears the tick", () => {
	const hook = renderHook(({ visible }) => useStopwatch(visible), {
		initialProps: { visible: true },
	});
	act(() => hook.result.current.start());
	hook.rerender({ visible: false });
	expect(vi.getTimerCount()).toBe(0);
	mono = 60000;
	hook.rerender({ visible: true });
	act(() => vi.advanceTimersByTime(50));
	expect(hook.result.current.elapsedMs).toBe(60000);
	hook.unmount();
	expect(vi.getTimerCount()).toBe(0);
});

test("timer source changes retain the stopwatch; closing the clock discards the session", () => {
	const hook = renderHook(
		({ source, visible }) => useClockWorkspace({ source, visible }),
		{ initialProps: { source: "timer-setup" as string | null, visible: true } },
	);
	act(() => {
		hook.result.current.setMode("stopwatch");
		hook.result.current.stopwatch.start();
	});
	mono = 1000;
	act(() => vi.advanceTimersByTime(50));
	hook.rerender({ source: "timer-saved", visible: false });
	expect(hook.result.current.mode).toBe("timer");
	expect(hook.result.current.stopwatch.running).toBe(true);
	mono = 8000;
	act(() => hook.result.current.setMode("stopwatch"));
	hook.rerender({ source: "timer-saved", visible: true });
	act(() => vi.advanceTimersByTime(50));
	expect(hook.result.current.stopwatch.elapsedMs).toBe(8000);
	hook.rerender({ source: null, visible: false });
	expect(hook.result.current.stopwatch.elapsedMs).toBe(0);
	expect(hook.result.current.stopwatch.running).toBe(false);
});

test("clock dispatch validates its resource while timer operations use their existing handler", async () => {
	const hook = renderHook(() =>
		useClockWorkspace({ source: "timer-setup", visible: true }),
	);
	const dispatch = vi.fn(async () => ({
		status: "accepted" as const,
		message: "saved",
	}));
	const runtime: ArtifactRuntime = {
		snapshot: {
			"timer-setup": { kind: "timer-workspace", revision: 0, state: "setup" },
		},
		dispatch,
	};
	const event = {
		id: "event",
		source: "timer-setup",
		revision: 0,
		action: "stopwatch-start" as const,
		values: {},
	};
	expect(
		(
			await withClockControls(runtime, hook.result.current).dispatch({
				...event,
				source: "other",
			})
		).status,
	).toBe("rejected");
	expect(
		(
			await withClockControls(runtime, hook.result.current).dispatch({
				...event,
				revision: 1,
			})
		).status,
	).toBe("rejected");
	await act(async () => {
		await withClockControls(runtime, hook.result.current).dispatch(event);
	});
	expect(hook.result.current.stopwatch.running).toBe(true);
	await withClockControls(runtime, hook.result.current).dispatch({
		...event,
		action: "timer-start",
	});
	expect(dispatch).toHaveBeenCalledOnce();
});
