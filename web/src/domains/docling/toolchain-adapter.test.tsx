import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { StrictMode, type ReactNode } from "react";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";
import { changeRoots, queryRoots } from "../../queryKeys";
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
function fixture(
	mode?: "pending" | "failed" | "unconfigured" | "status-failed",
	strict = false,
) {
	let resolveReady!: (value: ReturnType<typeof status>) => void;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	let resolve!: (v: { url: string; expiresIn: number }) => void;
	let signal: AbortSignal | undefined;
	const client = {
		identity: "http://127.0.0.1:4444",
		doclingStatus: vi.fn(async () => {
			if (mode === "status-failed") throw new Error("api_connection_failed");
			return mode === "unconfigured" ? status(2, false) : status();
		}),
		doclingReady: vi.fn((_signal: AbortSignal) => {
			if (mode === "pending")
				return new Promise<ReturnType<typeof status>>((resolve) => {
					resolveReady = resolve;
				});
			if (mode === "failed")
				return Promise.reject(new Error("docling_auth_failed"));
			return Promise.resolve(status());
		}),
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
	if (strict)
		cache.setQueryData(
			[queryRoots.docling, client.identity, "status"],
			status(),
		);
	const Provider = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const hook = renderHook(
		(c: AdapterHostContext) => doclingWebAdapter.useArtifact(c),
		{
			initialProps: context,
			wrapper: ({ children }: { children: ReactNode }) =>
				strict ? (
					<StrictMode>
						<Provider>{children}</Provider>
					</StrictMode>
				) : (
					<Provider>{children}</Provider>
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
		finishReady: (value = status()) => resolveReady(value),
	};
}

test("saved configuration changes refresh the launcher through the existing change event roots", async () => {
	const h = fixture();
	await waitFor(() =>
		expect(h.hook.result.current.snapshot.launcher).toMatchObject({
			available: true,
		}),
	);
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
	expect(h.client.doclingReady).toHaveBeenCalledOnce();
	h.hook.unmount();
	h.cache.clear();
});

test("unchanged configuration refresh keeps the single startup request and an opened tab survives unmount", async () => {
	const h = fixture();
	await waitFor(() =>
		expect(h.hook.result.current.snapshot.launcher).toMatchObject({
			available: true,
		}),
	);
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
		await waitFor(() =>
			expect(h.hook.result.current.snapshot.launcher).toMatchObject({
				available: true,
			}),
		);
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

test("artifact requests startup once, stays disabled until ready, and never opens a tab automatically", async () => {
	const h = fixture("pending");
	await waitFor(() => expect(h.client.doclingReady).toHaveBeenCalledOnce());
	expect(h.hook.result.current.snapshot.launcher).toMatchObject({
		available: false,
		preparing: true,
	});
	await expect(h.start()).resolves.toMatchObject({ status: "rejected" });
	expect(window.open).not.toHaveBeenCalled();
	expect(h.client.doclingTicket).not.toHaveBeenCalled();
	await act(async () => {
		await h.cache.invalidateQueries();
	});
	expect(h.client.doclingReady).toHaveBeenCalledOnce();
	await act(async () => {
		h.finishReady();
	});
	await waitFor(() =>
		expect(h.hook.result.current.snapshot.launcher).toMatchObject({
			available: true,
			preparing: false,
		}),
	);
	expect(window.open).not.toHaveBeenCalled();
	expect(
		JSON.stringify(
			h.cache
				.getQueryCache()
				.getAll()
				.map((q) => q.state.data),
		),
	).not.toContain("ticket");
	h.hook.unmount();
	h.cache.clear();
});

test("failed startup leaves open disabled and retries only on an explicit refresh", async () => {
	const h = fixture("failed");
	await waitFor(() =>
		expect(h.hook.result.current.snapshot.launcher).toMatchObject({
			available: false,
			preparing: false,
			error: expect.stringContaining("認証"),
		}),
	);
	await expect(h.start()).resolves.toMatchObject({ status: "rejected" });
	await act(async () => {
		await h.cache.invalidateQueries();
	});
	expect(h.client.doclingReady).toHaveBeenCalledOnce();
	h.client.doclingReady.mockResolvedValue(status());
	act(() => h.hook.result.current.refresh());
	await waitFor(() =>
		expect(h.hook.result.current.snapshot.launcher).toMatchObject({
			available: true,
		}),
	);
	expect(h.client.doclingReady).toHaveBeenCalledTimes(2);
	expect(window.open).not.toHaveBeenCalled();
	h.hook.unmount();
	h.cache.clear();
});

test.each(["settings", "client", "credentials", "unmount"])(
	"%s change discards late startup readiness",
	async (change) => {
		const h = fixture("pending");
		await waitFor(() => expect(h.client.doclingReady).toHaveBeenCalledOnce());
		const oldSignal = h.client.doclingReady.mock.calls[0]![0];
		const oldFinish = h.finishReady;
		// Capture the resolver of the old request before a replacement can be created.
		const response = Promise.withResolvers<ReturnType<typeof status>>();
		h.client.doclingReady.mockImplementation(() => response.promise);
		if (change === "settings") {
			h.client.doclingStatus.mockResolvedValue(status(2));
			await act(async () => {
				await h.cache.invalidateQueries();
			});
		} else if (change === "client" || change === "credentials") {
			h.hook.rerender({
				...h.context,
				client: {
					...h.context.client,
					...(change === "client" ? { identity: "other" } : {}),
				},
			});
		} else h.hook.unmount();
		await waitFor(() => expect(oldSignal.aborted).toBe(true));
		await act(async () => {
			oldFinish();
		});
		if (change !== "unmount")
			expect(h.hook.result.current.snapshot.launcher).toMatchObject({
				available: false,
			});
		expect(window.open).not.toHaveBeenCalled();
		h.hook.unmount();
		h.cache.clear();
	},
);

test("unconfigured artifacts do not request startup", async () => {
	const h = fixture("unconfigured");
	await act(async () => {
		await h.cache.invalidateQueries();
	});
	await waitFor(() =>
		expect(h.hook.result.current.snapshot.launcher).toMatchObject({
			available: false,
		}),
	);
	expect(h.client.doclingReady).not.toHaveBeenCalled();
	h.hook.unmount();
	h.cache.clear();
});

test("StrictMode with cached settings requests startup only once", async () => {
	const h = fixture(undefined, true);
	await waitFor(() =>
		expect(h.hook.result.current.snapshot.launcher).toMatchObject({
			available: true,
		}),
	);
	expect(h.client.doclingReady).toHaveBeenCalledOnce();
	expect(window.open).not.toHaveBeenCalled();
	h.hook.unmount();
	h.cache.clear();
});

test("a failed configuration read offers retry and recovers without reopening the artifact", async () => {
	const h = fixture("status-failed");
	try {
		await waitFor(() =>
			expect(h.hook.result.current.snapshot.launcher).toMatchObject({
				available: false,
				error: expect.stringContaining("接続情報"),
			}),
		);
		expect(h.hook.result.current.phase.kind).toBe("ready");
		expect(h.client.doclingReady).not.toHaveBeenCalled();
		h.client.doclingStatus.mockResolvedValue(status());
		act(() => h.hook.result.current.refresh());
		await waitFor(() =>
			expect(h.hook.result.current.snapshot.launcher).toMatchObject({
				available: true,
			}),
		);
		expect(h.client.doclingReady).toHaveBeenCalledOnce();
	} finally {
		h.hook.unmount();
		h.cache.clear();
	}
});

test("explicit retry reads the latest settings before issuing a new startup request", async () => {
	const h = fixture("failed");
	try {
		await waitFor(() =>
			expect(h.hook.result.current.snapshot.launcher).toMatchObject({
				error: expect.any(String),
			}),
		);
		const read = Promise.withResolvers<ReturnType<typeof status>>();
		h.client.doclingStatus.mockImplementation(() => read.promise);
		h.client.doclingReady.mockResolvedValue(status(2));
		act(() => h.hook.result.current.refresh());
		await waitFor(() =>
			expect(h.client.doclingStatus).toHaveBeenCalledTimes(2),
		);
		expect(h.client.doclingReady).toHaveBeenCalledOnce();
		await act(async () => {
			read.resolve(status(2));
		});
		await waitFor(() =>
			expect(h.hook.result.current.snapshot.launcher).toMatchObject({
				revision: 2,
				available: true,
			}),
		);
		expect(h.client.doclingReady).toHaveBeenCalledTimes(2);
	} finally {
		h.hook.unmount();
		h.cache.clear();
	}
});

test("a failed retry read remains retryable after an unchanged background read recovers", async () => {
	const h = fixture("failed");
	try {
		await waitFor(() =>
			expect(h.hook.result.current.snapshot.launcher).toMatchObject({
				error: expect.any(String),
			}),
		);
		h.client.doclingStatus.mockRejectedValue(
			new Error("api_connection_failed"),
		);
		act(() => h.hook.result.current.refresh());
		await waitFor(() =>
			expect(h.hook.result.current.snapshot.launcher).toMatchObject({
				error: expect.stringContaining("接続情報"),
				busy: false,
			}),
		);
		h.client.doclingStatus.mockResolvedValue(status());
		await act(async () => {
			await h.cache.invalidateQueries();
		});
		h.hook.rerender({ ...h.context });
		await waitFor(() =>
			expect(h.hook.result.current.snapshot.launcher).toMatchObject({
				available: false,
				preparing: false,
				error: expect.any(String),
			}),
		);
		expect(h.client.doclingReady).toHaveBeenCalledOnce();
	} finally {
		h.hook.unmount();
		h.cache.clear();
	}
});

test.each(["unmount", "client"])(
	"%s change discards a pending explicit retry read",
	async (change) => {
		const h = fixture("failed");
		try {
			await waitFor(() =>
				expect(h.hook.result.current.snapshot.launcher).toMatchObject({
					error: expect.any(String),
				}),
			);
			const read = Promise.withResolvers<ReturnType<typeof status>>();
			h.client.doclingStatus
				.mockImplementationOnce(() => read.promise)
				.mockResolvedValue(status());
			h.client.doclingReady.mockResolvedValue(status());
			act(() => {
				h.hook.result.current.refresh();
				h.hook.result.current.refresh();
			});
			await waitFor(() =>
				expect(h.client.doclingStatus).toHaveBeenCalledTimes(2),
			);
			expect(h.client.doclingReady).toHaveBeenCalledOnce();
			if (change === "unmount") h.hook.unmount();
			else {
				h.hook.rerender({
					...h.context,
					client: { ...h.context.client, identity: "other" },
				});
				await waitFor(() =>
					expect(h.hook.result.current.snapshot.launcher).toMatchObject({
						available: true,
					}),
				);
			}
			await act(async () => {
				read.resolve(status());
			});
			expect(h.client.doclingReady).toHaveBeenCalledTimes(
				change === "unmount" ? 1 : 2,
			);
		} finally {
			h.hook.unmount();
			h.cache.clear();
		}
	},
);

test("a startup response arriving after its deadline cannot enable open", async () => {
	const deadline = new AbortController();
	vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
	const h = fixture("pending");
	try {
		await waitFor(() => expect(h.client.doclingReady).toHaveBeenCalledOnce());
		await act(async () => {
			deadline.abort(new DOMException("fixture deadline", "TimeoutError"));
			h.finishReady();
		});
		await waitFor(() =>
			expect(h.hook.result.current.snapshot.launcher).toMatchObject({
				available: false,
				preparing: false,
				error: expect.any(String),
			}),
		);
	} finally {
		h.hook.unmount();
		h.cache.clear();
	}
});
