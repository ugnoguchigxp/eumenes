import { musicPlaybackPlan, musicPlaybackPlanV2 } from "../../capabilities";
import type { Prepared } from "../../capabilities";
import { MusicLibraryError, type LarmPlayground } from "../../larm";
import { trackId as trackIdSchema } from "../../larm/contracts";
import { parseResourceUri } from "../../resources";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { playlistRecordOf, playlistRow } from "../repository/playlists";
import {
	MUSIC_PLAYLIST_RESOURCE_KIND,
	MUSIC_TRACK_RESOURCE_KIND,
} from "./resource-adapter";

/** The plan schema of the tool this task was prepared with: V2 carries the tracks a request was given. */
export const playbackSchemaOf = (prepared: Prepared) =>
	prepared.dependencies.some(
		(d) =>
			d.kind === "tool" &&
			(d.schemaKey as string | undefined) === "musicPlaybackPlanV2",
	)
		? musicPlaybackPlanV2
		: musicPlaybackPlan;

/** The resource URIs handed to this request (`kind: "resource"` references), in the stored form. */
function handedUris(request: unknown) {
	const refs = (request as { references?: unknown }).references ?? [];
	const uris = new Set<string>();
	if (Array.isArray(refs))
		for (const ref of refs as Array<{ kind?: string; ref?: string }>) {
			const parsed =
				ref.kind === "resource" && typeof ref.ref === "string"
					? parseResourceUri(ref.ref)
					: null;
			if (parsed) uris.add(parsed.uri);
		}
	return uris;
}

/**
 * The library track ids behind the URIs a V2 plan copied from the request: a track is itself, a playlist is its
 * tracks (`playlistTracks`, null when it is not a completed playlist). A URI the request did not carry, of another
 * kind, or whose track the library no longer has fails the playlist; nothing is searched in its place.
 */
async function resolveTracks(
	uris: string[],
	handed: Set<string>,
	library: Pick<LarmPlayground["library"], "detail">,
	playlistTracks: (id: string) => string[] | null,
	signal: AbortSignal,
) {
	const ids: string[] = [];
	for (const text of uris) {
		const parsed = parseResourceUri(text);
		if (!parsed || !handed.has(parsed.uri)) throw new Error("unknown_resource");
		if (parsed.kind === MUSIC_TRACK_RESOURCE_KIND) {
			if (!trackIdSchema.safeParse(parsed.id).success)
				throw new Error("music_track_unknown");
			ids.push(parsed.id);
		} else if (parsed.kind === MUSIC_PLAYLIST_RESOURCE_KIND) {
			const tracks = playlistTracks(parsed.id);
			if (!tracks) throw new Error("music_track_unknown");
			ids.push(...tracks);
		} else throw new Error("music_track_unknown");
	}
	const unique = [...new Set(ids)];
	for (const id of unique)
		try {
			await library.detail(id, signal);
		} catch (error) {
			if (error instanceof MusicLibraryError && error.status === 404)
				throw new Error("music_track_unknown");
			throw error;
		}
	return unique;
}

/** The tracks a V2 plan opens in place of a search, or null when it names none (the V1 library search). */
export async function openedTracks(
	plan: object,
	request: unknown,
	deps: { store: SqliteStore; gateway: () => LarmPlayground },
	signal: AbortSignal,
) {
	const uris = (plan as { trackUris?: string[] }).trackUris ?? [];
	if (!uris.length) return null;
	const playlistTracks = (id: string) =>
		deps.store.read((db) => {
			const row = playlistRow(db, id);
			const found = row ? playlistRecordOf(row) : null;
			return found?.state === "completed" ? found.trackIds : null;
		});
	return resolveTracks(
		uris,
		handedUris(request),
		deps.gateway().library,
		playlistTracks,
		signal,
	);
}
