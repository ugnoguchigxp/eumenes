import { cleanup, renderHook } from "@testing-library/react";
import { requestPlayback } from "@eumenes/design-system";
import { afterEach, expect, test, vi } from "vitest";
import {
	musicPlaylistScreen,
	useLivePlaylistScreen,
	type PlaylistScreen,
} from "./playlist-screen";

vi.mock("@eumenes/design-system", () => ({
	requestPlayback: vi.fn(async () => {}),
}));

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.mocked(requestPlayback).mockClear();
});

const mount = (screen: PlaylistScreen) =>
	renderHook((props: PlaylistScreen) => useLivePlaylistScreen(props), {
		initialProps: screen,
	});

test("viewing is the playlist the screen shows, nothing once it is closed", () => {
	expect(musicPlaylistScreen.viewing?.()).toBeNull();
	const view = mount({ playlistId: "p1", playableTrackId: undefined });
	expect(musicPlaylistScreen.viewing?.()).toBe("eumenes://music.playlist/p1");
	view.rerender({ playlistId: "p2", playableTrackId: undefined });
	expect(musicPlaylistScreen.viewing?.()).toBe("eumenes://music.playlist/p2");
	view.unmount();
	expect(musicPlaylistScreen.viewing?.()).toBeNull();
});

test("focus is true only for the playlist the screen shows", async () => {
	mount({ playlistId: "p1", playableTrackId: "t1" });
	await expect(musicPlaylistScreen.focus?.("p1")).resolves.toBe(true);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const other = musicPlaylistScreen.focus?.("p9");
	await vi.advanceTimersByTimeAsync(5_500);
	await expect(other).resolves.toBe(false);
});

test("play waits for the playlist's current track to be loaded, then starts that track", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const view = mount({ playlistId: "p1", playableTrackId: undefined });
	const played = musicPlaylistScreen.play?.("p1");
	await vi.advanceTimersByTimeAsync(200);
	expect(requestPlayback).not.toHaveBeenCalled();
	view.rerender({ playlistId: "p1", playableTrackId: "t1" });
	await vi.advanceTimersByTimeAsync(200);
	await played;
	expect(requestPlayback).toHaveBeenCalledWith("t1");
});

test("play rejects when the playlist never becomes playable", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	mount({ playlistId: "p1", playableTrackId: undefined });
	const played = musicPlaylistScreen.play?.("p1");
	const outcome = expect(played).rejects.toThrow("playlist_unavailable");
	await vi.advanceTimersByTimeAsync(5_500);
	await outcome;
});
