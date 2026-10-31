import {
	focusManager,
	onlineManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../../client";
import type { MonitoringSnapshot } from "../../../../api/domains/monitoring/contracts";
import { useMonitoringItems } from ".";
import { STALE_AFTER_MS } from "./items";
import {
	emptyLarm,
	larmViewSchema,
} from "../../../../api/domains/monitoring/contracts/larm";

const snapshot: MonitoringSnapshot = {
	observedAt: 1000,
	items: [
		{
			id: "eumenes-backend",
			shape: "network",
			label: "Eumenes Backend",
			state: { health: "healthy", activity: "idle", utilization: 0 },
		},
	],
};
const caches: QueryClient[] = [];
afterEach(() => {
	cleanup();
	for (const cache of caches) cache.clear();
	caches.length = 0;
	vi.useRealTimers();
	vi.restoreAllMocks();
	focusManager.setFocused(undefined);
	onlineManager.setOnline(true);
});
async function advance(ms = 1) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}
function setup(visible = true, enabled = true) {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
	let visibility: DocumentVisibilityState = visible ? "visible" : "hidden";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(
		() => visibility,
	);
	const monitoringSnapshot = vi.fn(async (_signal?: AbortSignal) => snapshot);
	const client = {
		identity: "monitoring-test",
		monitoringSnapshot,
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	caches.push(cache);
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const hook = renderHook(
		({ enabled }) => useMonitoringItems(client, enabled),
		{
			wrapper,
			initialProps: { enabled },
		},
	);
	return {
		...hook,
		monitoringSnapshot,
		visible(value: boolean) {
			visibility = value ? "visible" : "hidden";
			act(() => document.dispatchEvent(new Event("visibilitychange")));
		},
	};
}
const backend = (items: ReturnType<typeof useMonitoringItems>) =>
	items?.find((i) => i.model === "backend")?.state;

test("Spatial reads immediately and once a minute, then stops when disabled", async () => {
	const h = setup();
	await advance();
	expect(backend(h.result.current)?.utilization).toBe(0);
	expect(h.monitoringSnapshot).toHaveBeenCalledTimes(1);
	await advance(60_000);
	expect(h.monitoringSnapshot).toHaveBeenCalledTimes(2);
	h.rerender({ enabled: false });
	await advance(120_000);
	expect(h.monitoringSnapshot).toHaveBeenCalledTimes(2);
	expect(h.result.current).toBeUndefined();
});

test("an initially hidden Spatial does not fetch; visibility starts and stops polling", async () => {
	const h = setup(false);
	await advance(60_000);
	expect(h.monitoringSnapshot).not.toHaveBeenCalled();
	h.visible(true);
	await advance();
	expect(h.monitoringSnapshot).toHaveBeenCalledTimes(1);
	h.visible(false);
	await advance(120_000);
	expect(h.monitoringSnapshot).toHaveBeenCalledTimes(1);
	h.visible(true);
	await advance();
	expect(h.monitoringSnapshot).toHaveBeenCalledTimes(2);
});

test("focus, reconnect and returning to Spatial reuse a sample younger than one minute", async () => {
	const h = setup();
	await advance();
	await advance(10_000);
	act(() => focusManager.setFocused(false));
	act(() => focusManager.setFocused(true));
	act(() => onlineManager.setOnline(false));
	act(() => onlineManager.setOnline(true));
	await advance();
	expect(h.monitoringSnapshot).toHaveBeenCalledTimes(1);
	h.visible(false);
	await advance(10_000);
	h.visible(true);
	await advance();
	expect(h.monitoringSnapshot).toHaveBeenCalledTimes(1);
	h.rerender({ enabled: false });
	await advance(10_000);
	h.rerender({ enabled: true });
	await advance();
	expect(h.monitoringSnapshot).toHaveBeenCalledTimes(1);
	await advance(60_000);
	expect(h.monitoringSnapshot).toHaveBeenCalledTimes(2);
});

test("a stalled read ages the last snapshot; a failure disconnects and a later read recovers", async () => {
	const h = setup();
	await advance();
	h.monitoringSnapshot.mockImplementationOnce(() => new Promise(() => {}));
	await advance(STALE_AFTER_MS + 30_000);
	expect(backend(h.result.current)?.stale).toBe(true);
	h.unmount();
	const recovery = setup();
	await advance();
	recovery.monitoringSnapshot.mockRejectedValueOnce(new Error("offline"));
	await advance(60_001);
	expect(backend(recovery.result.current)).toMatchObject({
		health: "disconnected",
		stale: true,
	});
	await advance(60_001);
	expect(backend(recovery.result.current)).toMatchObject({
		health: "healthy",
		stale: false,
	});
});

test("returning to an old cached snapshot marks it stale while its new read is pending", async () => {
	const h = setup();
	await advance();
	h.rerender({ enabled: false });
	await advance(STALE_AFTER_MS + 1);
	h.monitoringSnapshot.mockImplementationOnce(() => new Promise(() => {}));
	h.rerender({ enabled: true });
	expect(backend(h.result.current)?.stale).toBe(true);
});

test("a valid LARM sample stays normal between minute polls without adding requests", async () => {
	const h = setup(false);
	const larm = larmViewSchema.parse({
		...emptyLarm(1000000),
		snapshotReceivedAt: 1000000,
		snapshotStatus: { status: "ok", at: 1000000 },
		eventsStatus: { status: "ok", at: 1000000 },
		history: {
			hasMore: false,
			coverageComplete: false,
			events: [],
			faults: [],
			results: {
				succeeded: "0",
				failed: "0",
				timed_out: "0",
				cancelled: "0",
				rejected: "0",
			},
		},
	});
	h.monitoringSnapshot.mockResolvedValue({
		observedAt: 1000000,
		larm,
		items: [
			{
				id: "larm-cpu",
				shape: "larm-cpu",
				label: "LARM CPU",
				state: {
					health: "healthy",
					activity: "idle",
					observations: [
						{ status: "ok", observedAt: 1000000, ageMs: 0, maxAgeMs: 10000 },
					],
				},
			},
		],
	});
	h.visible(true);
	await advance();
	expect(
		h.result.current?.find((i) => i.model === "larm-cpu")?.state.stale,
	).toBe(false);
	await advance(11000);
	expect(
		h.result.current?.find((i) => i.model === "larm-cpu")?.state.stale,
	).toBe(false);
	expect(h.monitoringSnapshot).toHaveBeenCalledTimes(1);
});
