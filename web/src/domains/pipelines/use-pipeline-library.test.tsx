import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../../client";
import { usePipelineLibrary } from "./use-pipeline-library";

afterEach(cleanup);
function setup() {
	const imageLibrary = vi.fn(async (_signal?: AbortSignal) => ({
		images: [{ id: "img /1" }],
	}));
	const musicTracks = vi.fn(async (query: any, _signal?: AbortSignal) => ({
		tracks: [
			{
				id: query.cursor ? "track-2" : "track-1",
				title: "保存した楽曲",
				durationSeconds: 60,
				audioUrl: "https://provider.invalid/private",
			},
		],
		nextCursor: query.cursor ? undefined : "next",
	}));
	const client = {
		identity: crypto.randomUUID(),
		imageLibrary,
		musicTracks,
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const hook = renderHook(
		({ visible }) => usePipelineLibrary(client, visible),
		{ wrapper, initialProps: { visible: true } },
	);
	return { hook, imageLibrary, musicTracks };
}

test("libraries load only on explicit open and expose authenticated same-origin refs", async () => {
	const h = setup();
	expect(h.imageLibrary).not.toHaveBeenCalled();
	expect(h.musicTracks).not.toHaveBeenCalled();
	act(() => h.hook.result.current.open("image"));
	await waitFor(() =>
		expect(h.hook.result.current.resource.images).toHaveLength(1),
	);
	expect(h.hook.result.current.resource.images[0]?.thumbnailUrl).toBe(
		"/api/images/img%20%2F1/content",
	);
	expect(h.imageLibrary.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
	act(() => h.hook.result.current.open("music", "静かな"));
	await waitFor(() =>
		expect(h.hook.result.current.resource.tracks).toHaveLength(1),
	);
	expect(h.musicTracks.mock.calls[0]?.[0]).toMatchObject({
		q: "静かな",
		limit: 24,
	});
	expect(h.hook.result.current.resource.tracks[0]?.audioUrl).toBe(
		"/api/music/tracks/track-1/audio",
	);
	act(() => h.hook.result.current.open("music", "静かな", true));
	await waitFor(() =>
		expect(h.hook.result.current.resource.tracks).toHaveLength(2),
	);
	act(() => h.hook.result.current.open(null));
	expect(h.hook.result.current.resource.tracks).toEqual([]);
	expect(h.hook.result.current.resource.images).toEqual([]);
});

test("library errors allow explicit retry and clearing closes the picker", async () => {
	const h = setup();
	h.imageLibrary.mockRejectedValueOnce(new Error("private diagnostic"));
	act(() => h.hook.result.current.open("image"));
	await waitFor(() =>
		expect(h.hook.result.current.resource.error).toContain(
			"一覧を取得できません",
		),
	);
	expect(h.hook.result.current.resource.error).not.toContain("private");
	act(() => h.hook.result.current.open("image"));
	await waitFor(() =>
		expect(h.hook.result.current.resource.images).toHaveLength(1),
	);
	expect(h.hook.result.current.resource.error).toBeUndefined();
});

test("hidden artifacts clear preview data and do not issue stale pagination requests", async () => {
	const h = setup();
	act(() => h.hook.result.current.open("music", "作業用"));
	await waitFor(() =>
		expect(h.hook.result.current.resource.tracks).toHaveLength(1),
	);
	h.hook.rerender({ visible: false });
	expect(h.hook.result.current.resource.kind).toBeNull();
	expect(h.hook.result.current.resource.tracks).toEqual([]);
	const before = h.musicTracks.mock.calls.length;
	act(() => h.hook.result.current.open("music", "作業用", true));
	act(() => h.hook.result.current.open("music", "作業用"));
	act(() => h.hook.result.current.open("image"));
	expect(h.musicTracks.mock.calls.length).toBe(before);
	expect(h.imageLibrary).not.toHaveBeenCalled();
	h.hook.rerender({ visible: true });
	await waitFor(() =>
		expect(h.hook.result.current.resource.tracks).toHaveLength(1),
	);
	act(() => h.hook.result.current.open(null));
	const closed = h.musicTracks.mock.calls.length;
	act(() => h.hook.result.current.open("music", "作業用", true));
	expect(h.musicTracks.mock.calls.length).toBe(closed);
});
