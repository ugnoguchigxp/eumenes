import {
	cleanup,
	render,
	screen,
	fireEvent,
	waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { MusicArtifact } from "./MusicArtifact";
import { playlistArtifactDefinition } from "../../../domains/music/artifact-definition";
import { trackQuery } from "../../../../../api/domains/music/contracts";
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
const track = (id: string) => ({
	id,
	title: `保存曲${id}`,
	prompt: "piano",
	tags: ["明るい", "ピアノ"],
	durationSeconds: 30,
	createdAt: "2026-10-11T00:00:00Z",
	favorite: false,
	format: "opus",
});
function setup(
	definition = playlistArtifactDefinition("one"),
	saved = true,
	generations: Record<
		string,
		{
			id: string;
			artwork?: {
				state: "generating" | "completed" | "failed";
				revision: number;
				errorCode: null;
			};
		}
	> = {},
) {
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	const query = trackQuery.parse({});
	const api = {
		musicPlaylists: vi.fn(async () =>
			saved
				? [
						{
							id: "one",
							kind: "playlist",
							state: "completed",
							title: "保存曲",
							query,
							currentId: "a",
							updatedAt: 1,
							createdAt: 1,
						},
					]
				: [],
		),
		musicTags: vi.fn(async () => ({
			tags: [
				{ tag: "明るい", count: 5 },
				{ tag: "ピアノ", count: 3 },
			],
		})),
		musicTracks: vi.fn(
			async (
				q: ReturnType<typeof trackQuery.parse>,
				_signal?: AbortSignal,
			) => ({
				tracks: [track(q.q || "a")],
				total: 2,
				nextCursor: q.cursor ? undefined : "次",
			}),
		),
		musicTrack: vi.fn(async (id: string) => track(id)),
		updateMusicPlaylist: vi.fn(async () => ({})),
		musicFavorite: vi.fn(async () => {}),
		deleteMusicTrack: vi.fn(async () => {}),
		musicTrackGeneration: vi.fn(async (id: string) => generations[id] ?? null),
		musicArtwork: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
		generateMusicArtwork: vi.fn(async (id: string) => {
			const g = Object.values(generations).find((v) => v.id === id)!;
			g.artwork = {
				state: "completed",
				revision: (g.artwork?.revision ?? 0) + 1,
				errorCode: null,
			};
			return g;
		}),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const view = render(
		<QueryClientProvider client={cache}>
			<MusicArtifact client={api as never} definition={definition} />
		</QueryClientProvider>,
	);
	return { ...view, api, cache };
}
test("shared JSON composes controls, playlist and same-origin authenticated streaming player", async () => {
	const r = setup();
	await screen.findByRole("button", { name: "再生" });
	fireEvent.click(screen.getByText("タグで絞り込む"));
	expect(r.container.querySelector("audio")?.getAttribute("src")).toBe(
		"/api/music/tracks/a/audio",
	);
	expect(screen.getByLabelText("明るい (5)")).toBeTruthy();
	fireEvent.click(screen.getByLabelText("明るい (5)"));
	fireEvent.click(screen.getByLabelText("ピアノ (3)"));
	fireEvent.change(screen.getByLabelText("検索"), { target: { value: "b" } });
	fireEvent.change(screen.getByLabelText("並び順"), {
		target: { value: "asc" },
	});
	fireEvent.click(screen.getByRole("button", { name: "検索する" }));
	await waitFor(() =>
		expect(r.api.musicTracks).toHaveBeenCalledWith(
			expect.objectContaining({
				q: "b",
				tags: ["明るい", "ピアノ"],
				order: "asc",
			}),
			expect.any(AbortSignal),
		),
	);
	await screen.findByRole("button", { name: /保存曲b.*0:30/ });
	fireEvent.click(screen.getByRole("button", { name: "次の曲を取得" }));
	await waitFor(() =>
		expect(r.api.musicTracks).toHaveBeenCalledWith(
			expect.objectContaining({
				q: "b",
				tags: ["明るい", "ピアノ"],
				order: "asc",
				cursor: "次",
			}),
			expect.any(AbortSignal),
		),
	);
});
test("the shared playlist screen can search the authorized library without saved selections", async () => {
	const r = setup(playlistArtifactDefinition(), false);
	await screen.findByRole("button", { name: "再生" });
	fireEvent.change(screen.getByLabelText("検索"), { target: { value: "b" } });
	fireEvent.click(screen.getByRole("button", { name: "検索する" }));
	await screen.findByRole("button", { name: /保存曲b.*0:30/ });
	expect(r.api.updateMusicPlaylist).not.toHaveBeenCalled();
});
test("saved playlists switch inside one shared screen and retain separate filters and selections", async () => {
	const r = setup(playlistArtifactDefinition());
	await screen.findByRole("button", { name: "再生" });
	const original = (await r.api.musicPlaylists())[0]!;
	r.cache.setQueryData(
		["music", "playlists", "main"],
		[
			{
				...original,
				id: "two",
				title: "2つ目",
				createdAt: 2,
				updatedAt: 2,
				query: trackQuery.parse({ q: "b" }),
				currentId: "b",
			},
			original,
		],
	);
	await waitFor(() =>
		expect((screen.getByLabelText("検索") as HTMLInputElement).value).toBe("b"),
	);
	await waitFor(() =>
		expect(r.container.querySelector("audio")?.getAttribute("src")).toBe(
			"/api/music/tracks/b/audio",
		),
	);
	fireEvent.change(screen.getByLabelText("保存したプレイリスト"), {
		target: { value: "one" },
	});
	await waitFor(() =>
		expect((screen.getByLabelText("検索") as HTMLInputElement).value).toBe(""),
	);
	await waitFor(() =>
		expect(r.container.querySelector("audio")?.getAttribute("src")).toBe(
			"/api/music/tracks/a/audio",
		),
	);
	expect(r.container.querySelectorAll(".music-workspace")).toHaveLength(1);
});
test("an unknown persisted playlist never loads the track library", async () => {
	const r = setup(playlistArtifactDefinition("missing"));
	await screen.findByRole("alert");
	expect(r.api.musicTracks).not.toHaveBeenCalled();
	expect(r.api.musicTrack).not.toHaveBeenCalled();
});
test("favorite and destructive delete have separate actions and refresh tags", async () => {
	const r = setup();
	await screen.findByRole("button", { name: "保存曲aをお気に入り登録" });
	fireEvent.click(
		screen.getByRole("button", { name: "保存曲aをお気に入り登録" }),
	);
	await waitFor(() =>
		expect(r.api.musicFavorite).toHaveBeenCalledWith("a", true),
	);
	await waitFor(() =>
		expect(r.api.musicTags.mock.calls.length).toBeGreaterThan(1),
	);
	fireEvent.click(screen.getByRole("button", { name: "詳細" }));
	await waitFor(() =>
		expect(
			screen
				.getByRole("button", { name: "保存曲aを削除" })
				.hasAttribute("disabled"),
		).toBe(false),
	);
	fireEvent.click(screen.getByRole("button", { name: "保存曲aを削除" }));
	expect(r.api.deleteMusicTrack).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "削除する" }));
	await waitFor(() => expect(r.api.deleteMusicTrack).toHaveBeenCalledWith("a"));
});
test("late responses cannot replace the newer search, and filter changes discard cursor", async () => {
	const r = setup();
	await screen.findByRole("button", { name: "再生" });
	let resolve!: (v: unknown) => void;
	r.api.musicTracks.mockImplementation((q) =>
		q.q === "old"
			? (new Promise((res) => {
					resolve = res as never;
				}) as never)
			: Promise.resolve({
					tracks: [track(q.q || "a")],
					total: 1,
					nextCursor: undefined,
				}),
	);
	fireEvent.change(screen.getByLabelText("検索"), { target: { value: "old" } });
	fireEvent.click(screen.getByRole("button", { name: "検索する" }));
	await waitFor(() => expect(resolve).toBeDefined());
	fireEvent.change(screen.getByLabelText("検索"), { target: { value: "new" } });
	fireEvent.click(screen.getByRole("button", { name: "検索する" }));
	await screen.findByText("保存曲new");
	resolve({ tracks: [track("old")], total: 1 });
	await new Promise((res) => setTimeout(res, 10));
	expect(screen.queryByText("保存曲old")).toBeNull();
	expect(r.api.musicTracks.mock.calls.at(-1)?.[0].cursor).toBeUndefined();
});
test("returning to an earlier filter starts from its first page rather than its cached cursor", async () => {
	const r = setup();
	await screen.findByRole("button", { name: "再生" });
	fireEvent.click(screen.getByRole("button", { name: "次の曲を取得" }));
	await waitFor(() =>
		expect(r.api.musicTracks.mock.calls.some((c) => c[0].cursor === "次")).toBe(
			true,
		),
	);
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "更新" }).hasAttribute("disabled"),
		).toBe(false),
	);
	fireEvent.change(screen.getByLabelText("検索"), { target: { value: "b" } });
	fireEvent.click(screen.getByRole("button", { name: "検索する" }));
	await screen.findByText("保存曲b");
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "更新" }).hasAttribute("disabled"),
		).toBe(false),
	);
	const previousCalls = r.api.musicTracks.mock.calls.length;
	fireEvent.change(screen.getByLabelText("検索"), { target: { value: "" } });
	fireEvent.click(screen.getByRole("button", { name: "検索する" }));
	await waitFor(() =>
		expect(r.api.musicTracks.mock.calls.length).toBeGreaterThan(previousCalls),
	);
	expect(r.api.musicTracks.mock.calls.at(-1)?.[0].cursor).toBeUndefined();
	expect(r.api.musicTracks.mock.calls.at(-1)?.[0].q).toBe("");
});
test("a track generated here shows and regenerates its stored artwork in the playlist", async () => {
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:artwork");
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	const r = setup(playlistArtifactDefinition("one"), true, {
		a: {
			id: "gen-a",
			artwork: { state: "completed", revision: 1, errorCode: null },
		},
	});
	fireEvent.click(await screen.findByRole("button", { name: "楽曲イメージ" }));
	expect(
		(
			await screen.findByRole("img", { name: "保存曲aの楽曲イメージ" })
		).getAttribute("src"),
	).toBe("blob:artwork");
	expect(r.api.musicTrackGeneration).toHaveBeenCalledWith(
		"a",
		expect.anything(),
	);
	expect(r.api.musicArtwork).toHaveBeenCalledWith("gen-a", expect.anything());
	fireEvent.click(screen.getByRole("button", { name: "作り直す" }));
	await waitFor(() =>
		expect(r.api.generateMusicArtwork).toHaveBeenCalledWith("gen-a"),
	);
	await waitFor(() => expect(r.api.musicArtwork).toHaveBeenCalledTimes(2));
});
test("a LARM-only track has no artwork action in the playlist", async () => {
	const r = setup();
	fireEvent.click(await screen.findByRole("button", { name: "楽曲イメージ" }));
	await waitFor(() =>
		expect(r.api.musicTrackGeneration).toHaveBeenCalledWith(
			"a",
			expect.anything(),
		),
	);
	expect(screen.getByText("この楽曲のイメージは未登録です。")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "イメージを作成" })).toBeNull();
	expect(r.api.musicArtwork).not.toHaveBeenCalled();
});
