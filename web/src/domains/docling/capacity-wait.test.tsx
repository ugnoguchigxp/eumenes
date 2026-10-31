import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../../../../client/transport";
import { queryRoots } from "../../queryKeys";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";
import {
	capacityTimeoutMessage,
	capacityWaitingMessage,
	createCapacityWait,
} from "../../hooks/capacity-wait";
import { doclingWebAdapter } from "./toolchain-adapter";

const origin = "http://localhost:28765";
const status = { revision: 1, configured: true, publicOrigin: origin };
const busy = (retryAfterMs?: number) =>
	new ApiError(503, "larm_capacity_busy", undefined, undefined, {
		error: "larm_capacity_busy",
		...(retryAfterMs ? { retryAfterMs } : {}),
	});

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

async function mount(ready: () => Promise<typeof status>) {
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	const client = {
		identity: "http://127.0.0.1:4444",
		doclingStatus: vi.fn(async () => status),
		doclingReady: vi.fn(ready),
		doclingTicket: vi.fn(),
	};
	cache.setQueryData([queryRoots.docling, client.identity, "status"], status);
	const context = {
		client,
		artifact: {
			sourceBindings: [
				{ query: "query:docling.launcher@1", source: "launcher" },
			],
		},
	} as unknown as AdapterHostContext;
	const hook = renderHook(
		(c: AdapterHostContext) => doclingWebAdapter.useArtifact(c),
		{
			initialProps: context,
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={cache}>{children}</QueryClientProvider>
			),
		},
	);
	const advance = (ms: number) =>
		act(async () => {
			await vi.advanceTimersByTimeAsync(ms);
		});
	await advance(0);
	const launcher = () =>
		hook.result.current.snapshot.launcher as unknown as {
			available: boolean;
			preparing: boolean;
			busy: boolean;
			error?: string;
		};
	return { client, hook, advance, launcher };
}

test("a capacity refusal waits with one timer, sends the same request after the wait, and then opens", async () => {
	let refused = true;
	const h = await mount(async () => {
		if (refused) throw busy(90_000);
		return status;
	});
	expect(h.client.doclingReady).toHaveBeenCalledTimes(1);
	// The retry button exists with the message, but the launcher is "preparing" so it is disabled.
	expect(h.launcher()).toMatchObject({
		available: false,
		preparing: true,
		error: capacityWaitingMessage,
	});
	await h.advance(89_000);
	expect(h.client.doclingReady).toHaveBeenCalledTimes(1);
	// An explicit status refresh elsewhere does not add a second request.
	refused = false;
	await h.advance(1_000);
	expect(h.client.doclingReady).toHaveBeenCalledTimes(2);
	expect(h.launcher()).toMatchObject({ available: true, preparing: false });
	expect(h.launcher().error).toBeUndefined();
	await h.advance(600_000);
	expect(h.client.doclingReady).toHaveBeenCalledTimes(2);
});

test("a refusal without Retry-After is sent again after 30 s, never earlier", async () => {
	const h = await mount(async () => {
		throw busy();
	});
	await h.advance(29_999);
	expect(h.client.doclingReady).toHaveBeenCalledTimes(1);
	await h.advance(1);
	expect(h.client.doclingReady).toHaveBeenCalledTimes(2);
});

test("closing the artifact stops the timer: nothing is sent afterwards", async () => {
	const h = await mount(async () => {
		throw busy();
	});
	expect(h.client.doclingReady).toHaveBeenCalledTimes(1);
	h.hook.unmount();
	await h.advance(10 * 60_000);
	expect(h.client.doclingReady).toHaveBeenCalledTimes(1);
});

test("after 30 minutes from the first refusal it stops, shows the timeout and re-enables the manual retry", async () => {
	const h = await mount(async () => {
		throw busy();
	});
	for (let i = 0; i < 60; i++) await h.advance(30_000);
	// Tries at 0, 30, ..., 1800 s; the next would pass the limit.
	expect(h.client.doclingReady).toHaveBeenCalledTimes(61);
	expect(h.launcher()).toMatchObject({
		available: false,
		preparing: false,
		error: capacityTimeoutMessage,
	});
	await h.advance(10 * 60_000);
	expect(h.client.doclingReady).toHaveBeenCalledTimes(61);
	// The explicit retry counts a new wait.
	act(() => h.hook.result.current.refresh());
	await h.advance(0);
	expect(h.client.doclingReady).toHaveBeenCalledTimes(62);
});

test("a failure that is not the capacity refusal is shown at once and never sent again", async () => {
	const h = await mount(async () => {
		throw new Error("docling_auth_failed");
	});
	await h.advance(10 * 60_000);
	expect(h.client.doclingReady).toHaveBeenCalledTimes(1);
	expect(h.launcher()).toMatchObject({ preparing: false });
	expect(h.launcher().error).toContain("認証");
});

test("the wait keeps at most one timer, and the limit counts from the first refusal", () => {
	let now = 0;
	const sent = vi.fn();
	const wait = createCapacityWait({ clock: () => now });
	expect(wait.refuse(null, sent)).toBe("waiting");
	expect(wait.refuse(null, sent)).toBe("waiting");
	now = 29_999;
	vi.advanceTimersByTime(29_999);
	expect(sent).not.toHaveBeenCalled();
	vi.advanceTimersByTime(1);
	expect(sent).toHaveBeenCalledTimes(1);
	now = 30 * 60_000 - 1;
	expect(wait.refuse(null, sent)).toBe("expired");
	expect(wait.waiting()).toBe(false);
});
