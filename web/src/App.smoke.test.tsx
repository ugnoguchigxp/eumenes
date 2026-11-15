import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { ApiError } from "../../client";
import { settingsFixture } from "./domains/settings/sections/fixture";

// App builds its own client; every call goes to this in-memory stand-in.
const api = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../../client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../client")>()),
	createClient: () => api.current,
}));
import { App } from "./App";

function mockClient(overrides: Record<string, unknown> = {}) {
	const calls: Record<string, ReturnType<typeof vi.fn>> = {};
	const known: Record<string, unknown> = {
		identity: "smoke",
		settings: async () => settingsFixture(),
		conversation: async () => ({ id: "main", revision: 0, messages: [] }),
		runs: async () => [],
		status: async () => ({
			phase: "ready",
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
		larmProfiles: async () => [],
		memoryStatus: async () => ({ enabled: false }),
		...overrides,
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
test("a rejected chat submission shows a copyable diagnostic in the chat history", async () => {
	const writeText = vi.fn(async () => {});
	vi.stubGlobal(
		"navigator",
		Object.assign(Object.create(navigator), {
			clipboard: { writeText },
		}),
	);
	const requestId = crypto.randomUUID();
	const submit = vi.fn(async () => {
		throw new ApiError(
			503,
			"fixture_submit_failed",
			requestId,
			"private provider detail",
		);
	});
	api.current = mockClient({ submit });
	const { container } = render(<App />);
	const textbox = await screen.findByRole("textbox", { name: "メッセージ" });
	fireEvent.change(textbox, { target: { value: "送信内容の確認" } });
	fireEvent.click(screen.getByRole("button", { name: "送信" }));
	const failure = await screen.findByRole("article", { name: "会話エラー" });
	expect(container.querySelector(".chat-history")?.contains(failure)).toBe(
		true,
	);
	expect(container.querySelector(".chat-error")).toBeNull();
	fireEvent.click(
		within(failure).getByRole("button", { name: "エラーの詳細" }),
	);
	const report = await screen.findByLabelText("エラーレポート本文");
	expect(report.textContent).toContain("エラーコード: fixture_submit_failed");
	expect(report.textContent).toContain(`X-Request-Id: ${requestId}`);
	expect(report.textContent).not.toMatch(
		/private provider detail|送信内容の確認/,
	);
	fireEvent.click(screen.getByRole("button", { name: "レポートをコピー" }));
	expect(writeText).toHaveBeenCalledWith(report.textContent);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	window.location.hash = "";
});

test("A01 boot: the conversation screen renders without a settings button", async () => {
	render(<App />);
	expect(await screen.findByRole("region", { name: "会話" })).toBeTruthy();
	expect(
		screen.queryByRole("separator", {
			name: "会話とアーティファクトのサイズを調整",
		}),
	).toBeNull();
	expect(
		(screen.getByRole("textbox", { name: "メッセージ" }) as HTMLTextAreaElement)
			.disabled,
	).toBe(false);
	expect(screen.getByRole("button", { name: "音声を開始" })).toBeTruthy();
	await waitFor(() =>
		expect(screen.getByLabelText("LARMの接続状態: 接続済み")).toBeTruthy(),
	);

	expect(screen.queryByRole("button", { name: "設定" })).toBeNull();
});
