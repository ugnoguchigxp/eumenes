import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";
import { uiCompositionsWebAdapter } from "./toolchain-adapter";

afterEach(cleanup);

const item = (id: string, state = "ready", generation = 4) => ({
	id,
	title: `作品${id}`,
	state,
	updatedAt: 1,
	generation,
});
function setup(options: {
	items?: ReturnType<typeof item>[];
	targetRef?: string;
	form?: { revision: number; data: unknown };
	images?: { id: string; createdAt: string }[];
	visible?: boolean;
	failList?: boolean;
}) {
	const items = options.items ?? [item("a"), item("b")];
	const client = {
		identity: crypto.randomUUID(),
		toolchainArtifactSource: vi.fn(async (_revision: string, source: string) =>
			options.failList
				? Promise.reject(new Error("offline"))
				: source === "ui-workshop"
					? { revision: 9, data: { kind: "ui-workspace", items } }
					: (options.form ?? { revision: 4, data: { kind: "form" } }),
		),
		imageLibrary: vi.fn(async () => ({ images: options.images ?? [] })),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const setTargetRef = vi.fn();
	const context = {
		client,
		artifactRevisionId: "artifact:ui@1",
		targetRef: options.targetRef,
		setTargetRef,
		visible: options.visible ?? true,
		artifact: { sourceBindings: [] },
	} as unknown as AdapterHostContext;
	const hook = renderHook(() => uiCompositionsWebAdapter.useArtifact(context), {
		wrapper: ({ children }: PropsWithChildren) => (
			<QueryClientProvider client={cache}>{children}</QueryClientProvider>
		),
	});
	return { hook, client, cache, setTargetRef };
}
const event = (values: Record<string, unknown>) => ({ values }) as never;
const binding = (eventAction: string) => ({ eventAction }) as never;

test("the workshop lists saved items with image motifs from the library", async () => {
	const h = setup({
		images: [{ id: "i1", createdAt: "2026-10-01T00:00:00.000Z" }],
	});
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	await waitFor(() =>
		expect(
			(h.hook.result.current.snapshot["ui-workshop"] as { images: unknown[] })
				.images,
		).toHaveLength(1),
	);
	expect(h.hook.result.current.snapshot["ui-workshop"]).toMatchObject({
		kind: "ui-workspace",
		revision: 9,
		items: [{ id: "a" }, { id: "b" }],
		images: [{ id: "i1", title: "画像 2026-10-01" }],
	});
	h.cache.clear();
});

test("a hidden screen reads nothing and stays loading", () => {
	const h = setup({ visible: false });
	expect(h.client.toolchainArtifactSource).not.toHaveBeenCalled();
	expect(h.client.imageLibrary).not.toHaveBeenCalled();
	expect(h.hook.result.current.phase.kind).toBe("loading");
	h.cache.clear();
});

test("a failed list read shows an error", async () => {
	const h = setup({ failList: true });
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("error"));
	h.cache.clear();
});

test("selecting an item sets the target; an unknown id or a non-string id is refused", async () => {
	const h = setup({});
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	const { local } = h.hook.result.current;
	expect(await local(binding("ui-select"), event({ id: "b" }))).toMatchObject({
		status: "accepted",
	});
	expect(h.setTargetRef).toHaveBeenLastCalledWith("b");
	expect(await local(binding("ui-select"), event({ id: "" }))).toMatchObject({
		status: "accepted",
	});
	expect(h.setTargetRef).toHaveBeenLastCalledWith(undefined);
	h.setTargetRef.mockClear();
	expect(await local(binding("ui-select"), event({ id: "zzz" }))).toMatchObject(
		{ status: "rejected" },
	);
	expect(await local(binding("ui-select"), event({ id: 3 }))).toMatchObject({
		status: "rejected",
	});
	expect(h.setTargetRef).not.toHaveBeenCalled();
	expect(await local(binding("ui-other"), event({}))).toMatchObject({
		status: "rejected",
	});
	h.cache.clear();
});

test("refresh reloads the list and the form of the open item", async () => {
	const h = setup({ targetRef: "a" });
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	const before = h.client.toolchainArtifactSource.mock.calls.length;
	await act(async () => {
		expect(
			await h.hook.result.current.local(binding("ui-refresh"), event({})),
		).toMatchObject({ status: "accepted" });
	});
	await waitFor(() =>
		expect(h.client.toolchainArtifactSource.mock.calls.length).toBeGreaterThan(
			before,
		),
	);
	h.cache.clear();
});

test("the form of the open item joins the snapshot only when its generation matches", async () => {
	const ready = setup({ targetRef: "a" });
	await waitFor(() =>
		expect(
			ready.hook.result.current.snapshot["composition-form"],
		).toMatchObject({ kind: "form", revision: 4 }),
	);
	expect(ready.hook.result.current.targetOf("composition-form")).toBe("a");
	expect(ready.hook.result.current.targetOf("ui-workshop")).toBeUndefined();
	ready.cache.clear();

	const stale = setup({
		targetRef: "a",
		form: { revision: 3, data: { kind: "form" } },
	});
	await waitFor(() =>
		expect(stale.client.toolchainArtifactSource).toHaveBeenCalledWith(
			"artifact:ui@1",
			"composition-form",
			"a",
			expect.any(AbortSignal),
		),
	);
	expect(
		stale.hook.result.current.snapshot["composition-form"],
	).toBeUndefined();
	stale.cache.clear();

	const generating = setup({
		targetRef: "a",
		items: [item("a", "generating")],
	});
	await waitFor(() =>
		expect(generating.hook.result.current.phase.kind).toBe("ready"),
	);
	expect(generating.client.toolchainArtifactSource).not.toHaveBeenCalledWith(
		"artifact:ui@1",
		"composition-form",
		expect.anything(),
		expect.anything(),
	);
	generating.cache.clear();
});

test("a generated item becomes the open one when its action settles", async () => {
	const h = setup({});
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	await act(async () => {
		await h.hook.result.current.settled(
			binding("ui-generate"),
			{
				resultRefs: [
					{ owner: "image", id: "x" },
					{ owner: "ui-compositions", id: "new-1" },
				],
			} as never,
			{} as never,
			undefined,
		);
	});
	expect(h.setTargetRef).toHaveBeenCalledWith("new-1");
	h.setTargetRef.mockClear();
	await act(async () => {
		await h.hook.result.current.settled(
			binding("ui-delete"),
			{
				resultRefs: [],
			} as never,
			{} as never,
			undefined,
		);
	});
	expect(h.setTargetRef).not.toHaveBeenCalled();
	h.cache.clear();
});
