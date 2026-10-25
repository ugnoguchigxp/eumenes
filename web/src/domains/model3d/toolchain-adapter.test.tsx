import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";

const api = vi.hoisted(() => ({
	assets: vi.fn(async () => ({ assets: [], total: 0, nextCursor: null })),
	asset: vi.fn(),
}));
vi.mock("./api", () => ({ model3dApiFor: () => api }));

import { MODEL3D_ADAPTER_REF, model3dWebAdapter } from "./toolchain-adapter";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	document.body.innerHTML = "";
	api.asset.mockReset();
});

const sourceData = {
	revision: 1,
	data: { generations: [], focus: null, available: true, reason: null },
};
const asset = {
	id: "m1",
	title: "椅子",
	tags: [],
	createdAt: "2026-10-25T00:00:00.000Z",
	prompt: null,
	warnings: [],
	hasSource: false,
};

/** The detail view the workspace draws for the selected model. */
function drawDetail() {
	const root = document.createElement("section");
	root.className = "model3d-workspace";
	const detail = document.createElement("section");
	detail.className = "model3d-focus";
	detail.scrollIntoView = vi.fn();
	root.append(detail);
	document.body.append(root);
	return detail;
}

function setup(read: () => Promise<unknown>) {
	const client = {
		identity: crypto.randomUUID(),
		toolchainArtifactSource: vi.fn(read),
		imageLibrary: vi.fn(async () => ({ images: [] })),
		imageContent: vi.fn(),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const context = {
		client,
		artifactRevisionId: "rev1",
		visible: true,
	} as unknown as AdapterHostContext;
	const hook = renderHook(() => model3dWebAdapter.useArtifact(context), {
		wrapper: ({ children }: PropsWithChildren) => (
			<QueryClientProvider client={cache}>{children}</QueryClientProvider>
		),
	});
	return { client, hook, cache };
}

test("loads the backend source, then serves the model3d snapshot with local events", async () => {
	const { hook, cache } = setup(async () => ({
		revision: 1,
		data: {
			generations: [],
			focus: null,
			available: false,
			reason: "LARM未設定",
		},
	}));
	expect(model3dWebAdapter.adapterRef).toBe(MODEL3D_ADAPTER_REF);
	expect(MODEL3D_ADAPTER_REF).toBe("adapter:model3d@1");
	expect(hook.result.current.phase.kind).toBe("loading");
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	expect(hook.result.current.snapshot.model3d).toMatchObject({
		kind: "model3d",
		available: false,
		unavailableReason: "LARM未設定",
	});
	expect(hook.result.current.targetOf("model3d")).toBeUndefined();
	expect(
		await hook.result.current.local({} as never, {
			id: "e",
			source: "other",
			revision: 0,
			action: "model3d-refresh",
			values: {},
		}),
	).toMatchObject({ status: "rejected" });
	expect(
		await hook.result.current.local({} as never, {
			id: "e",
			source: "model3d",
			revision: 0,
			action: "model3d-refresh",
			values: {},
		}),
	).toMatchObject({ status: "accepted" });
	cache.clear();
});

test("reports an error phase when the source cannot be read", async () => {
	const { hook, cache } = setup(async () => {
		throw new Error("down");
	});
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("error"));
	cache.clear();
});

test("rejects a source answer that breaks the contract", async () => {
	const { hook, cache } = setup(async () => ({
		revision: 1,
		data: { generations: "x" },
	}));
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("error"));
	cache.clear();
});

test("focus selects the asset, marks its detail for two seconds and viewing names it", async () => {
	api.asset.mockResolvedValue(asset);
	const { hook, cache } = setup(async () => sourceData);
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	const detail = drawDetail();
	expect(model3dWebAdapter.viewing?.()).toBeNull();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const done = model3dWebAdapter.focus?.("m1");
	await vi.advanceTimersByTimeAsync(200);
	await expect(done).resolves.toBe(true);
	expect(api.asset).toHaveBeenCalledWith("m1", expect.anything());
	expect(detail.getAttribute("data-resource-focus")).toBe("true");
	expect(hook.result.current.snapshot.model3d).toMatchObject({
		selectedAsset: { id: "m1" },
		focus: { kind: "asset" },
	});
	expect(model3dWebAdapter.viewing?.()).toBe("eumenes://model3d.asset/m1");
	await vi.advanceTimersByTimeAsync(2_010);
	expect(detail.hasAttribute("data-resource-focus")).toBe(false);
	cache.clear();
});

test("focus says no to a missing asset and leaves nothing selected", async () => {
	api.asset.mockRejectedValue(new Error("not_found"));
	const { hook, cache } = setup(async () => sourceData);
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	await expect(model3dWebAdapter.focus?.("gone")).resolves.toBe(false);
	await waitFor(() =>
		expect(hook.result.current.snapshot.model3d).toMatchObject({
			selectedAsset: undefined,
		}),
	);
	expect(model3dWebAdapter.viewing?.()).toBeNull();
	cache.clear();
});

test("viewing is null while the screen is hidden behind another tab", async () => {
	api.asset.mockResolvedValue(asset);
	const client = {
		identity: crypto.randomUUID(),
		toolchainArtifactSource: vi.fn(async () => sourceData),
		imageLibrary: vi.fn(async () => ({ images: [] })),
		imageContent: vi.fn(),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const hook = renderHook(
		({ visible }) =>
			model3dWebAdapter.useArtifact({
				client,
				artifactRevisionId: "rev1",
				visible,
			} as unknown as AdapterHostContext),
		{
			initialProps: { visible: true },
			wrapper: ({ children }: PropsWithChildren) => (
				<QueryClientProvider client={cache}>{children}</QueryClientProvider>
			),
		},
	);
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	drawDetail();
	await model3dWebAdapter.focus?.("m1");
	expect(model3dWebAdapter.viewing?.()).toBe("eumenes://model3d.asset/m1");
	hook.rerender({ visible: false });
	expect(model3dWebAdapter.viewing?.()).toBeNull();
	cache.clear();
});
