import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { settingsFixture } from "./domains/settings/sections/fixture";

const api = vi.hoisted(() => ({
	current: null as unknown,
	state: "connected" as string,
	reconnect: null as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock("../../client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../client")>()),
	createClient: () => api.current,
}));
import { App } from "./App";

function mockClient() {
	const known: Record<string, unknown> = {
		identity: "focus",
		settings: async () => settingsFixture(),
		conversation: async () => ({ id: "main", revision: 0, messages: [] }),
		runs: async () => [],
		status: async () => ({ larm: { state: "ready", error: null } }),
		inferenceUsage: async () => [],
		timerNotifications: async () => ({
			serverNow: new Date().toISOString(),
			items: [],
			nextCursor: null,
		}),
		subscribeChanges: () => () => {},
		subscribeChangesState: () => () => {},
		changesState: () => api.state,
		reconnectChanges: api.reconnect,
		settingsDiagnostics: async () => ({}),
		inferenceProbes: async () => [],
		larmDetails: async () => null,
		memoryStatus: async () => ({ enabled: false }),
	};
	return new Proxy(known, {
		get: (target, key: string) =>
			key in target
				? target[key]
				: async () => {
						throw new Error(`client.${key} is not stubbed`);
					},
	});
}

beforeEach(() => {
	api.reconnect = vi.fn();
	api.current = mockClient();
	window.location.hash = "";
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
		})),
	);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("window focus never reconnects a live change stream", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	api.state = "connected";
	render(<App />);
	fireEvent.focus(window);
	await vi.advanceTimersByTimeAsync(200);
	expect(api.reconnect).not.toHaveBeenCalled();
});

test("window focus reconnects a failed change stream once after 100 ms", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	api.state = "failed";
	render(<App />);
	fireEvent.focus(window);
	await vi.advanceTimersByTimeAsync(99);
	expect(api.reconnect).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(api.reconnect).toHaveBeenCalledTimes(1);
});
