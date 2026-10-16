import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { settingsFixture } from "./domains/settings/sections/fixture";

const api = vi.hoisted(() => ({
	current: null as unknown,
	state: "connected" as string,
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
		reconnectChanges: () => {},
		settingsDiagnostics: async () => ({}),
		inferenceProbes: async () => [],
		larmDetails: async () => null,
		larmProfiles: async () => [],
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

test("the workspace renders without the editor loading fallback", async () => {
	render(<App />);
	expect(await screen.findByRole("main")).toBeTruthy();
	expect(screen.queryByText("編集画面を読み込み中です。")).toBeNull();
});

test("only a drawing location waits behind the editor loading fallback", () => {
	window.location.hash = "#drawing/new/22222222-2222-4222-8222-222222222222";
	render(<App />);
	expect(screen.getByText("編集画面を読み込み中です。")).toBeTruthy();
	expect(screen.queryByRole("main")).toBeNull();
});
