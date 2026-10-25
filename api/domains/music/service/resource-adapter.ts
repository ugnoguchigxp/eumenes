import type { Database } from "bun:sqlite";
import { z } from "zod";
import { headWithin } from "../../../infrastructure/context-budget";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { MusicLibraryError, type LarmPlayground } from "../../larm";
import {
	formatResourceUri,
	RESOURCE_LABEL_MAX,
	type ResourceAdapter,
	type ResourceRef,
	type ResourceSearch,
	type ResourceView,
} from "../../resources";
import type { MusicRecord, PlaylistRecord } from "../contracts";
import { byTrack, record } from "../repository";
import {
	completedPlaylists,
	playlistRecordOf,
	playlistRow,
} from "../repository/playlists";

export const MUSIC_TRACK_RESOURCE_KIND = "music.track";
export const MUSIC_PLAYLIST_RESOURCE_KIND = "music.playlist";
export const MUSIC_SCREEN_ADAPTER_REF = "adapter:music-screen@1";
/** The screen that opens a playlist by its id (the playlist library). */
export const MUSIC_PLAYLIST_ADAPTER_REF = "adapter:music-library@1";
const READ_TOKEN_LIMIT = 600;
const PLAYLIST_TITLES_MAX = 30;
const LIBRARY_PAGE_MAX = 100;

const iso = (ms: number) => new Date(ms).toISOString();
const labelOf = (text: string, fallback: string) =>
	text.trim().slice(0, RESOURCE_LABEL_MAX).trim() || fallback;
