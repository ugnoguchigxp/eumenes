import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ArtifactEvent } from "@eumenes/artifact-ui/contracts";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../../../../client/transport";
import type {
	Model3dAsset,
	Model3dGenerateBody,
	Model3dGeneration,
	Model3dSourceData,
} from "./contracts";
import { model3dArtifactSource } from "./source";
import { useModel3dRuntime } from "./use-model3d-runtime";

beforeEach(() => {
	URL.createObjectURL = vi.fn(() => "blob:thumb");
	URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

const asset = (
	id: string,
	patch: Partial<Model3dAsset> = {},
): Model3dAsset => ({
	id,
	title: `モデル${id}`,
	tags: [],
	createdAt: "2026-10-18T00:00:00Z",
	prompt: null,
	warnings: [],
	hasSource: true,
	...patch,
});
const generation = (
	patch: Partial<Model3dGeneration> = {},
): Model3dGeneration => ({
	id: "g1",
	title: "熊",
	tags: [],
	source: { type: "prompt", prompt: "木彫りの熊" },
	state: "running",
	stage: "mesh",
	stageLabel: "3Dモデルを生成中",
	assetId: null,
	deleted: false,
	errorCode: null,
	errorLabel: null,
	warnings: [],
	origin: "screen",
	createdAt: 1,
	updatedAt: 1,
	revision: 1,
	...patch,
});

function setup(initial?: Partial<Model3dSourceData>) {
	const state = {
		source: {
			generations: [],
			focus: null,
			available: true,
			reason: null,
			...initial,
		} as Model3dSourceData,
	};
	const client = {
		identity: crypto.randomUUID(),
		toolchainArtifactSource: vi.fn(async () => ({
			revision: 1,
			data: state.source,
		})),
		imageLibrary: vi.fn(async () => ({
			images: [
				{
					id: "img1",
					width: 512,
					height: 512,
					createdAt: "2026-10-17T00:00:00Z",
				},
			],
		})),
		imageContent: vi.fn(async () => new Blob(["x"])),
	};
	const titles: Record<string, string> = {};
	const api = {
		assets: vi.fn(
			async (
				_query: unknown,
				cursor?: string,
				_signal?: AbortSignal,
			): Promise<{
				assets: Model3dAsset[];
				total: number;
				nextCursor: string | null;
			}> =>
				cursor
					? { assets: [asset("a3")], total: 3, nextCursor: null }
					: { assets: [asset("a1"), asset("a2")], total: 3, nextCursor: "c1" },
		),
		asset: vi.fn(async (id: string) =>
			asset(id, titles[id] ? { title: titles[id] } : {}),
		),
		createGeneration: vi.fn(async (body: Model3dGenerateBody) =>
			generation({ id: "new", title: body.title }),
		),
		cancelGeneration: vi.fn(async () => generation({ state: "cancelled" })),
		recheckGeneration: vi.fn(async () => generation({})),
		updateAsset: vi.fn(async (id: string, patch: { title?: string }) => {
			titles[id] = patch.title ?? "";
			return asset(id, { title: titles[id] });
		}),
		deleteAsset: vi.fn(async () => {}),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const hook = renderHook(
		() =>
			useModel3dRuntime({
				client: client as never,
				api: api as never,
				artifactRevisionId: "rev1",
			}),
		{
			wrapper: ({ children }: PropsWithChildren) => (
				<QueryClientProvider client={cache}>{children}</QueryClientProvider>
			),
		},
	);
	const resource = () => {
		const value = hook.result.current.runtime.snapshot[model3dArtifactSource];
		if (value?.kind !== "model3d") throw new Error("no resource");
		return value;
	};
	const dispatch = async (
		action: ArtifactEvent["action"],
		values: ArtifactEvent["values"] = {},
	) => {
		let receipt;
		await act(async () => {
			receipt = await hook.result.current.runtime.dispatch({
				id: crypto.randomUUID(),
				source: model3dArtifactSource,
				revision: resource().revision,
				action,
				values,
			});
		});
		return receipt as unknown as { status: string; message: string };
	};
	const ready = () =>
		waitFor(() => {
			expect(hook.result.current.loading).toBe(false);
			expect(resource().assets.length).toBeGreaterThan(0);
		});
	return { client, api, cache, hook, state, resource, dispatch, ready };
}

test("builds the resource from the backend source, the asset list and the image library", async () => {
	const s = setup({
		generations: [generation({})],
		available: false,
		reason: "LARMに接続できません。",
	});
	expect(s.hook.result.current.loading).toBe(true);
	await s.ready();
	expect(s.client.toolchainArtifactSource).toHaveBeenCalledWith(
		"rev1",
		"model3d",
		undefined,
		expect.anything(),
	);
	expect(s.resource()).toMatchObject({
		kind: "model3d",
		available: false,
		unavailableReason: "LARMに接続できません。",
		total: 3,
		hasMore: true,
		generations: [
			{ id: "g1", stageLabel: "3Dモデルを生成中", prompt: "木彫りの熊" },
		],
		assets: [
			{
				id: "a1",
				downloadUrl: "/api/model3d/assets/a1/content",
			},
			{ id: "a2" },
		],
		filter: { q: "", tags: [], sort: "createdAt", order: "desc" },
	});
	await waitFor(() =>
		expect(s.resource().sourceImages[0]).toMatchObject({
			id: "img1",
			thumbnailUrl: "/api/images/img1/content",
		}),
	);
	expect(s.client.imageContent).not.toHaveBeenCalled();
	expect(s.resource().assets.every((item) => !item.thumbnailUrl)).toBe(true);
});

test("more reads the next cursor and a new search discards it", async () => {
	const s = setup();
	await s.ready();
	expect(s.api.assets).toHaveBeenLastCalledWith(
		expect.objectContaining({ q: "" }),
		undefined,
		expect.anything(),
	);
	await s.dispatch("model3d-more");
	await waitFor(() => expect(s.resource().assets).toHaveLength(3));
	expect(s.api.assets).toHaveBeenLastCalledWith(
		expect.objectContaining({ q: "" }),
		"c1",
		expect.anything(),
	);
	expect(s.resource().hasMore).toBe(false);

	await s.dispatch("model3d-search", {
		query: "ロボット",
		tags: "試作、青",
		sort: "relevance",
		order: "asc",
	});
	await waitFor(() =>
		expect(s.api.assets).toHaveBeenLastCalledWith(
			{ q: "ロボット", tags: ["試作", "青"], sort: "relevance", order: "asc" },
			undefined,
			expect.anything(),
		),
	);
	await waitFor(() => expect(s.resource().hasMore).toBe(true));
	expect(s.resource().assets).toHaveLength(2);
	expect(s.resource().filter).toMatchObject({
		q: "ロボット",
		sort: "relevance",
	});
	await s.dispatch("model3d-more");
	expect(s.api.assets).toHaveBeenLastCalledWith(
		expect.objectContaining({ q: "ロボット" }),
		"c1",
		expect.anything(),
	);
});

test("an invalid search is rejected without a request", async () => {
	const s = setup();
	await s.ready();
	const calls = s.api.assets.mock.calls.length;
	expect(
		await s.dispatch("model3d-search", {
			query: "x",
			tags: "",
			sort: "random",
			order: "desc",
		}),
	).toMatchObject({ status: "rejected" });
	expect(s.api.assets.mock.calls.length).toBe(calls);
});

test("a focus request applies once per increasing sequence number", async () => {
	const s = setup({ focus: { seq: 1, kind: "asset", assetId: "a2" } });
	await waitFor(() => expect(s.resource().selectedAsset?.id).toBe("a2"));
	await s.dispatch("model3d-select", { id: "a1" });
	await waitFor(() => expect(s.resource().selectedAsset?.id).toBe("a1"));
	// The same sequence number arrives again with the next read: nothing is applied.
	await s.dispatch("model3d-refresh");
	await waitFor(() =>
		expect(s.client.toolchainArtifactSource).toHaveBeenCalledTimes(2),
	);
	expect(s.resource().selectedAsset?.id).toBe("a1");

	s.state.source = {
		...s.state.source,
		focus: { seq: 2, kind: "generation", generationId: "g9" },
	};
	await s.dispatch("model3d-refresh");
	await waitFor(() => expect(s.resource().highlightedGenerationId).toBe("g9"));
	expect(s.resource().selectedAsset?.id).toBe("a1");

	s.state.source = {
		...s.state.source,
		focus: { seq: 3, kind: "search", query: "熊", tags: ["動物"] },
	};
	await s.dispatch("model3d-refresh");
	await waitFor(() =>
		expect(s.api.assets).toHaveBeenLastCalledWith(
			{ q: "熊", tags: ["動物"], sort: "createdAt", order: "desc" },
			undefined,
			expect.anything(),
		),
	);
	// An older sequence number never moves the screen back.
	expect(s.resource().focus).toEqual({ seq: 3, kind: "search" });
	s.state.source = {
		...s.state.source,
		focus: { seq: 2, kind: "asset", assetId: "a2" },
	};
	await s.dispatch("model3d-refresh");
	await waitFor(() =>
		expect(s.client.toolchainArtifactSource).toHaveBeenCalledTimes(5),
	);
	expect(s.resource().selectedAsset?.id).toBe("a1");
	expect(s.resource().focus).toEqual({ seq: 3, kind: "search" });
});

test("generate sends the request body and a retry of the same submission keeps the request id", async () => {
	const s = setup();
	await s.ready();
	s.api.createGeneration.mockRejectedValueOnce(new TypeError("offline"));
	const values = {
		title: " 熊 ",
		tags: "動物、木彫り",
		prompt: "木彫りの熊",
		imageId: "",
	};
	expect(await s.dispatch("model3d-generate", values)).toMatchObject({
		status: "rejected",
	});
	expect(await s.dispatch("model3d-generate", values)).toMatchObject({
		status: "accepted",
	});
	const [first, second] = s.api.createGeneration.mock.calls.map((c) => c[0]);
	expect(first).toMatchObject({
		title: "熊",
		tags: ["動物", "木彫り"],
		source: { type: "prompt", prompt: "木彫りの熊" },
	});
	expect(first?.requestId).toMatch(/^[0-9a-f-]{36}$/);
	expect(second?.requestId).toBe(first?.requestId);
	expect(s.resource().highlightedGenerationId).toBe("new");
	// The next submission is a new one.
	await s.dispatch("model3d-generate", {
		title: "犬",
		tags: "",
		prompt: "",
		imageId: "img1",
	});
	const third = s.api.createGeneration.mock.calls[2]?.[0];
	expect(third).toMatchObject({
		title: "犬",
		tags: [],
		source: { type: "image-artifact", id: "img1" },
	});
	expect(third?.requestId).not.toBe(first?.requestId);
});

test("generate refuses bad input and an unavailable service without a request", async () => {
	const s = setup({ available: false, reason: "停止中" });
	await s.ready();
	expect(
		await s.dispatch("model3d-generate", {
			title: "a",
			tags: "",
			prompt: "p",
			imageId: "",
		}),
	).toMatchObject({ status: "rejected", message: "停止中" });
	expect(s.api.createGeneration).not.toHaveBeenCalled();

	const t = setup();
	await t.ready();
	for (const values of [
		{ title: "", tags: "", prompt: "p", imageId: "" },
		{ title: "a", tags: "", prompt: "", imageId: "" },
		{ title: "a", tags: "", prompt: "p", imageId: "i" },
	])
		expect(await t.dispatch("model3d-generate", values)).toMatchObject({
			status: "rejected",
		});
	expect(t.api.createGeneration).not.toHaveBeenCalled();
});

test("a body refused for good frees the request id", async () => {
	const s = setup();
	await s.ready();
	s.api.createGeneration.mockRejectedValueOnce(
		new ApiError(409, "request_conflict"),
	);
	const values = { title: "a", tags: "", prompt: "p", imageId: "" };
	expect(await s.dispatch("model3d-generate", values)).toMatchObject({
		status: "rejected",
	});
	await s.dispatch("model3d-generate", values);
	const [first, second] = s.api.createGeneration.mock.calls.map((c) => c[0]);
	expect(second?.requestId).not.toBe(first?.requestId);
});

test("cancel and recheck call the generation endpoints and refresh the source", async () => {
	const s = setup({ generations: [generation({})] });
	await s.ready();
	const reads = s.client.toolchainArtifactSource.mock.calls.length;
	expect(await s.dispatch("model3d-cancel", { id: "g1" })).toMatchObject({
		status: "accepted",
	});
	expect(await s.dispatch("model3d-recheck", { id: "g1" })).toMatchObject({
		status: "accepted",
	});
	expect(s.api.cancelGeneration).toHaveBeenCalledWith("g1");
	expect(s.api.recheckGeneration).toHaveBeenCalledWith("g1");
	await waitFor(() =>
		expect(s.client.toolchainArtifactSource.mock.calls.length).toBeGreaterThan(
			reads,
		),
	);
	expect(await s.dispatch("model3d-cancel", { id: "unknown" })).toMatchObject({
		status: "rejected",
	});
	expect(s.api.cancelGeneration).toHaveBeenCalledTimes(1);
});

test("update saves title and tags, delete removes the asset and clears the selection", async () => {
	const s = setup();
	await s.ready();
	await s.dispatch("model3d-select", { id: "a1" });
	await waitFor(() => expect(s.resource().selectedAsset?.id).toBe("a1"));
	expect(
		await s.dispatch("model3d-update", {
			id: "a1",
			title: "新名",
			tags: "x、y",
		}),
	).toMatchObject({ status: "accepted" });
	expect(s.api.updateAsset).toHaveBeenCalledWith("a1", {
		title: "新名",
		tags: ["x", "y"],
	});
	await waitFor(() => expect(s.resource().selectedAsset?.title).toBe("新名"));
	expect(
		await s.dispatch("model3d-update", { id: "a1", title: " ", tags: "" }),
	).toMatchObject({ status: "rejected" });

	const reads = s.api.assets.mock.calls.length;
	expect(await s.dispatch("model3d-delete", { id: "a1" })).toMatchObject({
		status: "accepted",
	});
	expect(s.api.deleteAsset).toHaveBeenCalledWith("a1");
	expect(s.resource().selectedAsset).toBeUndefined();
	await waitFor(() =>
		expect(s.api.assets.mock.calls.length).toBeGreaterThan(reads),
	);
});

test("a failed delete is reported and keeps the selection", async () => {
	const s = setup();
	await s.ready();
	await s.dispatch("model3d-select", { id: "a1" });
	await waitFor(() => expect(s.resource().selectedAsset?.id).toBe("a1"));
	s.api.deleteAsset.mockRejectedValueOnce(new ApiError(500, "failed"));
	expect(await s.dispatch("model3d-delete", { id: "a1" })).toMatchObject({
		status: "rejected",
	});
	expect(s.resource().selectedAsset?.id).toBe("a1");
});

test("the asset list is read again when a running generation completes", async () => {
	const s = setup({ generations: [generation({})] });
	await s.ready();
	const reads = s.api.assets.mock.calls.length;
	s.state.source = {
		...s.state.source,
		generations: [generation({ state: "completed", assetId: "a1" })],
	};
	await s.dispatch("model3d-refresh");
	await waitFor(() =>
		expect(s.api.assets.mock.calls.length).toBeGreaterThan(reads),
	);
});

test("events for another source are refused", async () => {
	const s = setup();
	await s.ready();
	let receipt;
	await act(async () => {
		receipt = await s.hook.result.current.runtime.dispatch({
			id: "e",
			source: "other",
			revision: 0,
			action: "model3d-refresh",
			values: {},
		});
	});
	expect(receipt).toMatchObject({ status: "rejected" });
});
