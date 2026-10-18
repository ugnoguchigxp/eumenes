import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "../../../../client/transport";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";

const api = vi.hoisted(() => ({
	setting: vi.fn(async () => "/Applications/Brave/brave"),
	saveSetting: vi.fn(async (path: string) => path),
	tabs: vi.fn(async () => [] as unknown[]),
}));
vi.mock("./api", () => ({ browserApiFor: () => api }));

import { BROWSER_ADAPTER_REF, browserWebAdapter } from "./toolchain-adapter";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const connection = (state: string, over: Record<string, unknown> = {}) => ({
	state,
	endReason: null,
	configured: true,
	availability:
		state === "connected"
			? { available: true }
			: { available: false, reason: "browser_disconnected" },
	...over,
});
const sourceOf = (state: string, over: Record<string, unknown> = {}) => ({
	revision: 4,
	data: {
		connection: connection(state),
		tabs: [
			{
				tabRef: "t1",
				title: "Eumenes",
				url: "http://127.0.0.1:5173/",
				active: true,
				status: "idle",
			},
		],
		tasks: [],
		captures: [],
		...over,
	},
});

function setup(read: () => Promise<unknown>) {
	const client = {
		identity: crypto.randomUUID(),
		toolchainArtifactSource: vi.fn(read),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const context = {
		client,
		artifactRevisionId: "artifact:browser.workspace@1",
		visible: true,
	} as unknown as AdapterHostContext;
	const hook = renderHook(() => browserWebAdapter.useArtifact(context), {
		wrapper: ({ children }: PropsWithChildren) => (
			<QueryClientProvider client={cache}>{children}</QueryClientProvider>
		),
	});
	return { client, hook, cache };
}
const event = (action: string, values: Record<string, string | boolean>) => ({
	id: "e1",
	source: "browser",
	revision: 0,
	action: action as never,
	values,
});

test("is registered for the browser adapter and serves the browser snapshot", async () => {
	const { hook, client } = setup(async () => sourceOf("disconnected"));
	expect(browserWebAdapter.adapterRef).toBe(BROWSER_ADAPTER_REF);
	expect(BROWSER_ADAPTER_REF).toBe("adapter:browser@1");
	expect(hook.result.current.phase.kind).toBe("loading");
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	expect(client.toolchainArtifactSource).toHaveBeenCalledWith(
		"artifact:browser.workspace@1",
		"browser",
		undefined,
		expect.anything(),
	);
	await waitFor(() =>
		expect(hook.result.current.snapshot.browser).toMatchObject({
			kind: "browser",
			connection: { state: "disconnected" },
			executablePath: "/Applications/Brave/brave",
		}),
	);
	expect(hook.result.current.targetOf("browser")).toBeUndefined();
});

test("reads the tabs from Brave again only while connected", async () => {
	const idle = setup(async () => sourceOf("disconnected"));
	await waitFor(() =>
		expect(idle.hook.result.current.phase.kind).toBe("ready"),
	);
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(api.tabs).not.toHaveBeenCalled();
	cleanup();
	api.tabs.mockResolvedValue([
		{
			tabRef: "fresh",
			title: "Opened",
			url: "https://example.com/",
			active: false,
			status: "idle",
		},
	]);
	const live = setup(async () => sourceOf("connected"));
	await waitFor(() =>
		expect(
			(
				live.hook.result.current.snapshot.browser as unknown as {
					tabs: Array<{ tabRef: string }>;
				}
			).tabs.map((t) => t.tabRef),
		).toEqual(["fresh"]),
	);
});

test("saving the path goes to the browser API and the source is read again", async () => {
	const { hook, client } = setup(async () => sourceOf("disconnected"));
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	const before = client.toolchainArtifactSource.mock.calls.length;
	const saved = await hook.result.current.local(
		{} as never,
		event("browser-save-path", { path: "/Applications/Brave/brave2" }),
	);
	expect(saved).toMatchObject({ status: "accepted" });
	expect(api.saveSetting).toHaveBeenCalledWith("/Applications/Brave/brave2");
	await waitFor(() =>
		expect(client.toolchainArtifactSource.mock.calls.length).toBeGreaterThan(
			before,
		),
	);
});

test("a path the backend refuses is explained, and other events are not local", async () => {
	const { hook } = setup(async () => sourceOf("disconnected"));
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	api.saveSetting.mockRejectedValueOnce(
		new ApiError(400, "invalid_browser_setting"),
	);
	expect(
		await hook.result.current.local(
			{} as never,
			event("browser-save-path", { path: "relative/brave" }),
		),
	).toMatchObject({
		status: "rejected",
		message: expect.stringContaining("絶対パス"),
	});
	// A path that is no executable file gets its own explanation.
	api.saveSetting.mockRejectedValueOnce(
		new ApiError(400, "browser_executable_invalid"),
	);
	expect(
		await hook.result.current.local(
			{} as never,
			event("browser-save-path", { path: "/no/such/brave" }),
		),
	).toMatchObject({
		status: "rejected",
		message: expect.stringContaining("実行できるファイルが見つかりません"),
	});
	expect(
		await hook.result.current.local({} as never, event("browser-connect", {})),
	).toMatchObject({ status: "rejected" });
	expect(
		await hook.result.current.local({} as never, {
			...event("browser-save-path", { path: "/x" }),
			source: "other",
		}),
	).toMatchObject({ status: "rejected" });
});

test("an unreadable source is shown as an error", async () => {
	const { hook } = setup(async () => {
		throw new Error("source_failed");
	});
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("error"));
});

test("domain refusals are worded for the screen and others fall back to the host", async () => {
	const { hook } = setup(async () => sourceOf("disconnected"));
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	const describe = hook.result.current.describeRejection!;
	expect(describe("browser_not_configured", [])).toContain("パス");
	expect(describe("tab_lost", [])).toContain("タブ");
	expect(describe("tab_blocked", [])).toContain("開けないページ");
	expect(describe("something_else", [])).toBeUndefined();
	expect(describe(undefined, [])).toBeUndefined();
});
