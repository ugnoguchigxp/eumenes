import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { useMusicArtifacts, usePlaylistArtifacts } from "./index";
afterEach(cleanup);
test.each(["songs", "playlists"])(
	"%s open the shared screen once for new records, without reopening saved or already-seen records",
	async (kind) => {
		const open = vi.fn();
		const initial = [{ id: "old", title: "以前の曲" }];
		const api = {
			musicList: vi.fn(async () => initial),
			musicPlaylists: vi.fn(async () => initial),
		};
		const cache = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const key = ["music", kind === "songs" ? "list" : "playlists", "main"];
		const view = renderHook(
			() =>
				kind === "songs"
					? useMusicArtifacts(api as never, "main", open)
					: usePlaylistArtifacts(api as never, "main", open),
			{
				wrapper: ({ children }: { children: ReactNode }) => (
					<QueryClientProvider client={cache}>{children}</QueryClientProvider>
				),
			},
		);
		await waitFor(() => expect(view.result.current).toHaveLength(1));
		expect(open).not.toHaveBeenCalled();
		act(() =>
			cache.setQueryData(key, [
				{ id: "new", title: "新しい曲" },
				{ id: "another", title: "別の曲" },
				...initial,
			]),
		);
		await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
		act(() =>
			cache.setQueryData(key, [
				{ id: "new", title: "更新した曲名" },
				...initial,
			]),
		);
		expect(open).toHaveBeenCalledTimes(1);
	},
);