const oneLine = (text: string, max: number) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max)}…` : line;
};

function within(search: ResourceSearch, at: string) {
	const time = Date.parse(at);
	return (
		(!search.since || time >= Date.parse(search.since)) &&
		(!search.until || time <= Date.parse(search.until))
	);
}

/** What `music.create` and `music.playback` report: a generation record or a playlist record. */
const musicResult = z.looseObject({
	state: z.string(),
	id: z.string().nullish(),
	jobId: z.string().nullish(),
	kind: z.string().nullish(),
});

/** A completed local generation that produced the library track `id`. */
function localTrack(db: Database, id: string): MusicRecord | null {
	const row = byTrack(db, id);
	if (!row) return null;
	const found = record(row);
	return found.state === "completed" ? found : null;
}

function trackRef(found: MusicRecord): ResourceRef {
	return {
		uri: formatResourceUri(MUSIC_TRACK_RESOURCE_KIND, found.jobId!),
		kind: MUSIC_TRACK_RESOURCE_KIND,
		label: labelOf(found.title, "楽曲"),
		createdAt: iso(found.createdAt),
	};
}

function playlistRef(found: PlaylistRecord): ResourceRef {
	return {
		uri: formatResourceUri(MUSIC_PLAYLIST_RESOURCE_KIND, found.id),
		kind: MUSIC_PLAYLIST_RESOURCE_KIND,
		label: labelOf(found.title, "プレイリスト"),
		createdAt: iso(found.createdAt),
	};
}

function completedPlaylist(db: Database, id: string): PlaylistRecord | null {
	const row = playlistRow(db, id);
	const found = row ? playlistRecordOf(row) : null;
	return found?.state === "completed" ? found : null;
}

/**
 * The `music.track` and `music.playlist` kinds. A track is the LARM library's track id (the job id of the
 * generation that made it); a track not generated here lives only in the library, so it is found by `search`
 * and read through the library, but cannot be resolved inside a transaction.
 */
export function createMusicResourceAdapters(deps: {
	store: SqliteStore;
	gateway: () => LarmPlayground;
}): [ResourceAdapter, ResourceAdapter] {
	const track: ResourceAdapter = {
		kind: MUSIC_TRACK_RESOURCE_KIND,
		fromResultInTransaction(db, result) {
			const parsed = musicResult.safeParse(result);
			if (
				!parsed.success ||
				parsed.data.kind === "playlist" ||
				parsed.data.state !== "completed" ||
				!parsed.data.jobId
			)
				return [];
			const found = localTrack(db, parsed.data.jobId);
			return found ? [trackRef(found)] : [];
		},
		getInTransaction(db, id): ResourceView | null {
			const found = localTrack(db, id);
			if (!found) return null;
			return {
				...trackRef(found),
				adapterRef: MUSIC_SCREEN_ADAPTER_REF,
				targetRef: found.id,
				actions: ["play", "open", "read"],
				preview: oneLine(found.description || found.prompt || "", 80),
			};
		},
		async search(query, signal) {
			const bounded = !!(query.since || query.until);
			const data = await deps.gateway().library.tracks(
				{
					q: query.text.trim().slice(0, 512),
					sort: "createdAt",
					order: "desc",
					limit: bounded
						? LIBRARY_PAGE_MAX
						: Math.min(LIBRARY_PAGE_MAX, Math.max(query.limit, 1)),
				},
				signal,
			);
			// Only tracks this host made resolve (open, play, read); one held only by the library is not offered.
			const known = new Set(
				deps.store.read((db) =>
					data.tracks.flatMap((t) => (localTrack(db, t.id) ? [t.id] : [])),
				),
			);
			return data.tracks
				.filter((t) => known.has(t.id) && within(query, t.createdAt))
				.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
				.slice(0, query.limit)
				.map((t) => ({
					uri: formatResourceUri(MUSIC_TRACK_RESOURCE_KIND, t.id),
					kind: MUSIC_TRACK_RESOURCE_KIND,
					label: labelOf(t.title, "楽曲"),
					createdAt: new Date(t.createdAt).toISOString(),
				}));
		},
		async read(id, signal) {
			const local = deps.store.read((db) => localTrack(db, id));
			let detail;
			try {
				detail = await deps.gateway().library.detail(id, signal);
			} catch (error) {
				if (error instanceof MusicLibraryError && error.status === 404)
					throw new Error("item_not_found");
				throw error;
			}
			const lines = [
				`曲: ${detail.title}`,
				local?.description && `説明: ${local.description}`,
				detail.prompt && `生成の依頼: ${detail.prompt}`,
				local?.lyrics && `歌詞: ${oneLine(local.lyrics, 300)}`,
				detail.tags.length && `タグ: ${detail.tags.join("、")}`,
				`長さ: ${Math.round(detail.durationSeconds)}秒${detail.instrumental ? "（歌なし）" : ""}`,
			];
			return {
				text: headWithin(lines.filter(Boolean).join("\n"), READ_TOKEN_LIMIT)
					.text,
			};
		},
	};

	const playlist: ResourceAdapter = {
		kind: MUSIC_PLAYLIST_RESOURCE_KIND,
		fromResultInTransaction(db, result) {
			const parsed = musicResult.safeParse(result);
			if (
				!parsed.success ||
				parsed.data.kind !== "playlist" ||
				parsed.data.state !== "completed" ||
				!parsed.data.id
			)
				return [];
			const found = completedPlaylist(db, parsed.data.id);
			return found && found.trackIds.length > 0 ? [playlistRef(found)] : [];
		},
		getInTransaction(db, id): ResourceView | null {
			const found = completedPlaylist(db, id);
			if (!found) return null;
			return {
				...playlistRef(found),
				adapterRef: MUSIC_PLAYLIST_ADAPTER_REF,
				targetRef: found.id,
				actions: ["play", "open"],
				preview: `${found.trackIds.length}曲`,
			};
		},
		async search(query) {
			const text = query.text.trim().toLowerCase();
			return deps.store.read((db) =>
				completedPlaylists(db)
					.filter(
						(p) =>
							(!text || p.title.toLowerCase().includes(text)) &&
							within(query, iso(p.createdAt)),
					)
					.sort((a, b) => b.createdAt - a.createdAt)
					.slice(0, query.limit)
					.map(playlistRef),
			);
		},
		async read(id, signal) {
			const found = deps.store.read((db) => completedPlaylist(db, id));
			if (!found) throw new Error("item_not_found");
			const shown = found.trackIds.slice(0, PLAYLIST_TITLES_MAX);
			const titles = await Promise.all(
				shown.map(async (trackId) => {
					const local = deps.store.read((db) => localTrack(db, trackId));
					if (local) return local.title;
					try {
						return (await deps.gateway().library.detail(trackId, signal)).title;
					} catch {
						return trackId;
					}
				}),
			);
			const more = found.trackIds.length - shown.length;
			const lines = [
				`プレイリスト: ${found.title}（${found.trackIds.length}曲）`,
				...titles.map((title, index) => `${index + 1}. ${title}`),
				more > 0 && `ほか${more}曲`,
			];
			return {
				text: headWithin(lines.filter(Boolean).join("\n"), READ_TOKEN_LIMIT)
					.text,
			};
		},
	};
	return [track, playlist];
}
