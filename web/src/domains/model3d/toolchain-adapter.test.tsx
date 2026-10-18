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

afterEach(cleanup);

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
