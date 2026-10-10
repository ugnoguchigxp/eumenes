import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { settingsFixture } from "./domains/settings/sections/fixture";

// App builds its own client; every call goes to this in-memory stand-in.
const api = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../../client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../client")>()),
	createClient: () => api.current,
}));
import { App } from "./App";

function mockClient() {
	const calls: Record<string, ReturnType<typeof vi.fn>> = {};
	const known: Record<string, unknown> = {
		identity: "smoke",
		settings: async () => settingsFixture(),
		conversation: async () => ({ id: "main", revision: 0, messages: [] }),
		runs: async () => [],
		status: async () => ({
			larm: { state: "ready", error: null },
		}),
		inferenceUsage: async () => [],
		timerNotifications: async () => ({
			serverNow: new Date().toISOString(),
			items: [],
			nextCursor: null,
		}),
		subscribeChanges: () => () => {},
		subscribeChangesState: () => () => {},
		changesState: () => "open",
		reconnectChanges: () => {},
		settingsDiagnostics: async () => ({}),
		inferenceProbes: async () => [],
		larmDetails: async () => null,
		memoryStatus: async () => ({ enabled: false }),
	};
	return new Proxy(known, {
		get(target, key: string) {
			if (key in target) {
				const value = target[key];
				if (typeof value !== "function") return value;
				return (calls[key] ??= vi.fn(value as (...a: unknown[]) => unknown));
			}
			// Anything this smoke test does not stub fails loudly at its call site.
			return (calls[key] ??= vi.fn(async () => {
				throw new Error(`client.${key} is not stubbed`);
			}));
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
	vi.unstubAllGlobals();
	window.location.hash = "";
});

test("A01 boot: the conversation screen renders and the settings button switches screens", async () => {
	render(<App />);
	expect(await screen.findByRole("region", { name: "会話" })).toBeTruthy();
	expect(
		(screen.getByRole("textbox", { name: "メッセージ" }) as HTMLTextAreaElement)
			.disabled,
	).toBe(false);
	expect(screen.getByRole("button", { name: "音声を開始" })).toBeTruthy();
	await waitFor(() =>
		expect(screen.getByLabelText("LARMの接続状態: 接続済み")).toBeTruthy(),
	);

	fireEvent.click(screen.getByRole("button", { name: "設定" }));
	expect(
		await screen.findByRole("navigation", { name: "設定カテゴリ" }),
	).toBeTruthy();
	expect(screen.getByRole("button", { name: "会話に戻る" })).toBeTruthy();
});
