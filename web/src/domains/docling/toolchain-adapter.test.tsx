import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";
import { changeRoots } from "../../queryKeys";
import { doclingWebAdapter } from "./toolchain-adapter";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const origin = "http://localhost:28765";
const status = (revision = 1, configured = true) => ({
	revision,
	configured,
	publicOrigin: origin,
});
function fixture() {
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	let resolve!: (v: { url: string; expiresIn: number }) => void;
	let signal: AbortSignal | undefined;
	const client = {
		identity: "http://127.0.0.1:4444",
		doclingStatus: vi.fn(async () => status()),
		doclingTicket: vi.fn((s: AbortSignal) => {
			signal = s;
			return new Promise<{ url: string; expiresIn: number }>((r) => {
				resolve = r;
			});
		}),
	};
	const tab = {
		opener: {},
		closed: false,
		location: { replace: vi.fn() },
		close: vi.fn(),
	};
	vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
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
	const start = () => {
		let pending!: ReturnType<typeof hook.result.current.local>;
		act(() => {
			pending = hook.result.current.local(
				{ eventAction: "external-app-open" } as never,
				{} as never,
			);
		});
		return pending;
	};
	const finish = () =>
		resolve({
			url: `${origin}/auth/exchange?ticket=${"t".repeat(43)}`,
			expiresIn: 60,
		});
	return {
		cache,
		client,
		context,
		tab,
		hook,
		start,
		finish,
		signal: () => signal,
	};
}

test("saved configuration changes refresh the launcher through the existing change event roots", async () => {
	const h = fixture();
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	const root = h.cache.getQueryCache().getAll()[0]!.queryKey[0];
	expect(changeRoots).toContain(root);
	h.client.doclingStatus.mockResolvedValue(status(2, false));
	await act(async () => {
		await Promise.all(
			changeRoots.map((r) => h.cache.invalidateQueries({ queryKey: [r] })),
		);
	});
	await waitFor(() =>
		expect(h.hook.result.current.snapshot.launcher).toMatchObject({
			revision: 2,
			available: false,
		}),
	);
	expect(h.client.doclingTicket).not.toHaveBeenCalled();
	h.hook.unmount();
	h.cache.clear();
});

test("unchanged configuration refresh keeps the single startup request and an opened tab survives unmount", async () => {
	const h = fixture();
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	const pending = h.start();
	await act(async () => {
		await h.cache.invalidateQueries();
	});
	expect(h.signal()?.aborted).toBe(false);
	await expect(h.start()).resolves.toMatchObject({ status: "rejected" });
	expect(window.open).toHaveBeenCalledOnce();
	expect(h.client.doclingTicket).toHaveBeenCalledOnce();
	await act(async () => {
		h.finish();
		expect(await pending).toMatchObject({ status: "accepted" });
	});
	h.hook.unmount();
	expect(h.tab.location.replace).toHaveBeenCalledOnce();
	expect(h.tab.close).not.toHaveBeenCalled();
	h.cache.clear();
});

test.each(["settings", "client", "credentials", "unmount"])(
	"%s change cancels the old tab and discards a late ticket",
	async (change) => {
		const h = fixture();
		await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
		const pending = h.start();
		expect(h.client.doclingTicket).toHaveBeenCalledOnce();
		if (change === "settings") {
			await act(async () => {
				h.client.doclingStatus.mockResolvedValue(status(2));
				await h.cache.invalidateQueries();
			});
		} else if (change === "client") {
			h.hook.rerender({
				...h.context,
				client: { ...h.context.client, identity: "http://127.0.0.1:5555" },
			});
		} else if (change === "credentials") {
			h.hook.rerender({ ...h.context, client: { ...h.context.client } });
		} else h.hook.unmount();
		await waitFor(() => expect(h.signal()?.aborted).toBe(true));
		expect(h.tab.close).toHaveBeenCalled();
		await act(async () => {
			h.finish();
			await pending;
		});
		expect(h.tab.location.replace).not.toHaveBeenCalled();
		h.hook.unmount();
		h.cache.clear();
	},
);
