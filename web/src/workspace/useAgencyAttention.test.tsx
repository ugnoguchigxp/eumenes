import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { AgencyActivity } from "../../../api/domains/dialogue/contracts/agency-status";
import {
	TYPING_IDLE_MS,
	useAgencyAttention,
	useTyping,
} from "./useAgencyAttention";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("activity changes supersede pending reports, retain playback while hidden and release on unmount", async () => {
	vi.useFakeTimers();
	let visible = "visible";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(
		() => visible as DocumentVisibilityState,
	);
	const reports: AgencyActivity[] = [],
		signals: AbortSignal[] = [];
	const client = {
		agencyAttention: vi.fn(
			(_id: string, signal?: AbortSignal, activity?: AgencyActivity) => {
				reports.push(activity!);
				signals.push(signal!);
				return new Promise<never>(() => {});
			},
		),
	};
	const mounted = renderHook(
		({ typing, playing }) =>
			useAgencyAttention(client, "screen", { typing, playing }),
		{ initialProps: { typing: false, playing: false } },
	);
	expect(reports).toHaveLength(1);
	mounted.rerender({ typing: true, playing: false });
	expect(signals[0]!.aborted).toBe(true);
	expect(reports.at(-1)).toMatchObject({ typing: true, playing: false });
	mounted.rerender({ typing: false, playing: true });
	visible = "hidden";
	act(() => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
	expect(reports.at(-1)).toMatchObject({ visible: false, playing: true });
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30_000);
	});
	expect(reports).toHaveLength(4);
	mounted.unmount();
	expect(reports.at(-1)?.leaving).toBe(true);
	expect(new Set(reports.map((r) => r.screenId)).size).toBe(1);
	expect(reports.map((r) => r.revision)).toEqual([1, 2, 3, 4, 5]);
});

test("settled requests renew a finite lease while a screen is mounted", async () => {
	vi.useFakeTimers();
	const client = { agencyAttention: vi.fn(async () => ({}) as never) };
	const mounted = renderHook(() => useAgencyAttention(client, "screen"));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30_000);
	});
	expect(client.agencyAttention).toHaveBeenCalledTimes(3);
	mounted.unmount();
	await vi.advanceTimersByTimeAsync(60_000);
	expect(client.agencyAttention).toHaveBeenCalledTimes(4);
});

test("typing is the user's own text while it changes: dictated text and a draft left still are not", async () => {
	vi.useFakeTimers();
	const hook = renderHook((draft) => useTyping(draft), {
		initialProps: { text: "", dictated: false },
	});
	expect(hook.result.current).toBe(false);
	hook.rerender({ text: "認識した文", dictated: true });
	expect(hook.result.current).toBe(false);
	hook.rerender({ text: "書", dictated: false });
	expect(hook.result.current).toBe(true);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(TYPING_IDLE_MS - 1);
	});
	hook.rerender({ text: "書き", dictated: false });
	await act(async () => {
		await vi.advanceTimersByTimeAsync(TYPING_IDLE_MS - 1);
	});
	expect(hook.result.current).toBe(true);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1);
	});
	expect(hook.result.current).toBe(false);
});
