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

function setup(
	watchRun: DialogueClient["watchRun"],
	cache = new QueryClient(),
) {
	const client = { identity: "test", watchRun } as unknown as DialogueClient;
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	return renderHook(() => useRunProgress(client, "run-1"), { wrapper });
}
const frame: RunProgress = {
	runId: "run-1",
	status: "running",
	text: "partial",
};

test("refreshes persisted announcements once while keeping them out of answer text", async () => {
	const cache = new QueryClient();
	const invalidate = vi.spyOn(cache, "invalidateQueries");
	let emit: Parameters<DialogueClient["watchRun"]>[2];
	const hook = setup(async (_id, _signal, onProgress) => {
		emit = onProgress;
		await new Promise(() => {});
	}, cache);
	await act(async () => {
		emit({ ...frame, text: "", announcement: "お調べします。" });
	});
	const refreshed = invalidate.mock.calls.length;
	expect(refreshed).toBeGreaterThan(0);
	expect(hook.result.current).toBe("");
	await act(async () => {
		emit({ ...frame, announcement: "お調べします。" });
	});
	expect(invalidate).toHaveBeenCalledTimes(refreshed);
	expect(hook.result.current).toBe("partial");
	hook.unmount();
});

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

test.each(["cancelled", "failed"] as const)(
	"%s removes visible partial text and ignores late callbacks",
	async (status) => {
		let emit!: Parameters<DialogueClient["watchRun"]>[2];
		const hook = setup(async (_id, _signal, onProgress) => {
			emit = onProgress;
			await new Promise(() => {});
		});
		await act(async () => emit(frame));
		expect(hook.result.current).toBe("partial");
		await act(async () => emit({ ...frame, status }));
		expect(hook.result.current).toBe("");
		await act(async () => emit({ ...frame, text: "late" }));
		expect(hook.result.current).toBe("");
		hook.unmount();
	},
);

test("a dropped connection clears text during retry and callbacks from that connection cannot restore it", async () => {
	const emits: Array<Parameters<DialogueClient["watchRun"]>[2]> = [];
	let disconnect!: () => void;
	const hook = setup(async (_id, _signal, onProgress) => {
		emits.push(onProgress);
		if (emits.length === 1)
			await new Promise<void>((_resolve, reject) => {
				disconnect = () => reject(new Error("disconnected"));
			});
		else await new Promise(() => {});
	});
	await act(async () => emits[0]!(frame));
	expect(hook.result.current).toBe("partial");
	await act(async () => disconnect());
	expect(hook.result.current).toBe("");
	await act(async () => {
		emits[0]!({ ...frame, text: "late" });
		await vi.advanceTimersByTimeAsync(250);
	});
	expect(hook.result.current).toBe("");
	await act(async () => emits[1]!({ ...frame, text: "current" }));
	expect(hook.result.current).toBe("current");
	hook.unmount();
});

test.each([401, 403, 404])(
	"a permanent %s after streamed text clears it and ends retries",
	async (status) => {
		let reject!: (error: Error) => void;
		let emit!: Parameters<DialogueClient["watchRun"]>[2];
		const watchRun = vi.fn(async (_id, _signal, onProgress) => {
			emit = onProgress;
			await new Promise<void>((_resolve, fail) => {
				reject = fail;
			});
		});
		const hook = setup(watchRun as DialogueClient["watchRun"]);
		await act(async () => emit(frame));
		expect(hook.result.current).toBe("partial");
		await act(async () => {
			reject(new ApiError(status, "unavailable"));
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(hook.result.current).toBe("");
		expect(watchRun).toHaveBeenCalledTimes(1);
		hook.unmount();
	},
);

test("switching runs or connections clears drafts and rejects callbacks of the previous subscription", async () => {
	const emits: Array<Parameters<DialogueClient["watchRun"]>[2]> = [];
	const finishes: Array<() => void> = [];
	const client = {
		identity: "first",
		watchRun: async (_id, _signal, onProgress) => {
			emits.push(onProgress);
			await new Promise<void>((resolve) => finishes.push(resolve));
		},
	} as DialogueClient;
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const cache = new QueryClient();
	const hook = renderHook(
		({ connection, id }) => useRunProgress(connection, id),
		{ wrapper, initialProps: { connection: client, id: "run-1" } },
	);
	await act(async () => emits[0]!(frame));
	expect(hook.result.current).toBe("partial");
	hook.rerender({ connection: { ...client, identity: "second" }, id: "run-1" });
	expect(hook.result.current).toBe("");
	await act(async () => emits[0]!(frame));
	expect(hook.result.current).toBe("");
	await act(async () => emits[1]!(frame));
	hook.rerender({ connection: client, id: "run-2" });
	expect(hook.result.current).toBe("");
	hook.rerender({ connection: client, id: "run-1" });
	expect(hook.result.current).toBe("");
	await act(async () => emits[3]!({ ...frame, text: "current" }));
	await act(async () => finishes[0]!());
	expect(hook.result.current).toBe("current");
	hook.unmount();
});
