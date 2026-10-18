import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useScreenPresence } from "./useScreenPresence";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});
const sender = () =>
	vi.fn(
		async (
			_id: string,
			_revision: number,
			_active: boolean,
			_sentAt: number,
			_signal?: AbortSignal,
		) => {},
	);

test("visible chat sends every 30 seconds, hidden stops, resume is immediate, and unmount leaves once", async () => {
	vi.useFakeTimers();
	let visibility = "visible";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(
		() => visibility as DocumentVisibilityState,
	);
	const screenPresence = sender();
	const client = { screenPresence };
	const h = renderHook(() => useScreenPresence(client));
	const id = screenPresence.mock.calls[0]![0];
	expect(screenPresence.mock.calls[0]!.slice(0, 3)).toEqual([id, 1, true]);
	await act(async () => {
		vi.advanceTimersByTime(30_000);
	});
	expect(screenPresence.mock.calls[1]!.slice(0, 3)).toEqual([id, 2, true]);
	visibility = "hidden";
	act(() => document.dispatchEvent(new Event("visibilitychange")));
	expect(screenPresence.mock.calls.at(-1)!.slice(0, 3)).toEqual([id, 3, false]);
	await act(async () => {
		vi.advanceTimersByTime(60_000);
	});
	expect(screenPresence).toHaveBeenCalledTimes(3);
	visibility = "visible";
	act(() => document.dispatchEvent(new Event("visibilitychange")));
	expect(screenPresence.mock.calls.at(-1)!.slice(0, 3)).toEqual([id, 4, true]);
	h.unmount();
	expect(screenPresence.mock.calls.at(-1)!.slice(0, 3)).toEqual([id, 5, false]);
	await act(async () => {
		vi.advanceTimersByTime(90_000);
	});
	expect(screenPresence).toHaveBeenCalledTimes(5);
});

test("independent screens survive a failed notification, pagehide stops timers, pageshow resumes", async () => {
	vi.useFakeTimers();
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	const screenPresence = sender().mockRejectedValueOnce(new Error("offline"));
	const client = { screenPresence };
	const a = renderHook(() => useScreenPresence(client));
	const b = renderHook(() => useScreenPresence(client));
	expect(screenPresence.mock.calls[0]![0]).not.toBe(
		screenPresence.mock.calls[1]![0],
	);
	await act(async () => {
		vi.advanceTimersByTime(30_000);
	});
	expect(screenPresence).toHaveBeenCalledTimes(4);
	act(() => window.dispatchEvent(new Event("pagehide")));
	expect(screenPresence.mock.calls.at(-1)![2]).toBe(false);
	await act(async () => {
		vi.advanceTimersByTime(30_000);
	});
	expect(screenPresence).toHaveBeenCalledTimes(6);
	act(() => window.dispatchEvent(new Event("pageshow")));
	expect(screenPresence.mock.calls.at(-1)![2]).toBe(true);
	a.unmount();
	b.unmount();
});

test("an initially hidden screen never starts a periodic active notification", async () => {
	vi.useFakeTimers();
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
	const screenPresence = sender();
	const client = { screenPresence };
	const h = renderHook(() => useScreenPresence(client));
	await act(async () => {
		vi.advanceTimersByTime(90_000);
	});
	expect(screenPresence).toHaveBeenCalledTimes(1);
	expect(screenPresence.mock.calls[0]![2]).toBe(false);
	h.unmount();
});
