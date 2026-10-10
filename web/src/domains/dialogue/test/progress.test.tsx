import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RunProgress } from "../../../../../api/domains/dialogue/contracts";
import type { DialogueClient } from "../../../../../client/dialogue";
import { ApiError } from "../../../../../client/transport";
import { useRunProgress } from "..";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(watchRun: DialogueClient["watchRun"]) {
	const client = { identity: "test", watchRun } as unknown as DialogueClient;
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={new QueryClient()}>
			{children}
		</QueryClientProvider>
	);
	return renderHook(() => useRunProgress(client, "run-1"), { wrapper });
}
const frame: RunProgress = {
	runId: "run-1",
	status: "running",
	text: "partial",
};

test("keeps retrying past five failures and shows the next frame", async () => {
	const watchRun = vi.fn(async (_id, _signal, onProgress) => {
		if (watchRun.mock.calls.length <= 6) throw new Error("api_down");
		onProgress(frame);
		await new Promise(() => {});
	});
	const hook = setup(watchRun as DialogueClient["watchRun"]);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(60_000);
	});
	expect(watchRun).toHaveBeenCalledTimes(7);
	expect(hook.result.current).toBe("partial");
});

test("does not retry a permanent 404", async () => {
	const watchRun = vi.fn(async () => {
		throw new ApiError(404, "run_not_found");
	});
	setup(watchRun as unknown as DialogueClient["watchRun"]);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(60_000);
	});
	expect(watchRun).toHaveBeenCalledTimes(1);
});

test("stops retrying after a terminal frame", async () => {
	const watchRun = vi.fn(async (_id, _signal, onProgress) => {
		onProgress({ ...frame, status: "completed" });
		throw new Error("stream_cut");
	});
	setup(watchRun as DialogueClient["watchRun"]);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(60_000);
	});
	expect(watchRun).toHaveBeenCalledTimes(1);
});

test("unmount stops the retry loop", async () => {
	const watchRun = vi.fn(async () => {
		throw new Error("api_down");
	});
	const hook = setup(watchRun as unknown as DialogueClient["watchRun"]);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(300);
	});
	const calls = watchRun.mock.calls.length;
	hook.unmount();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(60_000);
	});
	expect(watchRun).toHaveBeenCalledTimes(calls);
});
