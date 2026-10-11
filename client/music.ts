import {
	trackQueryParams,
	musicTrack,
	musicTracks,
	musicTags,
	type TrackQuery,
} from "../api/domains/larm/contracts";
import type { z } from "zod";
import {
	musicRecord,
	playlistRecord,
	playlistUpdate,
} from "../api/domains/music/contracts";
import type { Transport } from "./transport";
export function musicClient(t: Transport) {
	const read = async (path: string, signal?: AbortSignal) =>
		(await t.call(path, { signal })).json();
	return {
		musicPlaylists: async (conversationId: string, signal?: AbortSignal) =>
			playlistRecord
				.array()
				.parse(
					await read(
						`/api/music/playlists?conversationId=${encodeURIComponent(conversationId)}`,
						signal,
					),
				),
		musicPlaylist: async (id: string, signal?: AbortSignal) =>
			playlistRecord.parse(
				await read(`/api/music/playlists/${encodeURIComponent(id)}`, signal),
			),
		updateMusicPlaylist: async (
			id: string,
			value: z.infer<typeof playlistUpdate>,
		) =>
			playlistRecord.parse(
				await (
					await t.call(`/api/music/playlists/${encodeURIComponent(id)}`, {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(value),
					})
				).json(),
			),
		musicTracks: async (query: TrackQuery, signal?: AbortSignal) =>
			musicTracks.parse(
				await read(`/api/music/tracks?${trackQueryParams(query)}`, signal),
			),
		musicTags: async (signal?: AbortSignal) =>
			musicTags.parse(await read("/api/music/tags", signal)),
		musicTrack: async (id: string, signal?: AbortSignal) =>
			musicTrack.parse(
				await read(`/api/music/tracks/${encodeURIComponent(id)}`, signal),
			),
		musicFavorite: async (id: string, favorite: boolean) => {
			await t.call(`/api/music/tracks/${encodeURIComponent(id)}/favorite`, {
				method: favorite ? "PUT" : "DELETE",
			});
		},
		deleteMusicTrack: async (id: string) => {
			await t.call(`/api/music/tracks/${encodeURIComponent(id)}`, {
				method: "DELETE",
			});
		},

		musicList: async (conversationId: string, signal?: AbortSignal) =>
			musicRecord
				.array()
				.parse(
					await (
						await t.call(
							`/api/music?conversationId=${encodeURIComponent(conversationId)}`,
							{ signal },
						)
					).json(),
				),
		music: async (id: string, signal?: AbortSignal) =>
			musicRecord.parse(
				await (
					await t.call(`/api/music/${encodeURIComponent(id)}`, { signal })
				).json(),
			),
		musicAudio: async (id: string, signal?: AbortSignal) =>
			(
				await t.call(`/api/music/${encodeURIComponent(id)}/audio`, { signal })
			).blob(),
	};
}
