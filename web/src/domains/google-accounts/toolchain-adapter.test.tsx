import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { PropsWithChildren } from "react";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";
import { googleAccountsWebAdapter } from "./toolchain-adapter";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
function setup() {
	const state = {
		configured: true,
		status: "disconnected",
		revision: 0,
		pending: false,
	};
	const client = {
		identity: crypto.randomUUID(),
		toolchainArtifactSource: vi.fn(async () => ({ data: state })),
		connectGoogleAccount: vi.fn(async () => {
			state.pending = true;
			state.revision++;
			return { url: "https://accounts.google.com/test" };
		}),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const context = {
		client,
		artifactRevisionId: "artifact:settings.google-accounts@1",
		visible: true,
		artifact: { sourceBindings: [{ source: "google" }] },
	} as unknown as AdapterHostContext;
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const hook = renderHook(() => googleAccountsWebAdapter.useArtifact(context), {
		wrapper,
	});
	return { hook, client, cache };
}
test("popup opening failures leave an authorization link and do not lock the controls", async () => {
	const h = setup();
	vi.spyOn(window, "open").mockImplementation(() => {
		throw new Error("browser_blocked");
	});
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	await act(async () => {
		const receipt = await h.hook.result.current.local(
			{ eventAction: "google-connect" } as never,
			{ revision: 0 } as never,
		);
		expect(receipt.status).toBe("accepted");
	});
	expect(h.client.connectGoogleAccount).toHaveBeenCalledOnce();
	expect(h.hook.result.current.snapshot.google).toMatchObject({
		busy: false,
		pending: true,
		authorizationUrl: "https://accounts.google.com/test",
	});
	h.cache.clear();
});
test("a failed status refresh shows an error instead of presenting cached data as current", async () => {
	const h = setup();
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	h.client.toolchainArtifactSource.mockRejectedValue(new Error("offline"));
	await act(async () => {
		await h.cache.invalidateQueries();
	});
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("error"));
	h.client.toolchainArtifactSource.mockResolvedValue({
		data: {
			configured: true,
			status: "connected",
			revision: 1,
			pending: false,
		},
	});
	await act(async () => {
		await h.cache.invalidateQueries();
	});
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	h.cache.clear();
});
