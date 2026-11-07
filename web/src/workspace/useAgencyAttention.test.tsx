import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useAgencyAttention } from "./useAgencyAttention";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("only a visible mounted screen renews attention and unfinished requests are aborted", async () => {
	vi.useFakeTimers();
	let visible = "hidden";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(
		() => visible as DocumentVisibilityState,
	);
	const signals: AbortSignal[] = [];
	const agencyAttention = vi.fn((_id: string, signal?: AbortSignal) => {
		signals.push(signal!);
		return new Promise<never>(() => {});
	});
	const mounted = renderHook(() =>
		useAgencyAttention({ agencyAttention }, "screen"),
	);
	expect(agencyAttention).not.toHaveBeenCalled();
	visible = "visible";
	await act(async () => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
	expect(agencyAttention).toHaveBeenCalledTimes(1);
	expect(agencyAttention.mock.calls[0]?.[0]).toBe("screen");
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30_000);
	});
	expect(agencyAttention).toHaveBeenCalledTimes(1);
	visible = "hidden";
	act(() => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
	expect(signals[0]?.aborted).toBe(true);
	mounted.unmount();
	await vi.advanceTimersByTimeAsync(60_000);
	expect(agencyAttention).toHaveBeenCalledTimes(1);
});

test("resolved renewals continue, then stop while hidden", async () => {
	vi.useFakeTimers();
	let visible = "visible";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(
		() => visible as DocumentVisibilityState,
	);
	const agencyAttention = vi.fn(async () => ({}) as never);
	renderHook(() => useAgencyAttention({ agencyAttention }, "screen"));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30_000);
	});
	expect(agencyAttention).toHaveBeenCalledTimes(3);
	visible = "hidden";
	await act(async () => {
		await vi.advanceTimersByTimeAsync(60_000);
	});
	expect(agencyAttention).toHaveBeenCalledTimes(3);
});
