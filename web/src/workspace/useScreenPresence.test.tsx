import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useScreenPresence } from "./useScreenPresence";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});
type Details = {
	gestureAgeMs?: number;
	voiceSession?: boolean;
	leaving?: boolean;
};
function fakeClient(playback = false) {
	const changes = new Set<() => void>();
	const client = {
		screenPresence: vi.fn(
			async (
				_id: string,
				_revision: number,
				_active: boolean,
				_sentAt: number,
				_signal?: AbortSignal,
				_details?: Details,
			) => ({ playbackScreen: playback }),
		),
		playbackScreen: vi.fn(async (_id: string, _signal?: AbortSignal) => ({
			playbackScreen: playback,
		})),
		subscribeChanges: vi.fn((listener: () => void) => {
			changes.add(listener);
			return () => changes.delete(listener);
		}),
	};
	return {
		client,
		setPlayback: (value: boolean) => {
			playback = value;
		},
		change: () => {
			for (const listener of changes) listener();
		},
	};
}

test("a screen reports every 30 seconds even while hidden, with its visibility, and unmount leaves once", async () => {
	vi.useFakeTimers();
	let visibility = "visible";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(
		() => visibility as DocumentVisibilityState,
	);
	const { client } = fakeClient();
	const h = renderHook(() => useScreenPresence(client));
	const calls = client.screenPresence.mock.calls;
	const id = calls[0]![0];
	expect(h.result.current.screenId).toBe(id);
	expect(calls[0]!.slice(0, 3)).toEqual([id, 1, true]);
	await act(async () => {
		vi.advanceTimersByTime(30_000);
	});
	expect(calls[1]!.slice(0, 3)).toEqual([id, 2, true]);
	visibility = "hidden";
	act(() => document.dispatchEvent(new Event("visibilitychange")));
	expect(calls.at(-1)!.slice(0, 3)).toEqual([id, 3, false]);
	await act(async () => {
		vi.advanceTimersByTime(60_000);
	});
	// Hidden, it keeps reporting so it can stay the screen that plays sound.
	expect(calls.slice(3).map((call) => call[2])).toEqual([false, false]);
	h.unmount();
	expect(calls.at(-1)!.slice(0, 3)).toEqual([id, 6, false]);
	expect(calls.at(-1)![5]?.leaving).toBe(true);
	await act(async () => {
		vi.advanceTimersByTime(90_000);
	});
	expect(client.screenPresence).toHaveBeenCalledTimes(6);
});

test("the answer of a report and of the query after change notices (at most once a second) say whether this screen plays sound", async () => {
	vi.useFakeTimers();
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	const fake = fakeClient(true);
	const h = renderHook(() => useScreenPresence(fake.client));
	await act(async () => {});
	expect(h.result.current.playbackScreen).toBe(true);
	fake.setPlayback(false);
	act(() => {
		for (let i = 0; i < 5; i++) fake.change();
	});
	expect(fake.client.playbackScreen).not.toHaveBeenCalled();
	await act(async () => {
		vi.advanceTimersByTime(1_000);
	});
	expect(fake.client.playbackScreen).toHaveBeenCalledOnce();
	expect(fake.client.playbackScreen).toHaveBeenCalledWith(
		h.result.current.screenId,
		expect.any(AbortSignal),
	);
	expect(h.result.current.playbackScreen).toBe(false);
	h.unmount();
});

test("pressing or typing reports the gesture at most every five seconds; a voice session reports at once", async () => {
	vi.useFakeTimers();
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	const { client } = fakeClient();
	const h = renderHook(({ session }) => useScreenPresence(client, session), {
		initialProps: { session: false },
	});
	const calls = client.screenPresence.mock.calls;
	act(() => document.dispatchEvent(new Event("pointerdown")));
	expect(calls).toHaveLength(2);
	expect(calls[1]![5]?.gestureAgeMs).toBe(0);
	act(() => document.dispatchEvent(new Event("keydown")));
	expect(calls).toHaveLength(2);
	await act(async () => {
		vi.advanceTimersByTime(5_000);
	});
	act(() => document.dispatchEvent(new Event("keydown")));
	expect(calls).toHaveLength(3);
	h.rerender({ session: true });
	expect(calls).toHaveLength(4);
	expect(calls[3]![5]?.voiceSession).toBe(true);
	h.unmount();
});

test("independent screens survive a failed report; pagehide leaves and stops sound, pageshow comes back", async () => {
	vi.useFakeTimers();
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	const { client } = fakeClient(true);
	client.screenPresence.mockRejectedValueOnce(new Error("offline"));
	const a = renderHook(() => useScreenPresence(client));
	const b = renderHook(() => useScreenPresence(client));
	const calls = client.screenPresence.mock.calls;
	expect(calls[0]![0]).not.toBe(calls[1]![0]);
	await act(async () => {
		vi.advanceTimersByTime(30_000);
	});
	expect(client.screenPresence).toHaveBeenCalledTimes(4);
	expect(a.result.current.playbackScreen).toBe(true);
	act(() => window.dispatchEvent(new Event("pagehide")));
	expect(calls.at(-1)![2]).toBe(false);
	expect(calls.at(-1)![5]?.leaving).toBe(true);
	await act(async () => {});
	expect(a.result.current.playbackScreen).toBe(false);
	await act(async () => {
		vi.advanceTimersByTime(30_000);
	});
	expect(client.screenPresence).toHaveBeenCalledTimes(6);
	act(() => window.dispatchEvent(new Event("pageshow")));
	expect(calls.at(-1)![2]).toBe(true);
	expect(calls.at(-1)![5]?.leaving).toBe(false);
	a.unmount();
	b.unmount();
});
