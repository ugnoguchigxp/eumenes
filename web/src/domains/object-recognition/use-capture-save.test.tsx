import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import type { EumenesClient } from "../../../../client";
import type { RecognitionRecord } from "../../../../api/domains/object-recognition/contracts";
import { useCaptureSave } from "./use-capture-save";

test("checks the same saved receipt and resumes only a confirmed unadmitted upload", async () => {
	const id = crypto.randomUUID();
	const record = { id, captureSave: "unconfirmed" } as RecognitionRecord;
	const client = {
		identity: "capture-fixture",
		imageImport: vi.fn(async () => ({ status: "ready", retryAfterMs: 1000 })),
		resumeImageImport: vi.fn(async () => ({
			status: "succeeded",
			artifact: { id: "saved" },
		})),
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const hook = renderHook(() => useCaptureSave(client, record), {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={cache}>{children}</QueryClientProvider>
		),
	});
	try {
		await waitFor(() => expect(hook.result.current.canResume).toBe(true));
		expect(hook.result.current.status).toBe("unconfirmed");
		await act(async () => {
			expect((await hook.result.current.resume()).status).toBe("accepted");
		});
		await waitFor(() => expect(hook.result.current.status).toBe("saved"));
		expect(client.resumeImageImport).toHaveBeenCalledExactlyOnceWith(id);
		expect(hook.result.current.canResume).toBe(false);
	} finally {
		hook.unmount();
		cache.clear();
	}
});

test("offers a backend-controlled restart when the local receipt was never created", async () => {
	const { ApiError } = await import("../../../../client/transport");
	const id = crypto.randomUUID();
	const record = { id, captureSave: "unconfirmed" } as RecognitionRecord;
	const client = {
		identity: "capture-no-receipt",
		imageImport: vi.fn(async () => {
			throw new ApiError(404, "image_import_not_found");
		}),
		recognitionResumeCaptureSave: vi.fn(async () => ({})),
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const hook = renderHook(() => useCaptureSave(client, record), {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={cache}>{children}</QueryClientProvider>
		),
	});
	try {
		await waitFor(() => expect(hook.result.current.canResume).toBe(true));
		await act(async () => {
			expect((await hook.result.current.resume()).status).toBe("accepted");
		});
		expect(client.recognitionResumeCaptureSave).toHaveBeenCalledExactlyOnceWith(
			id,
		);
	} finally {
		hook.unmount();
		cache.clear();
	}
});

test("cached receipt controls are hidden while the capture job is queued", async () => {
	const id = crypto.randomUUID();
	const client = {
		identity: "capture-queued",
		imageImport: vi.fn(async () => ({ status: "ready", retryAfterMs: 1000 })),
	} as unknown as EumenesClient;
	const record = { id, captureSave: "unconfirmed" } as RecognitionRecord;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const hook = renderHook(({ selected }) => useCaptureSave(client, selected), {
		initialProps: { selected: record },
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={cache}>{children}</QueryClientProvider>
		),
	});
	try {
		await waitFor(() => expect(hook.result.current.canResume).toBe(true));
		hook.rerender({ selected: { ...record, captureSave: "queued" } });
		expect(hook.result.current.status).toBe("queued");
		expect(hook.result.current.canResume).toBe(false);
	} finally {
		hook.unmount();
		cache.clear();
	}
});
