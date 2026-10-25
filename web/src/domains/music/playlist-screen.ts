import { requestPlayback } from "@eumenes/design-system";
import { useEffect, useRef } from "react";
import { formatResourceUri } from "../../../../api/domains/resources/contracts";
import {
	createLiveScreen,
	type WebArtifactAdapter,
} from "../toolchain-artifacts/registry";

/**
 * The playlist screen is a stored OpenUI tab, not a registered artifact; this is the ref the
 * music resource adapter (`MUSIC_PLAYLIST_ADAPTER_REF` in the API) names for it, so a resource
 * opens the playlist by its id.
 */
export const MUSIC_PLAYLIST_ADAPTER_REF = "adapter:music-library@1";

/** What the mounted playlist screen shows, read through the latest render. */
export type PlaylistScreen = {
	playlistId: string;
	/** The track the player is on, once its audio is loaded. */
	playableTrackId: string | undefined;
};
const live = createLiveScreen<{ read(): PlaylistScreen }>();

/** The mounted playlist screen reports what it shows; the removal runs on unmount. */
export function useLivePlaylistScreen(screen: PlaylistScreen) {
	const latest = useRef(screen);
	useEffect(() => {
		latest.current = screen;
	});
	useEffect(() => live.attach({ read: () => latest.current }), []);
}

/** The screen's own part of the web adapter contract (`focus`, `play`, `viewing`). */
export const musicPlaylistScreen: Pick<
	WebArtifactAdapter,
	"focus" | "play" | "viewing"
> = {
	async focus(playlistId) {
		return !!(await live.waitFor(
			(handle) => handle.read().playlistId === playlistId,
		));
	},
	async play(playlistId) {
		const track = await live.waitFor(
			(handle) =>
				handle.read().playlistId === playlistId &&
				handle.read().playableTrackId,
		);
		if (!track) throw new Error("playlist_unavailable");
		await requestPlayback(track);
	},
	viewing() {
		const playlistId = live.current()?.read().playlistId;
		return playlistId ? formatResourceUri("music.playlist", playlistId) : null;
	},
};
