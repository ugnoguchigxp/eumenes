import { z } from "zod";
import {
	musicTrack,
	musicTracks,
	musicTags,
	trackId,
	trackQuery,
	trackQueryParams,
} from "../contracts/music-library";
import { json } from "./playground-http";
export class MusicLibraryError extends Error {
	constructor(
		public status: number,
		public code: string,
		public detail: string,
	) {
		super(code);
	}
}
export function createMusicLibrary(
	control: (
		path: string,
		signal: AbortSignal,
		init?: RequestInit,
		accepted?: number[],
	) => Promise<Response>,
	publicUrl: (path: string) => URL,
) {
	async function request(
		path: string,
		signal: AbortSignal,
		init: RequestInit = {},
		accepted = [200],
	) {
		const r = await control(path, signal, init, [
			...accepted,
			400,
			401,
			404,
			409,
			416,
			507,
			403,
			422,
			429,
			500,
			502,
			503,
			504,
		]);
		if (!accepted.includes(r.status)) {
			const data = await json(r).catch(() => ({}));
			const e = z
				.object({
					error: z
						.union([
							z.string(),
							z.object({ code: z.string(), message: z.string().optional() }),
						])
						.optional(),
					message: z.string().optional(),
				})
				.safeParse(data);
			const error = e.success ? e.data.error : undefined;
			const code = typeof error === "object" ? error.code : error;
			const message =
				typeof error === "object"
					? error.message
					: e.success
						? e.data.message
						: undefined;
			throw new MusicLibraryError(
				r.status,
				code && /^[a-zA-Z0-9_-]{1,100}$/.test(code)
					? code
					: `larm_http_${r.status}`,
				(message ?? "LARMの操作に失敗しました。").slice(0, 1000),
			);
		}
		return r;
	}
	function decode<T>(schema: z.ZodType<T>, value: unknown): T {
		const result = schema.safeParse(value);
		if (!result.success)
			throw new MusicLibraryError(
				502,
				"invalid_music_response",
				"LARMの楽曲応答が契約と一致しません。",
			);
		return result.data;
	}
	function validateTrack(value: unknown) {
		const t = decode(musicTrack, value);
		for (const [path, suffix] of [
			[t.audioUrl, "audio"],
			[t.metadataUrl, "metadata"],
		]) {
			const url = publicUrl(path!);
			if (url.pathname !== `/v1/music/tracks/${t.id}/${suffix}`)
				throw new Error("invalid_music_track_url");
		}
		return t;
	}
	const path = (id: string) =>
		`/v1/music/tracks/${encodeURIComponent(trackId.parse(id))}`;
	const detail = async (id: string, signal: AbortSignal) => {
		const t = validateTrack(await json(await request(path(id), signal)));
		if (t.id !== id)
			throw new MusicLibraryError(
				502,
				"invalid_music_response",
				"LARMの曲IDが一致しません。",
			);
		return t;
	};
	return {
		async tracks(query: unknown, signal: AbortSignal) {
			const data = decode(
				musicTracks,
				await json(
					await request(
						`/v1/music/tracks?${trackQueryParams(trackQuery.parse(query))}`,
						signal,
					),
				),
			);
			return { ...data, tracks: data.tracks.map(validateTrack) };
		},
		async tags(signal: AbortSignal) {
			return decode(
				musicTags,
				await json(await request("/v1/music/tags", signal)),
			);
		},
		detail,
		async favorite(id: string, favorite: boolean, signal: AbortSignal) {
			const r = await request(
				`/v1/music/generations/${encodeURIComponent(trackId.parse(id))}/favorite`,
				signal,
				{ method: favorite ? "PUT" : "DELETE" },
				[200, 204],
			);
			await r.body?.cancel();
		},
		async remove(id: string, signal: AbortSignal) {
			await request(path(id), signal, { method: "DELETE" }, [204]);
		},
		async audio(id: string, range: string | undefined, signal: AbortSignal) {
			const t = await detail(id, signal);
			const r = await request(
				publicUrl(t.audioUrl).href,
				signal,
				{ headers: range ? { Range: range } : {} },
				[200, 206, 416],
			);
			// Bun streams with chunked framing; forwarding Content-Length as well breaks Node proxies.
			const headers = new Headers({
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			});
			for (const key of ["Content-Type", "Content-Range", "Accept-Ranges"]) {
				const value = r.headers.get(key);
				if (value) headers.set(key, value);
			}
			return new Response(r.body, { status: r.status, headers });
		},
	};
}
