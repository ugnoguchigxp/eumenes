import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";
import { ocrSource } from "./source";
import { OCR_ADAPTER_REF, ocrWebAdapter } from "./toolchain-adapter";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	document.body.innerHTML = "";
});

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

const record = (id: string) => ({
	id,
	name: `${id}.png`,
	mime: "image/png",
	state: "queued",
	revision: 1,
	createdAt: 1,
});

function mount(ids: string[]) {
	const client = {
		identity: crypto.randomUUID(),
		ocrRecords: vi.fn(async () => ids.map(record)),
		ocrContent: vi.fn(async () => new Blob(["x"], { type: "image/png" })),
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
	const hook = renderHook(
		() =>
			ocrWebAdapter.useArtifact({
				client,
				visible: true,
			} as unknown as AdapterHostContext),
		{
			wrapper: ({ children }: PropsWithChildren) => (
				<QueryClientProvider client={cache}>{children}</QueryClientProvider>
			),
		},
	);
	return { hook, cache };
}

test("focus selects the document, marks the shown part for two seconds and viewing names it", async () => {
	const { hook, cache } = mount(["i1", "i2"]);
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	const media = document.createElement("section");
	media.className = "ocr-media";
	media.scrollIntoView = vi.fn();
	document.body.append(media);
	expect(ocrWebAdapter.viewing?.()).toBe("eumenes://document/i1");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	let done: Promise<boolean> | undefined;
	await act(async () => {
		done = ocrWebAdapter.focus?.("i2");
		await vi.advanceTimersByTimeAsync(200);
	});
	// The selection renders after the first poll, which finds the mark on the next one.
	await act(async () => {
		await vi.advanceTimersByTimeAsync(200);
	});
	await expect(done).resolves.toBe(true);
	expect(hook.result.current.snapshot[ocrSource]).toMatchObject({
		selectedId: "i2",
	});
	expect(media.getAttribute("data-resource-focus")).toBe("true");
	expect(ocrWebAdapter.viewing?.()).toBe("eumenes://document/i2");
	await vi.advanceTimersByTimeAsync(2_010);
	expect(media.hasAttribute("data-resource-focus")).toBe(false);
	cache.clear();
});

test("focus says no to a document the screen lacks", async () => {
	const { hook, cache } = mount(["i1"]);
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const unknown = ocrWebAdapter.focus?.("missing");
	await vi.advanceTimersByTimeAsync(5_500);
	await expect(unknown).resolves.toBe(false);
	cache.clear();
});
