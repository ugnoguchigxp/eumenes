import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";
import { ocrSource } from "./source";
import { OCR_ADAPTER_REF, ocrWebAdapter } from "./toolchain-adapter";

afterEach(cleanup);

test("the adapter is loading until records and connection are read, then serves the OCR snapshot", async () => {
	const client = {
		identity: crypto.randomUUID(),
		ocrRecords: vi.fn(async () => []),
		ocrConnection: vi.fn(async () => ({
			revision: 1,
			serviceId: "ocr-host",
			baseUrl: null,
			credentialConfigured: false,
		})),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const context = { client } as unknown as AdapterHostContext;
	const hook = renderHook(() => ocrWebAdapter.useArtifact(context), {
		wrapper: ({ children }: PropsWithChildren) => (
			<QueryClientProvider client={cache}>{children}</QueryClientProvider>
		),
	});
	expect(ocrWebAdapter.adapterRef).toBe(OCR_ADAPTER_REF);
	expect(hook.result.current.phase.kind).toBe("loading");
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	expect(hook.result.current.snapshot[ocrSource]).toMatchObject({
		kind: "ocr-workspace",
		configured: false,
	});
	expect(hook.result.current.targetOf("ocr")).toBeUndefined();
	expect(hook.result.current.uploadFile).toBeTypeOf("function");
	// Local events go to the OCR runtime: an unknown source is refused there.
	expect(
		await hook.result.current.local(
			{} as never,
			{
				source: "other",
				action: "ocr-refresh",
				values: {},
			} as never,
		),
	).toMatchObject({ status: "rejected" });
	cache.clear();
});
